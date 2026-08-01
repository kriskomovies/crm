/**
 * Object storage for uploaded sheets (MinIO locally, S3/R2 unchanged in prod).
 *
 * Images are kept AFTER extraction, for a window, for two reasons that both
 * cost money if ignored: the CRM can show the sheet beside its extracted rows
 * so a human can spot errors, and re-running a corrected prompt over a stored
 * image is far cheaper than asking a client to re-upload.
 *
 * That justification has a shelf life, and until RetentionService existed it had
 * none. A sheet is ~1.2 MB and the design target is 20,000 a day: 24 GB a day,
 * 8.8 TB a year, on one VPS volume, of images nothing reads after the single
 * extraction call. `remove` is what makes the window a window -- see
 * retention.service.ts for what closes it.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Client as MinioClient } from 'minio';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Two drivers behind one interface. Setting STORAGE_DRIVER=local writes to disk
 * instead of MinIO, which lets the whole pipeline run on a machine with no
 * object store -- useful for development, and the difference is invisible to
 * every caller because the key format is identical.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger(StorageService.name);
  private readonly bucket = process.env.MINIO_BUCKET ?? 'sheets';
  private readonly local = (process.env.STORAGE_DRIVER ?? 'minio') === 'local';
  private readonly localRoot = resolve(process.env.STORAGE_LOCAL_DIR ?? '.storage');
  private readonly client = this.local
    ? null
    : new MinioClient({
        endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
        port: Number(process.env.MINIO_PORT ?? 9000),
        useSSL: (process.env.MINIO_USE_SSL ?? 'false') === 'true',
        accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
        secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
      });

  async onModuleInit(): Promise<void> {
    if (this.local) {
      await mkdir(this.localRoot, { recursive: true });
      this.log.log(`storage: local filesystem at ${this.localRoot}`);
      return;
    }
    try {
      if (!(await this.client!.bucketExists(this.bucket))) {
        await this.client!.makeBucket(this.bucket);
        this.log.log(`created bucket ${this.bucket}`);
      }
    } catch (err) {
      this.log.error(`storage unavailable: ${(err as Error).message}`);
    }
  }

  /** Key is content-addressed, so the same image uploaded twice stores once. */
  key(clientId: string, sha256: string, ext = 'png'): string {
    return `${clientId}/${sha256.slice(0, 2)}/${sha256}.${ext}`;
  }

  async put(key: string, body: Buffer, contentType = 'image/png'): Promise<void> {
    if (this.local) {
      const path = join(this.localRoot, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      return;
    }
    await this.client!.putObject(this.bucket, key, body, body.length, {
      'Content-Type': contentType,
    });
  }

  async get(key: string): Promise<Buffer> {
    if (this.local) return readFile(join(this.localRoot, key));
    const stream = await this.client!.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /** What the gateway wants: a base64 data URI inline in the request body. */
  async getDataUri(key: string): Promise<string> {
    const buf = await this.get(key);
    const mime = key.endsWith('.jpg') || key.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  /**
   * Delete one object. Idempotent on purpose: a key that is already gone is a
   * success, not an error.
   *
   * Retention runs repeatedly over overlapping windows and a crash mid-sweep
   * must be safe to retry, so "already deleted" has to be indistinguishable
   * from "deleted now". Both drivers are forgiving here -- `rm` with force,
   * and MinIO's removeObject, which does not fault on a missing key.
   */
  async remove(key: string): Promise<void> {
    if (this.local) {
      await rm(join(this.localRoot, key), { force: true });
      return;
    }
    await this.client!.removeObject(this.bucket, key);
  }

  /** Short-lived URL so the CRM can show the image without proxying it. */
  presign(key: string, seconds = 900): Promise<string> {
    if (this.local) return Promise.resolve(`file://${join(this.localRoot, key)}`);
    return this.client!.presignedGetObject(this.bucket, key, seconds);
  }
}

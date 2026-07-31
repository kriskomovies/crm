/**
 * Per-client API key auth for the machine-facing endpoints.
 *
 * Keys are stored only as SHA-256 hashes, so a database dump does not hand
 * anyone the ability to upload sheets or drain another client's target queue.
 * The lookup is by hash, which is why the column is unique and indexed.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex');
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-api-key'];
    if (!key) throw new UnauthorizedException('missing API key');

    const client = await this.prisma.client.findUnique({
      where: { apiKeyHash: hashApiKey(String(key)) },
    });
    if (!client) throw new UnauthorizedException('invalid API key');

    // Downstream handlers scope every query by this, so a client can never
    // reach another client's personalities, accounts or ledger.
    req.client = client;
    return true;
  }
}

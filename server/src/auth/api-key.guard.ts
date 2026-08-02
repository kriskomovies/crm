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

    const hash = hashApiKey(String(key));

    // Two sources, checked in this order. clients.apiKeyHash is the operator's
    // original single key -- the one Caddy injects for the CRM UI -- and still
    // works. api_keys holds one row per enrolled machine, so a box that is lost
    // or rebuilt can be revoked on its own instead of forcing a key change on
    // every other machine.
    let client = await this.prisma.client.findUnique({ where: { apiKeyHash: hash } });

    if (!client) {
      const issued = await this.prisma.apiKey.findUnique({
        where: { hash },
        include: { client: true },
      });
      // A revoked key is invalid, not merely stale: the whole point of revoking
      // is that the machine holding it stops working immediately.
      if (issued && !issued.revokedAt) {
        client = issued.client;
        // Best-effort last-seen. Never awaited into the request path: a machine
        // must not fail to claim targets because a bookkeeping write was slow.
        void this.prisma.apiKey
          .update({ where: { id: issued.id }, data: { lastSeenAt: new Date() } })
          .catch(() => undefined);
      }
    }

    if (!client) throw new UnauthorizedException('invalid API key');

    // Downstream handlers scope every query by this, so a client can never
    // reach another client's personalities, accounts or ledger.
    req.client = client;
    return true;
  }
}

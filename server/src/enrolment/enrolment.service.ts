/**
 * Setting a machine up by typing only an address.
 *
 * The alternative was copying a secret onto every emulator box by hand. That is
 * error-prone at three machines and unmanageable at twenty, and because only
 * the hash is stored the server cannot hand the key back out when it is lost --
 * so a mistyped key meant reprovisioning.
 *
 * Instead the operator opens a short window in the CRM and the machine asks for
 * its own credential. What makes this safe is that the window is a DEADLINE,
 * not a flag: leaving enrolment switched on would let anyone who finds the
 * domain mint a key, and a flag relies on someone remembering to switch it off.
 * This expires on its own.
 *
 * Each machine gets its own row, so losing a box means revoking one key instead
 * of rotating the one key every other box is using.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { hashApiKey } from '../auth/api-key.guard';
import { PrismaService } from '../prisma/prisma.service';

/** Long enough that guessing is hopeless; url-safe so it survives a TOML file. */
function newKey(): string {
  return `sk_${randomBytes(32).toString('base64url')}`;
}

/**
 * Same entropy as a key, different prefix. The prefix is the whole point: these
 * two secrets are pasted by the same person into different boxes, and `et_`
 * against `sk_` makes "I put the wrong one in" visible immediately rather than
 * as an authentication failure three steps later.
 */
function newToken(): string {
  return `et_${randomBytes(32).toString('base64url')}`;
}

export const DEFAULT_WINDOW_MINUTES = 10;

@Injectable()
export class EnrolmentService {
  private readonly log = new Logger(EnrolmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Operator action: allow new machines for the next `minutes`. */
  async open(clientId: string, minutes = DEFAULT_WINDOW_MINUTES) {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
      throw new BadRequestException('minutes must be between 1 and 120');
    }
    const until = new Date(Date.now() + minutes * 60_000);
    await this.prisma.client.update({
      where: { id: clientId },
      data: { enrolOpenUntil: until },
    });
    this.log.log(`enrolment open for client ${clientId} until ${until.toISOString()}`);
    return { open: true, until };
  }

  async close(clientId: string) {
    await this.prisma.client.update({
      where: { id: clientId },
      data: { enrolOpenUntil: null },
    });
    return { open: false, until: null };
  }

  async status(clientId: string) {
    const client = await this.prisma.client.findUniqueOrThrow({
      where: { id: clientId },
      select: { enrolOpenUntil: true },
    });
    const until = client.enrolOpenUntil;
    const open = !!until && until.getTime() > Date.now();
    const machines = await this.prisma.apiKey.findMany({
      where: { clientId },
      select: { id: true, name: true, createdAt: true, lastSeenAt: true, revokedAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return { open, until: open ? until : null, machines };
  }

  async revoke(clientId: string, keyId: string) {
    // Scoped by clientId as well as id: a key id must not be enough to disable
    // another tenant's machine.
    const { count } = await this.prisma.apiKey.updateMany({
      where: { id: keyId, clientId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!count) throw new BadRequestException('no such active key for this client');
    return { revoked: true };
  }

  /**
   * Mint or rotate this client's enrolment token. Returned ONCE; only the hash
   * is kept, so a lost token is replaced rather than looked up.
   *
   * Rotating does not disturb machines that have already enrolled: they hold
   * their own ApiKey rows and never present this again.
   */
  async mintToken(clientId: string) {
    const token = newToken();
    await this.prisma.client.update({
      where: { id: clientId },
      data: { enrolTokenHash: hashApiKey(token) },
    });
    this.log.log(`enrolment token minted for client ${clientId}`);
    return { token };
  }

  /**
   * The machine's side. UNAUTHENTICATED by design -- it is how a box with no
   * credential gets one -- so everything that limits it is here.
   *
   * Two ways in, and the token is the one to prefer. It names its own client, so
   * it works with any number of tenants enrolling at once and needs nothing left
   * open to the internet. The window is kept only because an agent built before
   * the token has no field to send one from.
   */
  async enrol(name: string, token?: string) {
    const machine = (name ?? '').trim().slice(0, 80) || 'unnamed machine';
    const presented = (token ?? '').trim();

    const client = presented
      ? await this.byToken(presented)
      : await this.byOpenWindow();

    const key = newKey();
    await this.prisma.apiKey.create({
      data: { clientId: client.id, name: machine, hash: hashApiKey(key) },
    });
    this.log.log(`enrolled "${machine}" into client ${client.id}`);

    // Hand back everything the machine needs to start working, so its config
    // file holds no identity at all: the server is the source of truth for
    // which accounts exist and which personality they belong to.
    const personalities = await this.prisma.personality.findMany({
      where: { clientId: client.id },
      select: {
        id: true,
        name: true,
        accounts: {
          where: { enabled: true },
          select: { id: true, label: true, dailyCap: true },
          orderBy: { label: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });

    return { apiKey: key, client: { id: client.id, name: client.name }, personalities };
  }

  /**
   * A token identifies its client outright, so there is no window to consult and
   * no ambiguity when several tenants are setting machines up at once.
   *
   * 401 rather than 400: a wrong token is a failed authentication, and the agent
   * has to be able to tell "you typed the token wrong" apart from "the server is
   * not accepting enrolments", which are different things for whoever is stood
   * at the machine.
   */
  private async byToken(token: string): Promise<{ id: string; name: string }> {
    const client = await this.prisma.client.findUnique({
      where: { enrolTokenHash: hashApiKey(token) },
      select: { id: true, name: true },
    });
    if (!client) throw new UnauthorizedException('invalid enrolment token');
    return client;
  }

  /** The pre-token path: no token presented, so fall back to an open window. */
  private async byOpenWindow(): Promise<{ id: string; name: string }> {
    const open = await this.prisma.client.findMany({
      where: { enrolOpenUntil: { gt: new Date() } },
      select: { id: true, name: true },
    });

    if (open.length === 0) {
      // Deliberately says what to do rather than just refusing: this is the
      // message an operator reads on a machine they are setting up.
      throw new BadRequestException(
        'enrolment is closed. Send an enrolment token, or open a window from the CRM, and press Connect again.',
      );
    }
    if (open.length > 1) {
      // Which tenant would this machine belong to? Guessing would silently
      // attach someone's box to the wrong ledger. A token does not have this
      // problem, which is the other reason to prefer it.
      throw new BadRequestException(
        `enrolment is open for ${open.length} clients at once, so it is ambiguous. Send an enrolment token, or close all but one window and retry.`,
      );
    }
    return open[0];
  }
}

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
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { hashApiKey } from '../auth/api-key.guard';
import { PrismaService } from '../prisma/prisma.service';

/** Long enough that guessing is hopeless; url-safe so it survives a TOML file. */
function newKey(): string {
  return `sk_${randomBytes(32).toString('base64url')}`;
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
   * The machine's side. UNAUTHENTICATED by design -- it is how a box with no
   * credential gets one -- so everything that limits it is here.
   */
  async enrol(name: string) {
    const machine = (name ?? '').trim().slice(0, 80) || 'unnamed machine';

    const open = await this.prisma.client.findMany({
      where: { enrolOpenUntil: { gt: new Date() } },
      select: { id: true, name: true },
    });

    if (open.length === 0) {
      // Deliberately says what to do rather than just refusing: this is the
      // message an operator reads on a machine they are setting up.
      throw new BadRequestException(
        'enrolment is closed. Open it from the CRM (Machines -> Allow new machines) and press Start again within the window.',
      );
    }
    if (open.length > 1) {
      // Which tenant would this machine belong to? Guessing would silently
      // attach someone's box to the wrong ledger.
      throw new BadRequestException(
        `enrolment is open for ${open.length} clients at once, so it is ambiguous. Close all but one and retry.`,
      );
    }

    const client = open[0];
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
}

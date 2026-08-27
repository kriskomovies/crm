/**
 * The operators' own inventory: proxies bought for the emulator fleet, and
 * Snapchat accounts waiting to be installed on one.
 *
 * STOCK, NOT WORKFLOW. Nothing here is ever served to a machine: no /v1
 * endpoint reads these tables, no claim or seed touches them, and the agents
 * are never told they exist. The software's accounts are the Account model;
 * these are credential pairs the operators hold, and moving one onto an
 * emulator is a human act the CRM only keeps the receipt for.
 *
 * THE ONE PIECE OF LOGIC is the proxy spread. Every stock account is put
 * behind a proxy at import, chosen at random among the proxies with the
 * fewest accounts, so however many are pasted and in whatever order, the
 * load ends even -- add ten accounts over three proxies and they land 4/3/3,
 * not wherever a modulo happened to point. Adding a NEW proxy later does not
 * reshuffle anybody: accounts already assigned stay put (their emulators are
 * already configured), and the new proxy simply absorbs new imports until it
 * has caught up, because it is the least loaded by definition.
 */
import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/** What one pasted proxy line means once read. */
export type ProxyLine = {
  protocol: string;
  host: string;
  port: number;
  username: string;
  password: string;
};

/** What one pasted account line means once read. */
export type AccountLine = { username: string; password: string };

export const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks5'] as const;

/** A hostname or IPv4 a proxy could actually sit at. Dots, dashes, letters,
 *  digits -- anything else on the line is a heading or a stray paste. */
const HOST = /^[a-z0-9][a-z0-9.-]*$/i;

/** Snapchat's own username shape, taken loose: it registers 3-15 of letters,
 *  digits, dot, dash, underscore, but sellers export with the odd long or
 *  short name and rejecting the row loses the password beside it. 2-32 keeps
 *  headings and URLs out without arguing with a seller's file. */
const ACCOUNT_USER = /^[a-z0-9._-]{2,32}$/i;

const portOf = (raw: string): number | null => {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : null;
};

/** Exactly `host:port` and nothing else. Used to decide whether an `@` on a
 *  line really separates credentials from an endpoint, or is just a character
 *  inside a colon-CSV password. */
const isHostPort = (s: string): boolean => {
  const p = s.split(':');
  return p.length === 2 && HOST.test(p[0]) && portOf(p[1]) !== null;
};

/**
 * One proxy per line, in the formats sellers actually export:
 *
 *   host:port
 *   host:port:user:pass          (the common seller CSV-with-colons)
 *   user:pass@host:port
 *   scheme://host:port
 *   scheme://user:pass@host:port
 *
 * -> what became of every line. Lines that read as nothing are reported back
 * rather than dropped, because a proxy that silently fails to import is a
 * proxy someone configures an emulator without.
 */
export function parseProxyLines(text: string): { valid: ProxyLine[]; invalid: string[] } {
  const valid: ProxyLine[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/[\r\n]+/)) {
    let line = raw.trim();
    if (!line) continue;

    const bad = () => {
      // Capped, like the onboarding import: a pasted HTML page must not answer
      // with a megabyte of its own markup one "invalid" at a time.
      if (invalid.length < 50) invalid.push(raw.trim().slice(0, 60));
    };

    let protocol = 'http';
    const scheme = line.match(/^([a-z][a-z0-9]*):\/\//i);
    if (scheme) {
      const p = scheme[1].toLowerCase();
      if (!(PROXY_PROTOCOLS as readonly string[]).includes(p)) {
        bad();
        continue;
      }
      protocol = p;
      line = line.slice(scheme[0].length);
    }

    let username = '';
    let password = '';
    // user:pass@host:port -- the LAST @ splits, because passwords hold @ more
    // often than hosts do. But an @ ONLY separates credentials when what
    // follows it really is a host:port: a colon-CSV line whose password holds
    // an @ (host:port:user:P@ss, one of the commonest password shapes) must
    // fall through to the colon branch, or its endpoint is eaten and the whole
    // proxy is silently dropped.
    const at = line.lastIndexOf('@');
    if (at >= 0 && isHostPort(line.slice(at + 1))) {
      const cred = line.slice(0, at);
      line = line.slice(at + 1);
      const colon = cred.indexOf(':');
      username = colon >= 0 ? cred.slice(0, colon) : cred;
      password = colon >= 0 ? cred.slice(colon + 1) : '';
      if (!username) {
        bad();
        continue;
      }
    }

    const parts = line.split(':');
    if (!username && parts.length >= 4) {
      // host:port:user:pass. Everything past the third colon is password --
      // passwords hold colons and @s, hosts and users here do not.
      username = parts[2];
      password = parts.slice(3).join(':');
      if (!username) {
        bad();
        continue;
      }
    } else if (parts.length !== 2) {
      bad();
      continue;
    }

    const host = parts[0].toLowerCase();
    const port = portOf(parts[1]);
    if (!HOST.test(host) || port === null) {
      bad();
      continue;
    }

    // Dedupe within the paste on the same key the DB enforces, so the counts
    // reported back match what the insert can actually add.
    const key = `${host}:${port}:${username}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ protocol, host, port, username, password });
  }

  return { valid, invalid };
}

/**
 * One account per line: `user:pass`, or `user pass` for the tab-separated
 * exports. Everything past the first separator is the password -- passwords
 * hold colons and this parser must not eat half of one.
 */
export function parseAccountLines(text: string): { valid: AccountLine[]; invalid: string[] } {
  const valid: AccountLine[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line) continue;

    const sep = line.match(/[:\s]/);
    const i = sep?.index ?? -1;
    const username = (i >= 0 ? line.slice(0, i) : line).replace(/^@/, '').toLowerCase();
    const password = i >= 0 ? line.slice(i + 1).trim() : '';

    if (!ACCOUNT_USER.test(username) || !password) {
      if (invalid.length < 50) invalid.push(raw.trim().slice(0, 60));
      continue;
    }
    if (seen.has(username)) continue;
    seen.add(username);
    valid.push({ username, password });
  }

  return { valid, invalid };
}

/**
 * Which proxy each of `n` new accounts gets: random among the least loaded,
 * counts updated as it deals, so one call spreads a whole paste evenly rather
 * than dropping all of it on whichever proxy was emptiest when it started.
 *
 * -> proxy ids, one per account, or [] when there are no proxies to give.
 * Pure, so the evenness is testable without a database.
 */
export function spreadEvenly(proxies: { id: string; count: number }[], n: number): string[] {
  if (proxies.length === 0 || n <= 0) return [];
  const load = new Map(proxies.map((p) => [p.id, p.count]));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const min = Math.min(...load.values());
    const ties = [...load].filter(([, c]) => c === min).map(([id]) => id);
    const id = ties[Math.floor(Math.random() * ties.length)];
    load.set(id, (load.get(id) ?? 0) + 1);
    out.push(id);
  }
  return out;
}

/** Every read of a stock row sends the proxy along whole, because the row is
 *  read while configuring an emulator and the proxy is half of what gets typed. */
const STOCK_SELECT = {
  id: true,
  username: true,
  password: true,
  deployedAt: true,
  createdAt: true,
  proxy: {
    select: { id: true, protocol: true, host: true, port: true, username: true, password: true },
  },
} as const;

@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  async listProxies(clientId: string) {
    const items = await this.prisma.proxy.findMany({
      where: { clientId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        protocol: true,
        host: true,
        port: true,
        username: true,
        password: true,
        createdAt: true,
        _count: { select: { stock: true } },
      },
    });
    return {
      total: items.length,
      items: items.map(({ _count, ...p }) => ({ ...p, accounts: _count.stock })),
    };
  }

  async importProxies(clientId: string, text: string) {
    const { valid, invalid } = parseProxyLines(text);
    const { count } = await this.prisma.proxy.createMany({
      data: valid.map((p) => ({ clientId, ...p })),
      skipDuplicates: true,
    });
    return {
      added: count,
      duplicate: valid.length - count,
      invalid,
      total: await this.prisma.proxy.count({ where: { clientId } }),
    };
  }

  /** -> how many accounts it left unassigned. They stay on the screen with an
   *  assign button rather than being reshuffled here uninvited. */
  async deleteProxy(clientId: string, id: string) {
    const proxy = await this.prisma.proxy.findFirst({
      where: { id, clientId },
      select: { id: true, _count: { select: { stock: true } } },
    });
    if (!proxy) throw new NotFoundException('proxy not found');
    // SetNull on the relation does the unassigning.
    await this.prisma.proxy.delete({ where: { id: proxy.id } });
    return { deleted: true, unassigned: proxy._count.stock };
  }

  async listAccounts(clientId: string) {
    const [items, assigned, deployed] = await Promise.all([
      this.prisma.stockAccount.findMany({
        where: { clientId },
        orderBy: { createdAt: 'asc' },
        select: STOCK_SELECT,
      }),
      this.prisma.stockAccount.count({ where: { clientId, proxyId: { not: null } } }),
      this.prisma.stockAccount.count({ where: { clientId, deployedAt: { not: null } } }),
    ]);
    return { total: items.length, assigned, deployed, items };
  }

  /**
   * Paste a seller's file in. -> what became of every line, and how many of
   * the accounts now hold a proxy.
   *
   * Assignment happens here, not in a second step, because "added but never
   * assigned" is a state nobody asked for. The rows assigned are the pasted
   * usernames that hold no proxy after the insert -- which is the new rows,
   * plus any re-pasted duplicate that lost its proxy when one was deleted.
   * Re-pasting a file is therefore also how those get repaired, and rows the
   * paste never named are never touched.
   */
  async importAccounts(clientId: string, text: string) {
    const { valid, invalid } = parseAccountLines(text);
    const { count } = await this.prisma.stockAccount.createMany({
      data: valid.map((a) => ({ clientId, ...a })),
      skipDuplicates: true,
    });

    const usernames = valid.map((a) => a.username);
    const assigned = await this.assignEvenly(clientId, { username: { in: usernames } });

    // `unassigned` is scoped to THIS paste, not the whole client. A row left
    // without a proxy here means there were none to deal -- every account is
    // assigned when any proxy exists -- which is exactly what the screen's "no
    // proxies yet" message says. Counting the client's other orphans (a
    // proxy someone deleted, say) would make that message fire while proxies
    // plainly exist; those are surfaced by the header pill and the repair
    // button instead, which is where they belong.
    const [total, unassigned] = await Promise.all([
      this.prisma.stockAccount.count({ where: { clientId } }),
      this.prisma.stockAccount.count({
        where: { clientId, proxyId: null, username: { in: usernames } },
      }),
    ]);
    return { added: count, duplicate: valid.length - count, invalid, assigned, unassigned, total };
  }

  /** The repair button: put every unassigned account behind a proxy, evenly.
   *  For after proxies arrive later than accounts did, or one was deleted. */
  async assignUnassigned(clientId: string) {
    const assigned = await this.assignEvenly(clientId, {});
    const unassigned = await this.prisma.stockAccount.count({
      where: { clientId, proxyId: null },
    });
    return { assigned, unassigned };
  }

  /**
   * Deal proxies to this client's unassigned accounts (narrowed by `where`),
   * least-loaded-first with random ties. -> how many actually got one.
   *
   * SERIALIZED PER CLIENT by a transaction-scoped advisory lock. The spread is
   * only even if it deals from a true count of what each proxy already holds,
   * and READ COMMITTED alone does not give that: two imports (or an import and
   * the assign-unassigned repair) firing together would each read the same
   * pre-deal counts, both pick the emptiest proxy, and both stack onto it --
   * silently and permanently, since imports never reshuffle. The lock makes the
   * second caller wait for the first to commit and then read its result, so it
   * spreads on top of what actually landed. It is the same "one lock around the
   * metered write" the target claim uses, and it releases on its own when the
   * transaction ends. hashtext maps the clientId to the lock's integer key.
   *
   * The write also re-asserts `proxyId: null`, so a row another caller assigned
   * in the gap is never stolen, and the count returned is what the writes
   * really changed rather than what was planned -- the two together stop the
   * "assigned" figure from double-counting a row two callers both aimed at.
   */
  private async assignEvenly(
    clientId: string,
    where: { username?: { in: string[] } },
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${clientId}))`;

      const rows = await tx.stockAccount.findMany({
        where: { clientId, proxyId: null, ...where },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (rows.length === 0) return 0;

      const proxies = await tx.proxy.findMany({
        where: { clientId },
        select: { id: true, _count: { select: { stock: true } } },
      });
      const deal = spreadEvenly(
        proxies.map((p) => ({ id: p.id, count: p._count.stock })),
        rows.length,
      );
      if (deal.length === 0) return 0;

      // One UPDATE per proxy rather than per account: the deal groups by
      // proxy, and a 500-account paste over 10 proxies is 10 writes, not 500.
      const byProxy = new Map<string, string[]>();
      deal.forEach((proxyId, i) => {
        byProxy.set(proxyId, [...(byProxy.get(proxyId) ?? []), rows[i].id]);
      });
      let assigned = 0;
      for (const [proxyId, ids] of byProxy) {
        const { count } = await tx.stockAccount.updateMany({
          where: { id: { in: ids }, proxyId: null },
          data: { proxyId },
        });
        assigned += count;
      }
      return assigned;
    });
  }

  /**
   * Put ONE account behind a proxy, chosen as the import chooses. For a row
   * left unassigned, or one whose draw the operator wants re-rolled -- the
   * account is counted out of its own proxy first, so a re-roll asks "where
   * would this land if it arrived now" and landing where it already is can be
   * the honest answer.
   */
  async assignOne(clientId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.stockAccount.findFirst({
        where: { id, clientId },
        select: { id: true, proxyId: true },
      });
      if (!account) throw new NotFoundException('account not found');

      const proxies = await tx.proxy.findMany({
        where: { clientId },
        select: { id: true, _count: { select: { stock: true } } },
      });
      const [proxyId] = spreadEvenly(
        proxies.map((p) => ({
          id: p.id,
          count: p._count.stock - (p.id === account.proxyId ? 1 : 0),
        })),
        1,
      );
      if (!proxyId) throw new NotFoundException('no proxies to assign — add some first');

      return tx.stockAccount.update({
        where: { id: account.id },
        data: { proxyId },
        select: STOCK_SELECT,
      });
    });
  }

  /** Mark installed on an emulator, or back in the drawer. */
  async setDeployed(clientId: string, id: string, deployed: boolean) {
    const account = await this.prisma.stockAccount.findFirst({
      where: { id, clientId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('account not found');
    return this.prisma.stockAccount.update({
      where: { id: account.id },
      data: { deployedAt: deployed ? new Date() : null },
      select: STOCK_SELECT,
    });
  }

  async deleteAccount(clientId: string, id: string) {
    const account = await this.prisma.stockAccount.findFirst({
      where: { id, clientId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('account not found');
    await this.prisma.stockAccount.delete({ where: { id: account.id } });
    return { deleted: true };
  }
}

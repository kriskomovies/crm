/**
 * Operator login: a real form and a cookie, instead of the browser's basic-auth
 * prompt.
 *
 * The prompt worked, but it is a dead end -- it cannot be styled, cannot say
 * what went wrong, cannot log out without closing the browser, and looks like
 * something has broken rather than like a product.
 *
 * Built on node's own crypto, deliberately. bcryptjs/argon2/jsonwebtoken would
 * each do this, and each is a dependency in the runtime image for something
 * scrypt and HMAC already cover: scrypt is memory-hard and is what node ships
 * for exactly this, and the session is a signed value rather than a database
 * row because there is one operator and nothing to revoke individually.
 *
 * The cookie carries the clientId. It is HMAC-signed with SESSION_SECRET, so it
 * cannot be forged, and httpOnly so a script on the page cannot read it -- the
 * key it stands in for grants a client's entire book of business, which is the
 * whole reason it was never shipped to the browser in the first place.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT_N = 16384;
const KEYLEN = 32;

/** `scrypt$<salt-hex>$<hash-hex>`. Self-describing so the format can change. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N: SCRYPT_N });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = (stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(plain, Buffer.from(saltHex, 'hex'), expected.length, {
      N: SCRYPT_N,
    });
    // Constant time: a plain === comparison leaks how much of the hash matched
    // through timing, which is enough to reconstruct it byte by byte.
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export const COOKIE = 'crm_session';

@Injectable()
export class SessionService {
  private readonly log = new Logger(SessionService.name);

  private readonly user = process.env.UI_USER ?? 'operator';
  private readonly hash = process.env.UI_PASSWORD_HASH ?? '';
  private readonly ttlMs =
    Number(process.env.SESSION_HOURS ?? 12) * 3_600_000;

  /**
   * Falls back to a random secret so a missing SESSION_SECRET cannot silently
   * make every session forgeable with a known key. The cost is that sessions do
   * not survive a restart, which is loud and harmless.
   */
  private readonly secret =
    process.env.SESSION_SECRET || randomBytes(32).toString('hex');

  constructor() {
    if (!process.env.SESSION_SECRET) {
      this.log.warn(
        'SESSION_SECRET unset: using a random one, so logins do not survive a restart',
      );
    }
    if (!this.hash) {
      this.log.error('UI_PASSWORD_HASH unset: nobody can log in');
    }
  }

  check(username: string, password: string): boolean {
    // Both compared even when the username is wrong, so a wrong username and a
    // wrong password take the same time and cannot be told apart.
    const userOk = username === this.user;
    const passOk = verifyPassword(password ?? '', this.hash);
    return userOk && passOk;
  }

  /** `<clientId>.<expiry>.<hmac>` */
  issue(clientId: string): string {
    const expires = Date.now() + this.ttlMs;
    const body = `${clientId}.${expires}`;
    return `${body}.${this.sign(body)}`;
  }

  /** The clientId this token vouches for, or null. */
  open(token: string | undefined): string | null {
    if (!token) return null;
    const i = token.lastIndexOf('.');
    if (i < 0) return null;
    const body = token.slice(0, i);
    const sig = token.slice(i + 1);

    const expected = this.sign(body);
    if (
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    const [clientId, expires] = body.split('.');
    // Checked AFTER the signature: an expiry read out of an unverified token is
    // attacker-controlled.
    if (!clientId || !expires || Number(expires) < Date.now()) return null;
    return clientId;
  }

  cookieHeader(token: string, secure: boolean): string {
    const age = Math.floor(this.ttlMs / 1000);
    return (
      `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}` +
      (secure ? '; Secure' : '')
    );
  }

  clearHeader(): string {
    return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('hex');
  }
}

/** No cookie-parser dependency for one header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

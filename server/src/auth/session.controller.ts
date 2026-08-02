/**
 * Login, logout, and "am I logged in".
 *
 * Unguarded by necessity -- it is how a browser with no session gets one. What
 * stands in place of a guard is that it only ever accepts the single configured
 * operator credential, and it hands back a cookie rather than the API key: the
 * key grants a client's entire book of business and must never reach a browser
 * where a script could read it.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../prisma/prisma.service';
import { hashApiKey } from './api-key.guard';
import { COOKIE, readCookie, SessionService } from './session.service';

@ApiTags('session')
@Controller('api/session')
export class SessionController {
  constructor(
    private readonly session: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  /** Who the browser currently is, so the UI can decide to show the login. */
  @Get()
  async whoami(@Req() req: any) {
    const clientId = this.session.open(readCookie(req.headers.cookie, COOKIE));
    if (!clientId) return { authenticated: false };
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, name: true },
    });
    return client
      ? { authenticated: true, client }
      : { authenticated: false };
  }

  @Post()
  async login(
    @Body() body: { username?: string; password?: string },
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
  ) {
    if (!this.session.check(body?.username ?? '', body?.password ?? '')) {
      // One message for both wrong-user and wrong-password: saying which is
      // wrong tells an attacker when they have found a real username.
      throw new UnauthorizedException('wrong username or password');
    }

    // The operator's identity IS a client. Resolve it from OPERATOR_API_KEY so
    // the session stands for the same tenant the injected key used to.
    const operatorKey = process.env.OPERATOR_API_KEY ?? '';
    const client = operatorKey
      ? await this.prisma.client.findUnique({
          where: { apiKeyHash: hashApiKey(operatorKey) },
          select: { id: true, name: true },
        })
      : null;

    if (!client) {
      // Deliberately explicit: this exact mismatch -- a key nothing registered
      // -- already cost an afternoon once, presenting as a 401 from a UI that
      // had just authenticated successfully.
      throw new UnauthorizedException(
        'OPERATOR_API_KEY does not match any client. Register it with ' +
          '`node dist/cli/provision.js --client "..." --key "<OPERATOR_API_KEY>" ...`',
      );
    }

    const secure = (req.headers['x-forwarded-proto'] ?? '') === 'https';
    res.header('Set-Cookie', this.session.cookieHeader(this.session.issue(client.id), secure));
    return { authenticated: true, client };
  }

  @Delete()
  logout(@Res({ passthrough: true }) res: any) {
    res.header('Set-Cookie', this.session.clearHeader());
    return { authenticated: false };
  }
}

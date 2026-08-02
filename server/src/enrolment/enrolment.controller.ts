/**
 * Two surfaces, and the split matters.
 *
 * /v1/enrol is UNAUTHENTICATED -- it has to be, it is how a machine with no
 * credential gets one. Everything that constrains it lives in the service: an
 * enrolment token if the machine sends one, otherwise a window the operator
 * opened, and then only when exactly one client has that window open.
 *
 * /api/enrolment/* is the operator's side and takes the normal key. Minting the
 * token, opening the window, seeing which machines enrolled, and revoking one
 * are all things only someone already inside the account may do.
 */
import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { EnrolmentService } from './enrolment.service';

@ApiTags('enrolment')
@Controller('v1')
export class MachineEnrolmentController {
  constructor(private readonly enrolment: EnrolmentService) {}

  /**
   * No guard. See the file header.
   *
   * `token` is optional on the wire so an agent built before enrolment tokens
   * existed keeps working: without one this falls back to the open-window path.
   * Sending it is strictly better -- it names its own client and needs nothing
   * left open to the internet.
   */
  @Post('enrol')
  enrol(@Body() body: { name?: string; token?: string }) {
    return this.enrolment.enrol(body?.name ?? '', body?.token);
  }
}

@ApiTags('enrolment')
@Controller('api/enrolment')
@UseGuards(ApiKeyGuard)
export class EnrolmentController {
  constructor(private readonly enrolment: EnrolmentService) {}

  @Get()
  status(@Req() req: any) {
    return this.enrolment.status(req.client.id);
  }

  @Post('open')
  open(@Req() req: any, @Body() body: { minutes?: number }) {
    return this.enrolment.open(req.client.id, Number(body?.minutes ?? 10));
  }

  @Post('close')
  close(@Req() req: any) {
    return this.enrolment.close(req.client.id);
  }

  /**
   * Mint or rotate the enrolment token. The response carries it in the clear
   * because this is the only moment it exists outside a hash -- storing it
   * would defeat hashing it.
   */
  @Post('token')
  mintToken(@Req() req: any) {
    return this.enrolment.mintToken(req.client.id);
  }

  @Delete('machines/:id')
  revoke(@Req() req: any, @Param('id') id: string) {
    return this.enrolment.revoke(req.client.id, id);
  }
}

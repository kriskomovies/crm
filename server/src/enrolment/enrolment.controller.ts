/**
 * Two surfaces, and the split matters.
 *
 * /v1/enrol is UNAUTHENTICATED -- it has to be, it is how a machine with no
 * credential gets one. Everything that constrains it lives in the service: it
 * works only inside a window the operator opened, and only when exactly one
 * client has that window open.
 *
 * /api/enrolment/* is the operator's side and takes the normal key. Opening the
 * window, seeing which machines enrolled, and revoking one are all things only
 * someone already inside the account may do.
 */
import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiKeyGuard } from '../auth/api-key.guard';
import { EnrolmentService } from './enrolment.service';

@ApiTags('enrolment')
@Controller('v1')
export class MachineEnrolmentController {
  constructor(private readonly enrolment: EnrolmentService) {}

  /** No guard. See the file header. */
  @Post('enrol')
  enrol(@Body() body: { name?: string }) {
    return this.enrolment.enrol(body?.name ?? '');
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

  @Delete('machines/:id')
  revoke(@Req() req: any, @Param('id') id: string) {
    return this.enrolment.revoke(req.client.id, id);
  }
}

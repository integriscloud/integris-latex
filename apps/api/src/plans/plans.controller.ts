import type { PublicPlan } from '@integris/shared';
import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { PlansService } from './plans.service.js';

@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /** Public, read-only list of plans for the pricing page. No user data. */
  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOkResponse({ description: 'Active plans with prices (integer XOF, TTC) and quotas.' })
  list(): Promise<PublicPlan[]> {
    return this.plans.listPublic();
  }
}

import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller('health')
export class HealthController {
  /** Liveness probe: the process is up and serving HTTP. */
  @Get()
  @ApiOkResponse({ description: 'The API is running.' })
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

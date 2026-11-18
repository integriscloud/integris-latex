import type { ApiErrorCode } from '@integris/shared';
import { HttpException, HttpStatus } from '@nestjs/common';

/** HTTP error with a stable `{ code }` body that the web app translates. */
export class ApiError extends HttpException {
  constructor(status: HttpStatus, code: ApiErrorCode, retryAfter?: number) {
    super(retryAfter === undefined ? { code } : { code, retryAfter }, status);
  }
}

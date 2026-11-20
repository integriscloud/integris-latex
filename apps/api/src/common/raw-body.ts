import type { ApiErrorCode } from '@integris/shared';
import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from './api-error.js';

/**
 * Reads a raw upload body. Called by the route handler, so only after the guards have checked
 * the session, the role and the origin: nothing is buffered for an anonymous request. Stops
 * reading as soon as the limit is passed, whatever the Content-Length says (chunked bodies too).
 */
export async function readRawBody(
  request: Request,
  type: 'application/octet-stream' | 'application/zip' | 'application/x-www-form-urlencoded',
  limit: number,
  tooLarge: ApiErrorCode,
): Promise<Uint8Array> {
  if (!request.is(type)) throw new ApiError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'invalid_request');
  if (Number(request.get('content-length') ?? 0) > limit) {
    throw new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, tooLarge);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      // Stop receiving: the answer closes the connection.
      request.res?.set('Connection', 'close');
      throw new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, tooLarge);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

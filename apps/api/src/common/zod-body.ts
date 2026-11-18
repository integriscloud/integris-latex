import { applyDecorators, Body, HttpStatus, type PipeTransform, Query } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from './api-error.js';

class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_request');
    return result.data;
  }
}

/** Request body validated by a Zod schema from @integris/shared. */
export const ZodBody = <T extends z.ZodType>(schema: T) => Body(new ZodPipe(schema));

/** Documents the body schema in Swagger. */
export const ApiZodBody = (schema: z.ZodType) =>
  applyDecorators(
    ApiBody({ schema: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as object }),
  );

/** Query string validated by a Zod schema. */
export const ZodQuery = <T extends z.ZodType>(schema: T) => Query(new ZodPipe(schema));

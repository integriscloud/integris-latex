import {
  compareQuerySchema,
  createSubmissionSchema,
  sendSubmissionSchema,
  submissionDueSchema,
  type SubmissionComparison,
  type SubmissionDetail,
  type SubmissionList,
  type ToReviewList,
  updateSubmissionSchema,
  validateSubmissionSchema,
} from '@integris/shared';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/zod-body.js';
import { type SubmissionActor, SubmissionsService } from './submissions.service.js';

const actorOf = (auth: AuthContext, request: Request): SubmissionActor => ({
  userId: auth.user.id,
  ip: request.ip ?? null,
});

/** Submissions of a project: drafts, sendings, review, validation, comparison. */
@ApiTags('submissions')
@Controller('projects/:id/submissions')
@UseGuards(AuthGuard)
export class SubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  /** Submissions of the project (every role) and the reviewers that can be chosen. */
  @Get()
  list(@Auth() auth: AuthContext, @Param('id') id: string): Promise<SubmissionList> {
    return this.submissions.list(auth.user.id, id);
  }

  /** New draft (owner and editors). */
  @Post()
  @ApiZodBody(createSubmissionSchema)
  create(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(createSubmissionSchema) body: z.output<typeof createSubmissionSchema>,
  ): Promise<SubmissionDetail> {
    return this.submissions.create(auth.user.id, id, body);
  }

  @Get(':submissionId')
  detail(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
  ): Promise<SubmissionDetail> {
    return this.submissions.detail(auth.user.id, id, submissionId);
  }

  /** Changes a draft (owner and editors). */
  @Patch(':submissionId')
  @ApiZodBody(updateSubmissionSchema)
  update(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @ZodBody(updateSubmissionSchema) body: z.output<typeof updateSubmissionSchema>,
  ): Promise<SubmissionDetail> {
    return this.submissions.update(auth.user.id, id, submissionId, body);
  }

  @Delete(':submissionId')
  @HttpCode(204)
  async remove(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
  ): Promise<void> {
    await this.submissions.remove(auth.user.id, id, submissionId);
  }

  /**
   * Sends the draft or a corrected version: frozen and compiled; the status moves on when its
   * PDF is ready. 429 `rate_limited` above 3 sendings per project and per hour.
   */
  @Post(':submissionId/send')
  @ApiZodBody(sendSubmissionSchema)
  send(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @ZodBody(sendSubmissionSchema) body: z.output<typeof sendSubmissionSchema>,
    @Req() request: Request,
  ): Promise<SubmissionDetail> {
    return this.submissions.send(actorOf(auth, request), id, submissionId, body);
  }

  /** Opened by a reviewer: a submission received or revised moves to "in review". */
  @Post(':submissionId/open')
  open(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @Req() request: Request,
  ): Promise<SubmissionDetail> {
    return this.submissions.open(actorOf(auth, request), id, submissionId);
  }

  @Post(':submissionId/feedback')
  feedback(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @Req() request: Request,
  ): Promise<SubmissionDetail> {
    return this.submissions.feedback(actorOf(auth, request), id, submissionId);
  }

  /** Validates the version read (supervisor among the reviewers); locks its files. */
  @Post(':submissionId/validate')
  @ApiZodBody(validateSubmissionSchema)
  validate(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @ZodBody(validateSubmissionSchema) body: z.output<typeof validateSubmissionSchema>,
    @Req() request: Request,
  ): Promise<SubmissionDetail> {
    return this.submissions.validate(actorOf(auth, request), id, submissionId, body.number);
  }

  @Post(':submissionId/unlock')
  unlock(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @Req() request: Request,
  ): Promise<SubmissionDetail> {
    return this.submissions.unlock(actorOf(auth, request), id, submissionId);
  }

  /** Deadline (supervisor among the reviewers, after sending). */
  @Patch(':submissionId/due')
  @ApiZodBody(submissionDueSchema)
  setDue(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @ZodBody(submissionDueSchema) body: z.output<typeof submissionDueSchema>,
    @Req() request: Request,
  ): Promise<SubmissionDetail> {
    return this.submissions.setDue(actorOf(auth, request), id, submissionId, body.dueAt);
  }

  /** Line-by-line differences between two versions (`?from=1&to=2`). */
  @Get(':submissionId/compare')
  compare(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @ZodQuery(compareQuerySchema) query: z.output<typeof compareQuerySchema>,
  ): Promise<SubmissionComparison> {
    return this.submissions.compare(auth.user.id, id, submissionId, query.from, query.to);
  }
}

/** Submissions waiting for the user's review, in every project. */
@ApiTags('submissions')
@Controller('submissions')
@UseGuards(AuthGuard)
export class ToReviewController {
  constructor(private readonly submissions: SubmissionsService) {}

  @Get('to-review')
  toReview(@Auth() auth: AuthContext): Promise<ToReviewList> {
    return this.submissions.toReview(auth.user.id);
  }
}

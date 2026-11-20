import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CompileModule } from '../compile/compile.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { CommentsService } from './comments.service.js';
import { ShareLinksService } from './share-links.service.js';
import {
  CommentsController,
  InvitationsController,
  PublicController,
  SharingController,
} from './sharing.controller.js';
import { SharingService } from './sharing.service.js';

@Module({
  imports: [AuthModule, ProjectsModule, CompileModule],
  controllers: [SharingController, CommentsController, InvitationsController, PublicController],
  providers: [SharingService, ShareLinksService, CommentsService],
})
export class SharingModule {}

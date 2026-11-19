import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { CollabDocsService } from './collab-docs.service.js';
import { InternalServer } from './internal-server.js';

@Module({
  imports: [AuthModule, ProjectsModule],
  providers: [CollabDocsService, InternalServer],
  exports: [InternalServer],
})
export class CollabModule {}

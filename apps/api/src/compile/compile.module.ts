import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FilesServer } from '../files/files-server.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { CompileQueueService } from './compile-queue.service.js';
import { CompileController } from './compile.controller.js';
import { CompileService } from './compile.service.js';

@Module({
  imports: [AuthModule, ProjectsModule],
  controllers: [CompileController],
  providers: [CompileQueueService, CompileService, FilesServer],
  exports: [FilesServer, CompileService],
})
export class CompileModule {}

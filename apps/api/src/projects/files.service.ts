import type { ProjectFile } from '@integris/db';
import {
  allowedExtensionOf,
  isTextExtension,
  MAX_PROJECT_FILE_BYTES,
  normalizeFilePath,
  normalizeProjectPath,
  pathConflicts,
  type ProjectDetail,
  PROJECTS_BUCKET,
} from '@integris/shared';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { checkContent } from './file-content.js';
import { ProjectEventsService } from './project-events.service.js';
import { fail, ProjectsService } from './projects.service.js';

/** Binary formats that may be renamed into each other (same content). */
const sameFormat = (a: string, b: string) => {
  const family = (extension: string) => (extension === '.jpeg' ? '.jpg' : extension);
  return family(a) === family(b);
};

const inFolder = (path: string, folder: string) => path.startsWith(`${folder}/`);

/** A path taken by a parallel request (unique constraint) answers 409 like any other clash. */
const uniqueConflict = (error: unknown) =>
  (error as { code?: string }).code === 'P2002'
    ? new ApiError(HttpStatus.CONFLICT, 'path_taken')
    : error;

/**
 * Files of a project: every call checks the user's right on the project, the locks set by a
 * validated submission, the file rules of docs/spec.md and the storage quota of the owner. The
 * text typed in the editor is written by the collaboration server (CollabDocsService).
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly projects: ProjectsService,
    private readonly config: ApiConfig,
    private readonly events: ProjectEventsService,
  ) {}

  private paths(projectId: string): Promise<ProjectFile[]> {
    return this.prisma.client.projectFile.findMany({ where: { projectId } });
  }

  private async file(projectId: string, fileId: string): Promise<ProjectFile> {
    const file = await this.prisma.client.projectFile.findFirst({
      where: { id: fileId, projectId },
    });
    if (!file) return fail(HttpStatus.NOT_FOUND, 'not_found');
    if (file.lockedBySubmissionId) fail(HttpStatus.CONFLICT, 'file_locked');
    return file;
  }

  /** New empty text file (`.tex`, `.bib`…), in an existing or a new folder. */
  async createText(userId: string, projectId: string, input: string): Promise<ProjectDetail> {
    const { project } = await this.projects.require(userId, projectId, 'edit');
    const path = normalizeFilePath(input);
    if (!path) return fail(HttpStatus.BAD_REQUEST, 'invalid_path');
    if (!isTextExtension(allowedExtensionOf(path)!)) fail(HttpStatus.BAD_REQUEST, 'type_mismatch');
    await this.projects.runLocked(project.ownerId, async () => {
      const existing = await this.paths(projectId);
      this.checkCount(existing.length + 1);
      if (
        pathConflicts(
          existing.map((file) => file.path),
          path,
        )
      ) {
        fail(HttpStatus.CONFLICT, 'path_taken');
      }
      const storageKey = this.projects.newKey(projectId);
      await this.storage.put(PROJECTS_BUCKET, storageKey, new Uint8Array());
      try {
        await this.prisma.client.projectFile.create({
          data: { projectId, path, kind: 'TEXT', storageKey, sizeBytes: 0 },
        });
      } catch (error) {
        await this.storage.deleteKeys(PROJECTS_BUCKET, [storageKey]);
        throw uniqueConflict(error);
      }
    });
    await this.projects.touch(projectId);
    await this.events.changed(projectId);
    return this.projects.detail(userId, projectId);
  }

  private checkCount(count: number): void {
    if (count > this.config.env.PROJECT_MAX_FILES) fail(HttpStatus.CONFLICT, 'too_many_files');
  }

  /**
   * Uploads a file. Its extension must be allowed, its real content must match it (signature or
   * UTF-8 text) and it must fit in 10 MB and in the storage quota of the project owner.
   */
  async upload(
    userId: string,
    projectId: string,
    input: string,
    bytes: Uint8Array,
    replace: boolean,
  ): Promise<ProjectDetail> {
    const { project } = await this.projects.require(userId, projectId, 'edit');
    const normalized = normalizeProjectPath(input);
    if (!normalized) return fail(HttpStatus.BAD_REQUEST, 'invalid_path');
    const extension = allowedExtensionOf(normalized);
    if (!extension) return fail(HttpStatus.UNPROCESSABLE_ENTITY, 'extension_not_allowed');
    const path = normalized;
    if (bytes.length > MAX_PROJECT_FILE_BYTES) fail(HttpStatus.PAYLOAD_TOO_LARGE, 'file_too_large');
    const check = checkContent(extension, bytes);
    if (!check.ok) return fail(HttpStatus.UNPROCESSABLE_ENTITY, check.reason);

    // Usage is charged to the owner of the project, whoever uploads.
    await this.projects.runLocked(project.ownerId, async () => {
      const existing = await this.paths(projectId);
      const previous = existing.find((file) => file.path === path);
      if (previous && !replace) fail(HttpStatus.CONFLICT, 'path_taken');
      if (previous?.lockedBySubmissionId) fail(HttpStatus.CONFLICT, 'file_locked');
      if (!previous) this.checkCount(existing.length + 1);
      if (
        !previous &&
        pathConflicts(
          existing.map((file) => file.path),
          path,
        )
      ) {
        fail(HttpStatus.CONFLICT, 'path_taken');
      }
      await this.projects.checkStorageFor(
        project.ownerId,
        bytes.length - (previous?.sizeBytes ?? 0),
      );

      const row = await this.store(projectId, path, previous, check.kind, bytes);
      // A text file open in the editor takes the new content as a change.
      if (previous && row.kind === 'TEXT') {
        await this.events.publish({ type: 'file-replaced', projectId, fileId: row.id });
      }
    });
    await this.projects.touch(projectId);
    await this.events.changed(projectId);
    return this.projects.detail(userId, projectId);
  }

  /**
   * Writes the content under a new object key, then points the row (new or `previous`) to it.
   * Called under the owner lock, after the quota check.
   */
  private async store(
    projectId: string,
    path: string,
    previous: ProjectFile | undefined,
    kind: ProjectFile['kind'],
    bytes: Uint8Array,
  ): Promise<ProjectFile> {
    const storageKey = this.projects.newKey(projectId);
    await this.storage.put(PROJECTS_BUCKET, storageKey, bytes);
    let row: ProjectFile;
    try {
      const data = { kind, storageKey, sizeBytes: bytes.length };
      row = previous
        ? await this.prisma.client.projectFile.update({ where: { id: previous.id }, data })
        : await this.prisma.client.projectFile.create({ data: { projectId, path, ...data } });
    } catch (error) {
      await this.storage.deleteKeys(PROJECTS_BUCKET, [storageKey]);
      throw uniqueConflict(error);
    }
    if (previous?.storageKey) await this.removeObjects([previous.storageKey]);
    return row;
  }

  /**
   * Content of a text file as last written to storage (project search, completion). The editor
   * gets the live text from the collaboration server. Any role on the project reads.
   */
  async readText(userId: string, projectId: string, fileId: string): Promise<Uint8Array> {
    await this.projects.access(userId, projectId);
    return this.storedText(projectId, fileId);
  }

  /** Stored content of a text file, without any access check (callers check first). */
  async storedText(projectId: string, fileId: string): Promise<Uint8Array> {
    const find = () =>
      this.prisma.client.projectFile.findFirst({ where: { id: fileId, projectId } });
    let file = await find();
    if (!file) return fail(HttpStatus.NOT_FOUND, 'not_found');
    if (file.kind !== 'TEXT') fail(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'not_text');
    try {
      return file.storageKey
        ? await this.storage.get(PROJECTS_BUCKET, file.storageKey)
        : new Uint8Array();
    } catch {
      // A write replaced the object between the two reads: read the new version once.
      file = await find();
      if (!file) return fail(HttpStatus.NOT_FOUND, 'not_found');
      return file.storageKey
        ? await this.storage.get(PROJECTS_BUCKET, file.storageKey)
        : new Uint8Array();
    }
  }

  /** Renames or moves a file. A binary file keeps its format; a text file stays text. */
  async move(
    userId: string,
    projectId: string,
    fileId: string,
    input: string,
  ): Promise<ProjectDetail> {
    const { project } = await this.projects.require(userId, projectId, 'edit');
    // Serialized with uploads of the same owner: no file and folder of the same name.
    await this.projects.runLocked(project.ownerId, async () => {
      const file = await this.file(projectId, fileId);
      const path = normalizeFilePath(input);
      if (!path) return fail(HttpStatus.BAD_REQUEST, 'invalid_path');
      const from = allowedExtensionOf(file.path);
      const to = allowedExtensionOf(path)!;
      const compatible =
        file.kind === 'TEXT' ? isTextExtension(to) : from !== null && sameFormat(from, to);
      if (!compatible) fail(HttpStatus.UNPROCESSABLE_ENTITY, 'type_mismatch');
      if (path !== file.path) {
        const others = (await this.paths(projectId)).filter((other) => other.id !== file.id);
        if (
          pathConflicts(
            others.map((other) => other.path),
            path,
          )
        ) {
          fail(HttpStatus.CONFLICT, 'path_taken');
        }
        await this.prisma.client.$transaction([
          this.prisma.client.projectFile.update({ where: { id: file.id }, data: { path } }),
          this.prisma.client.project.update({
            where: { id: projectId },
            data: {
              lastActivityAt: new Date(),
              ...(project.mainFilePath === file.path ? { mainFilePath: path } : {}),
            },
          }),
        ]);
      }
    });
    await this.events.changed(projectId);
    return this.projects.detail(userId, projectId);
  }

  /** Renames or moves a folder with everything inside it. */
  async moveFolder(
    userId: string,
    projectId: string,
    fromInput: string,
    toInput: string,
  ): Promise<ProjectDetail> {
    const { project } = await this.projects.require(userId, projectId, 'edit');
    const from = normalizeProjectPath(fromInput);
    const to = normalizeProjectPath(toInput);
    if (!from || !to || inFolder(to, from)) return fail(HttpStatus.BAD_REQUEST, 'invalid_path');
    await this.projects.runLocked(project.ownerId, async () => {
      const files = await this.paths(projectId);
      const moved = files.filter((file) => inFolder(file.path, from));
      if (!moved.length) return fail(HttpStatus.NOT_FOUND, 'not_found');
      if (moved.some((file) => file.lockedBySubmissionId)) fail(HttpStatus.CONFLICT, 'file_locked');
      const others = files.filter((file) => !inFolder(file.path, from)).map((file) => file.path);
      const renamed = moved.map((file) => ({ file, path: `${to}${file.path.slice(from.length)}` }));
      if (renamed.some(({ path }) => !normalizeFilePath(path))) {
        fail(HttpStatus.BAD_REQUEST, 'invalid_path');
      }
      if (renamed.some(({ path }) => pathConflicts(others, path))) {
        fail(HttpStatus.CONFLICT, 'path_taken');
      }
      const main = renamed.find(({ file }) => file.path === project.mainFilePath);
      await this.prisma.client.$transaction([
        ...renamed.map(({ file, path }) =>
          this.prisma.client.projectFile.update({ where: { id: file.id }, data: { path } }),
        ),
        this.prisma.client.project.update({
          where: { id: projectId },
          data: { lastActivityAt: new Date(), ...(main ? { mainFilePath: main.path } : {}) },
        }),
      ]);
    });
    await this.events.changed(projectId);
    return this.projects.detail(userId, projectId);
  }

  async remove(userId: string, projectId: string, fileId: string): Promise<ProjectDetail> {
    await this.projects.require(userId, projectId, 'edit');
    const file = await this.file(projectId, fileId);
    await this.prisma.client.projectFile.delete({ where: { id: file.id } });
    if (file.storageKey) await this.removeObjects([file.storageKey]);
    await this.events.publish({ type: 'file-deleted', projectId, fileId: file.id });
    await this.projects.touch(projectId);
    await this.events.changed(projectId);
    return this.projects.detail(userId, projectId);
  }

  async removeFolder(userId: string, projectId: string, input: string): Promise<ProjectDetail> {
    await this.projects.require(userId, projectId, 'edit');
    const folder = normalizeProjectPath(input);
    if (!folder) return fail(HttpStatus.BAD_REQUEST, 'invalid_path');
    const files = (await this.paths(projectId)).filter((file) => inFolder(file.path, folder));
    if (!files.length) return fail(HttpStatus.NOT_FOUND, 'not_found');
    if (files.some((file) => file.lockedBySubmissionId)) fail(HttpStatus.CONFLICT, 'file_locked');
    await this.prisma.client.projectFile.deleteMany({
      where: { id: { in: files.map((file) => file.id) } },
    });
    await this.removeObjects(files.flatMap((file) => (file.storageKey ? [file.storageKey] : [])));
    for (const file of files) {
      await this.events.publish({ type: 'file-deleted', projectId, fileId: file.id });
    }
    await this.projects.touch(projectId);
    await this.events.changed(projectId);
    return this.projects.detail(userId, projectId);
  }

  /** Deletes objects whose rows are gone; a failure only leaves an orphan, purged with the project. */
  private async removeObjects(keys: string[]): Promise<void> {
    await this.storage
      .deleteKeys(PROJECTS_BUCKET, keys)
      .catch((error: unknown) => this.logger.warn({ err: error }, 'Object deletion failed'));
  }
}

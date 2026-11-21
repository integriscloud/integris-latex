import type { Prisma, ProjectFile } from '@integris/db';
import {
  allowedExtensionOf,
  isExamPartFile,
  isTextExtension,
  MAX_PROJECT_FILE_BYTES,
  normalizeFilePath,
  normalizeProjectPath,
  parentFolder,
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
import { type Actor, ProjectAuditService } from './project-audit.service.js';
import { ProjectEventsService } from './project-events.service.js';
import { fail, ProjectsService } from './projects.service.js';

/** Binary formats that may be renamed into each other (same content). */
const sameFormat = (a: string, b: string) => {
  const family = (extension: string) => (extension === '.jpeg' ? '.jpg' : extension);
  return family(a) === family(b);
};

const inFolder = (path: string, folder: string) => path.startsWith(`${folder}/`);
const atOrIn = (path: string, folder: string) => path === folder || inFolder(path, folder);

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
    private readonly audit: ProjectAuditService,
  ) {}

  private paths(projectId: string): Promise<ProjectFile[]> {
    return this.prisma.client.projectFile.findMany({ where: { projectId } });
  }

  /** Paths of the kept folders (created empty, or left empty). */
  private async keptFolders(projectId: string): Promise<string[]> {
    const rows = await this.prisma.client.projectFolder.findMany({ where: { projectId } });
    return rows.map((row) => row.path);
  }

  /**
   * Keeps the folders that held `paths` (files deleted or moved away): a folder only disappears
   * when it is deleted. Existing rows are left as they are.
   */
  private keepParents(
    db: Prisma.TransactionClient,
    projectId: string,
    paths: string[],
  ): Prisma.PrismaPromise<Prisma.BatchPayload> {
    const folders = [...new Set(paths.map(parentFolder).filter(Boolean))];
    return db.projectFolder.createMany({
      data: folders.map((path) => ({ projectId, path })),
      skipDuplicates: true,
    });
  }

  /**
   * The paths chosen in the submissions of the project that can still be sent follow a move.
   * Sent versions keep their frozen paths (and the id of each file, see SubmissionsService).
   */
  private async followInSubmissions(
    db: Prisma.TransactionClient,
    projectId: string,
    renamed: Map<string, string>,
  ): Promise<void> {
    const open = await db.submission.findMany({
      where: { projectId, status: { not: 'VALIDATED' } },
      select: { id: true, filePaths: true },
    });
    for (const submission of open) {
      if (!submission.filePaths.some((path) => renamed.has(path))) continue;
      await db.submission.update({
        where: { id: submission.id },
        data: { filePaths: submission.filePaths.map((path) => renamed.get(path) ?? path) },
      });
    }
  }

  /** Editors open on the project read its files again (tree, paths, main file). */
  private filesChanged(projectId: string): Promise<void> {
    return this.events.publish({ type: 'files-changed', projectId });
  }

  /**
   * A file that may be moved or deleted: not locked by a validation, and not one of the three
   * parts of an exam paper (subject, answer key, marking scheme), whose paths are fixed.
   */
  private async file(
    project: { id: string; kind: 'DOCUMENT' | 'ASSIGNMENT' },
    fileId: string,
  ): Promise<ProjectFile> {
    const file = await this.prisma.client.projectFile.findFirst({
      where: { id: fileId, projectId: project.id },
    });
    if (!file) return fail(HttpStatus.NOT_FOUND, 'not_found');
    if (file.lockedBySubmissionId) fail(HttpStatus.CONFLICT, 'file_locked');
    if (project.kind === 'ASSIGNMENT' && isExamPartFile(file.path)) {
      fail(HttpStatus.CONFLICT, 'exam_part_protected');
    }
    return file;
  }

  /** New empty text file (`.tex`, `.bib`…), in an existing or a new folder. */
  async createText(userId: string, projectId: string, input: string): Promise<ProjectDetail> {
    const { project } = await this.projects.require(userId, projectId, 'edit');
    const path = normalizeFilePath(input);
    if (!path) return fail(HttpStatus.BAD_REQUEST, 'invalid_path');
    if (!isTextExtension(allowedExtensionOf(path)!)) fail(HttpStatus.BAD_REQUEST, 'type_mismatch');
    await this.projects.runWritable(project, async () => {
      const existing = await this.paths(projectId);
      const folders = await this.keptFolders(projectId);
      this.checkCount(existing.length + folders.length + 1);
      if (
        pathConflicts(
          existing.map((file) => file.path),
          path,
          folders,
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
    await this.filesChanged(projectId);
    return this.projects.detail(userId, projectId);
  }

  /** Files and kept folders of a project: PROJECT_MAX_FILES at most. */
  private checkCount(count: number): void {
    if (count > this.config.env.PROJECT_MAX_FILES) fail(HttpStatus.CONFLICT, 'too_many_files');
  }

  /** New empty folder, kept until it is deleted. */
  async createFolder(userId: string, projectId: string, input: string): Promise<ProjectDetail> {
    const { project } = await this.projects.require(userId, projectId, 'edit');
    const path = normalizeProjectPath(input);
    if (!path) return fail(HttpStatus.BAD_REQUEST, 'invalid_path');
    await this.projects.runWritable(project, async () => {
      const existing = await this.paths(projectId);
      const folders = await this.keptFolders(projectId);
      this.checkCount(existing.length + folders.length + 1);
      if (
        pathConflicts(
          existing.map((file) => file.path),
          path,
          folders,
        )
      ) {
        fail(HttpStatus.CONFLICT, 'path_taken');
      }
      try {
        await this.prisma.client.projectFolder.create({ data: { projectId, path } });
      } catch (error) {
        throw uniqueConflict(error);
      }
    });
    await this.projects.touch(projectId);
    await this.events.changed(projectId);
    await this.filesChanged(projectId);
    return this.projects.detail(userId, projectId);
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
    await this.projects
      .runWritable(project, async () => {
        const existing = await this.paths(projectId);
        const folders = await this.keptFolders(projectId);
        const previous = existing.find((file) => file.path === path);
        if (previous && !replace) fail(HttpStatus.CONFLICT, 'path_taken');
        if (previous?.lockedBySubmissionId) fail(HttpStatus.CONFLICT, 'file_locked');
        if (!previous) this.checkCount(existing.length + folders.length + 1);
        if (
          !previous &&
          pathConflicts(
            existing.map((file) => file.path),
            path,
            folders,
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
        return previous;
      })
      .then((previous) => (previous ? undefined : this.filesChanged(projectId)));
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

  /**
   * Renames or moves a file. A binary file keeps its format; a text file stays text. The row keeps
   * its id: collaborative document, comments, history and submissions follow it.
   */
  async move(
    actor: Actor,
    projectId: string,
    fileId: string,
    input: string,
  ): Promise<ProjectDetail> {
    const userId = actor.userId!;
    const { project } = await this.projects.require(userId, projectId, 'edit');
    // Serialized with uploads of the same owner: no file and folder of the same name.
    const moved = await this.projects.runWritable(project, async () => {
      const file = await this.file(project, fileId);
      const path = normalizeFilePath(input);
      if (!path) return fail(HttpStatus.BAD_REQUEST, 'invalid_path');
      const from = allowedExtensionOf(file.path);
      const to = allowedExtensionOf(path)!;
      const compatible =
        file.kind === 'TEXT' ? isTextExtension(to) : from !== null && sameFormat(from, to);
      if (!compatible) fail(HttpStatus.UNPROCESSABLE_ENTITY, 'type_mismatch');
      if (path === file.path) return false;
      const others = (await this.paths(projectId)).filter((other) => other.id !== file.id);
      const folders = await this.keptFolders(projectId);
      if (
        pathConflicts(
          others.map((other) => other.path),
          path,
          folders,
        )
      ) {
        fail(HttpStatus.CONFLICT, 'path_taken');
      }
      // The folder left empty is kept: it counts like any other entry.
      const left = parentFolder(file.path);
      const leftEmpty =
        left !== '' &&
        !folders.some((folder) => atOrIn(folder, left)) &&
        ![...others.map((other) => other.path), path].some((other) => inFolder(other, left));
      this.checkCount(others.length + 1 + folders.length + (leftEmpty ? 1 : 0));
      await this.prisma.client.$transaction(async (tx) => {
        // Only while unlocked: a validation cannot lock it meanwhile.
        const updated = await tx.projectFile.updateMany({
          where: { id: file.id, lockedBySubmissionId: null },
          data: { path },
        });
        if (!updated.count) fail(HttpStatus.CONFLICT, 'file_locked');
        if (leftEmpty) await this.keepParents(tx, projectId, [file.path]);
        await tx.project.update({
          where: { id: projectId },
          data: {
            lastActivityAt: new Date(),
            ...(project.mainFilePath === file.path ? { mainFilePath: path } : {}),
          },
        });
        await this.followInSubmissions(tx, projectId, new Map([[file.path, path]]));
        await this.audit.write(tx, actor, 'FILE_MOVED', projectId, {
          fileId: file.id,
          from: file.path,
          to: path,
        });
      });
      return true;
    });
    if (moved) {
      await this.events.changed(projectId);
      await this.filesChanged(projectId);
    }
    return this.projects.detail(userId, projectId);
  }

  /** Renames or moves a folder with everything inside it, its empty folders included. */
  async moveFolder(
    actor: Actor,
    projectId: string,
    fromInput: string,
    toInput: string,
  ): Promise<ProjectDetail> {
    const userId = actor.userId!;
    const { project } = await this.projects.require(userId, projectId, 'edit');
    const from = normalizeProjectPath(fromInput);
    const to = normalizeProjectPath(toInput);
    if (!from || !to || atOrIn(to, from)) {
      if (from && from === to) return this.projects.detail(userId, projectId);
      return fail(HttpStatus.BAD_REQUEST, 'invalid_path');
    }
    const renamePath = (path: string) => `${to}${path.slice(from.length)}`;
    await this.projects.runWritable(project, async () => {
      const files = await this.paths(projectId);
      const folders = await this.keptFolders(projectId);
      const moved = files.filter((file) => inFolder(file.path, from));
      const movedFolders = folders.filter((folder) => atOrIn(folder, from));
      if (!moved.length && !movedFolders.length) return fail(HttpStatus.NOT_FOUND, 'not_found');
      if (moved.some((file) => file.lockedBySubmissionId)) fail(HttpStatus.CONFLICT, 'file_locked');
      const others = files.filter((file) => !inFolder(file.path, from)).map((file) => file.path);
      const otherFolders = folders.filter((folder) => !atOrIn(folder, from));
      const renamed = moved.map((file) => ({ file, path: renamePath(file.path) }));
      if (
        renamed.some(({ path }) => !normalizeFilePath(path)) ||
        movedFolders.some((folder) => !normalizeProjectPath(renamePath(folder)))
      ) {
        fail(HttpStatus.BAD_REQUEST, 'invalid_path');
      }
      if (pathConflicts(others, to, otherFolders)) fail(HttpStatus.CONFLICT, 'path_taken');
      // Kept folders afterwards: the others, the moved ones, the folder itself and the one left.
      const kept = new Set([...otherFolders, ...movedFolders.map(renamePath)]);
      const left = parentFolder(from);
      const leftEmpty =
        left !== '' &&
        ![...kept].some((folder) => atOrIn(folder, left)) &&
        ![...others, ...renamed.map(({ path }) => path)].some((path) => inFolder(path, left));
      if (leftEmpty) kept.add(left);
      this.checkCount(files.length + kept.size);
      const main = renamed.find(({ file }) => file.path === project.mainFilePath);
      await this.prisma.client.$transaction(async (tx) => {
        for (const { file, path } of renamed) {
          const updated = await tx.projectFile.updateMany({
            where: { id: file.id, lockedBySubmissionId: null },
            data: { path },
          });
          if (!updated.count) fail(HttpStatus.CONFLICT, 'file_locked');
        }
        await tx.projectFolder.deleteMany({
          where: { projectId, path: { in: movedFolders } },
        });
        await tx.projectFolder.createMany({
          // Kept folders follow (the folder itself when it was kept); a folder holding files exists
          // through them.
          data: movedFolders.map((folder) => ({ projectId, path: renamePath(folder) })),
          skipDuplicates: true,
        });
        if (leftEmpty) await this.keepParents(tx, projectId, [from]);
        await tx.project.update({
          where: { id: projectId },
          data: { lastActivityAt: new Date(), ...(main ? { mainFilePath: main.path } : {}) },
        });
        await this.followInSubmissions(
          tx,
          projectId,
          new Map(renamed.map(({ file, path }) => [file.path, path])),
        );
        await this.audit.write(tx, actor, 'FOLDER_MOVED', projectId, {
          from,
          to,
          files: renamed.length,
        });
      });
    });
    await this.events.changed(projectId);
    await this.filesChanged(projectId);
    return this.projects.detail(userId, projectId);
  }

  async remove(userId: string, projectId: string, fileId: string): Promise<ProjectDetail> {
    const { project } = await this.projects.require(userId, projectId, 'edit');
    // Under the owner lock, and only while unlocked: a validation cannot lock it meanwhile.
    const file = await this.projects.runWritable(project, async () => {
      const found = await this.file(project, fileId);
      await this.prisma.client.$transaction(async (tx) => {
        const deleted = await tx.projectFile.deleteMany({
          where: { id: found.id, lockedBySubmissionId: null },
        });
        if (!deleted.count) fail(HttpStatus.CONFLICT, 'file_locked');
        await this.keepParents(tx, projectId, [found.path]);
      });
      return found;
    });
    if (file.storageKey) await this.removeObjects([file.storageKey]);
    await this.events.publish({ type: 'file-deleted', projectId, fileId: file.id });
    await this.projects.touch(projectId);
    await this.events.changed(projectId);
    await this.filesChanged(projectId);
    return this.projects.detail(userId, projectId);
  }

  async removeFolder(userId: string, projectId: string, input: string): Promise<ProjectDetail> {
    const { project } = await this.projects.require(userId, projectId, 'edit');
    const folder = normalizeProjectPath(input);
    if (!folder) return fail(HttpStatus.BAD_REQUEST, 'invalid_path');
    // Under the owner lock: a validation cannot lock one of these files meanwhile.
    const files = await this.projects.runWritable(project, async () => {
      const found = (await this.paths(projectId)).filter((file) => inFolder(file.path, folder));
      const folders = (await this.keptFolders(projectId)).filter((path) => atOrIn(path, folder));
      if (!found.length && !folders.length) return fail(HttpStatus.NOT_FOUND, 'not_found');
      if (found.some((file) => file.lockedBySubmissionId)) fail(HttpStatus.CONFLICT, 'file_locked');
      await this.prisma.client.$transaction(async (tx) => {
        const deleted = await tx.projectFile.deleteMany({
          where: { id: { in: found.map((file) => file.id) }, lockedBySubmissionId: null },
        });
        if (deleted.count < found.length) fail(HttpStatus.CONFLICT, 'file_locked');
        await tx.projectFolder.deleteMany({ where: { projectId, path: { in: folders } } });
        await this.keepParents(tx, projectId, [folder]);
      });
      return found;
    });
    await this.removeObjects(files.flatMap((file) => (file.storageKey ? [file.storageKey] : [])));
    for (const file of files) {
      await this.events.publish({ type: 'file-deleted', projectId, fileId: file.id });
    }
    await this.projects.touch(projectId);
    await this.events.changed(projectId);
    await this.filesChanged(projectId);
    return this.projects.detail(userId, projectId);
  }

  /** Deletes objects whose rows are gone; a failure only leaves an orphan, purged with the project. */
  private async removeObjects(keys: string[]): Promise<void> {
    await this.storage
      .deleteKeys(PROJECTS_BUCKET, keys)
      .catch((error: unknown) => this.logger.warn({ err: error }, 'Object deletion failed'));
  }
}

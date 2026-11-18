import type { ProjectFile } from '@integris/db';
import {
  allowedExtensionOf,
  type FileSaved,
  isTextExtension,
  MAX_PROJECT_FILE_BYTES,
  normalizeFilePath,
  normalizeProjectPath,
  pathConflicts,
  type ProjectDetail,
  PROJECTS_BUCKET,
} from '@integris/shared';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { checkContent, isUtf8Text } from './file-content.js';
import { fail, ProjectsService } from './projects.service.js';

/** Binary formats that may be renamed into each other (same content). */
const sameFormat = (a: string, b: string) => {
  const family = (extension: string) => (extension === '.jpeg' ? '.jpg' : extension);
  return family(a) === family(b);
};

const inFolder = (path: string, folder: string) => path.startsWith(`${folder}/`);

/**
 * Version of a file's content, sent as `ETag` and expected back in `If-Match`. Every write stores
 * the content under a new object key, so the key identifies the content (a rename keeps it).
 */
export const contentTag = (file: Pick<ProjectFile, 'storageKey'>) =>
  `"${createHash('sha256')
    .update(file.storageKey ?? '')
    .digest('base64url')
    .slice(0, 32)}"`;

/** `If-Match` as sent by a browser or a proxy: compressing proxies turn strong tags into weak ones. */
const sameTag = (header: string, tag: string) =>
  header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .includes(tag);

/** A path taken by a parallel request (unique constraint) answers 409 like any other clash. */
const uniqueConflict = (error: unknown) =>
  (error as { code?: string }).code === 'P2002'
    ? new ApiError(HttpStatus.CONFLICT, 'path_taken')
    : error;

/**
 * Files of a project: every call checks the user's right on the project, the locks set by a
 * validated submission, the file rules of docs/spec.md and the storage quota of the owner.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly projects: ProjectsService,
    private readonly config: ApiConfig,
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

      await this.store(projectId, path, previous, check.kind, bytes);
    });
    await this.projects.touch(projectId);
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

  /** Content of a text file for the editor, with its version tag. Any role on the project reads. */
  async readText(
    userId: string,
    projectId: string,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; tag: string; writable: boolean }> {
    const { project, rights } = await this.projects.access(userId, projectId);
    const find = () =>
      this.prisma.client.projectFile.findFirst({ where: { id: fileId, projectId } });
    let file = await find();
    if (!file) return fail(HttpStatus.NOT_FOUND, 'not_found');
    if (file.kind !== 'TEXT') fail(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'not_text');
    let bytes: Uint8Array;
    try {
      bytes = file.storageKey
        ? await this.storage.get(PROJECTS_BUCKET, file.storageKey)
        : new Uint8Array();
    } catch {
      // A save replaced the object between the two reads: read the new version once.
      file = await find();
      if (!file) return fail(HttpStatus.NOT_FOUND, 'not_found');
      bytes = file.storageKey
        ? await this.storage.get(PROJECTS_BUCKET, file.storageKey)
        : new Uint8Array();
    }
    return {
      bytes,
      tag: contentTag(file),
      writable: rights.edit && !project.readOnlyReason && !file.lockedBySubmissionId,
    };
  }

  /**
   * Saves the content of a text file from the editor. `ifMatch` must be the version the editor
   * loaded or last saved: a file changed meanwhile (another tab, another member) answers 409
   * `edit_conflict` instead of being overwritten.
   */
  async writeText(
    userId: string,
    projectId: string,
    fileId: string,
    bytes: Uint8Array,
    ifMatch: string,
  ): Promise<FileSaved> {
    const { project } = await this.projects.require(userId, projectId, 'edit');
    if (bytes.length > MAX_PROJECT_FILE_BYTES) fail(HttpStatus.PAYLOAD_TOO_LARGE, 'file_too_large');
    if (!isUtf8Text(bytes)) fail(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_encoding');
    const saved = await this.projects.runLocked(project.ownerId, async () => {
      // Read again under the lock: the tag check and the write cannot interleave with another
      // save, and a project made read-only or trashed while this save waited is not written.
      const current = await this.prisma.client.project.findUnique({
        where: { id: projectId },
        select: { readOnlyReason: true, deletedAt: true },
      });
      if (!current || current.deletedAt) fail(HttpStatus.NOT_FOUND, 'not_found');
      if (current?.readOnlyReason) fail(HttpStatus.FORBIDDEN, 'read_only');
      const file = await this.file(projectId, fileId);
      if (file.kind !== 'TEXT') fail(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'not_text');
      if (!sameTag(ifMatch, contentTag(file))) fail(HttpStatus.CONFLICT, 'edit_conflict');
      await this.projects.checkStorageFor(project.ownerId, bytes.length - file.sizeBytes);
      return this.store(projectId, file.path, file, 'TEXT', bytes);
    });
    await this.projects.touch(projectId);
    return {
      etag: contentTag(saved),
      sizeBytes: saved.sizeBytes,
      updatedAt: saved.updatedAt.toISOString(),
    };
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
    return this.projects.detail(userId, projectId);
  }

  async remove(userId: string, projectId: string, fileId: string): Promise<ProjectDetail> {
    await this.projects.require(userId, projectId, 'edit');
    const file = await this.file(projectId, fileId);
    await this.prisma.client.projectFile.delete({ where: { id: file.id } });
    if (file.storageKey) await this.removeObjects([file.storageKey]);
    await this.projects.touch(projectId);
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
    await this.projects.touch(projectId);
    return this.projects.detail(userId, projectId);
  }

  /** Deletes objects whose rows are gone; a failure only leaves an orphan, purged with the project. */
  private async removeObjects(keys: string[]): Promise<void> {
    await this.storage
      .deleteKeys(PROJECTS_BUCKET, keys)
      .catch((error: unknown) => this.logger.warn({ err: error }, 'Object deletion failed'));
  }
}

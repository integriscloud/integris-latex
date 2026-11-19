import type { ProjectFile } from '@integris/db';
import {
  type AuthorizeRequest,
  type AuthorizeResponse,
  type LoadResponse,
  MAX_PROJECT_FILE_BYTES,
  presenceColorOf,
  PROJECTS_BUCKET,
  type StoreBlockCode,
  type StoreRequest,
  type StoreResponse,
} from '@integris/shared';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SessionService } from '../auth/session.service.js';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectEventsService } from '../projects/project-events.service.js';
import { fail, ProjectsService } from '../projects/projects.service.js';
import { StorageService } from '../storage/storage.service.js';

const decoder = new TextDecoder();

/** Code of an API error, or null for any other error (database or storage down). */
const codeOf = (error: unknown): string | null => {
  if (!(error instanceof ApiError)) return null;
  const body = error.getResponse() as { code?: string };
  return body.code ?? null;
};

/**
 * Business side of the collaboration server, reached through the internal API: who may open a
 * document and write to it, and how a document is loaded and stored. The collaboration server
 * holds no rule, no database access and no storage key.
 */
@Injectable()
export class CollabDocsService {
  private readonly logger = new Logger(CollabDocsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly projects: ProjectsService,
    private readonly sessions: SessionService,
    private readonly events: ProjectEventsService,
  ) {}

  /**
   * Checked on every WebSocket connection, and again periodically: a valid session of an
   * enabled user with a role on the project. Only the owner and editors write, and only to a
   * file that is not locked in a project that is not read-only.
   */
  async authorize(request: AuthorizeRequest): Promise<AuthorizeResponse> {
    // A periodic check does not count as activity: an idle tab lets the session expire.
    const session = request.recheck
      ? await this.sessions.peek(request.session)
      : await this.sessions.read(request.session);
    if (!session) return { ok: false };
    const user = await this.prisma.client.user.findUnique({ where: { id: session.userId } });
    if (!user || user.disabledAt) return { ok: false };
    let access: Awaited<ReturnType<ProjectsService['access']>>;
    try {
      access = await this.projects.access(user.id, request.projectId);
    } catch (error) {
      if (codeOf(error)) return { ok: false };
      throw error;
    }
    let locked = false;
    if (request.fileId) {
      const file = await this.prisma.client.projectFile.findFirst({
        where: { id: request.fileId, projectId: request.projectId },
      });
      if (!file || file.kind !== 'TEXT') return { ok: false };
      locked = file.lockedBySubmissionId !== null;
    }
    return {
      ok: true,
      user: {
        id: user.id,
        name: user.displayName,
        color: presenceColorOf(user.id),
        editor: access.rights.edit,
      },
      writable:
        request.fileId !== null && access.rights.edit && !access.project.readOnlyReason && !locked,
    };
  }

  private async textFile(projectId: string, fileId: string): Promise<ProjectFile> {
    const file = await this.prisma.client.projectFile.findFirst({
      where: { id: fileId, projectId },
    });
    if (!file || file.kind !== 'TEXT') return fail(HttpStatus.NOT_FOUND, 'not_found');
    return file;
  }

  private async readText(file: ProjectFile): Promise<string> {
    return file.storageKey
      ? decoder.decode(await this.storage.get(PROJECTS_BUCKET, file.storageKey))
      : '';
  }

  /** The stored state, and the text of storage when the state does not hold it. */
  async load(projectId: string, fileId: string): Promise<LoadResponse> {
    const file = await this.textFile(projectId, fileId);
    const document = await this.prisma.client.fileDocument.findUnique({ where: { fileId } });
    const state = document ? Buffer.from(document.state).toString('base64') : null;
    // A locked file always shows the text that was validated.
    if (document && document.syncedKey === file.storageKey && !file.lockedBySubmissionId) {
      return { state, text: null, key: file.storageKey };
    }
    return { state, text: await this.readText(file), key: file.storageKey };
  }

  /**
   * Stores a document, state and text, when the rules allow it: 10 MB per file and the storage
   * quota of the owner, in a project that is not read-only, for a file that is not locked.
   * Otherwise nothing is stored (the action is blocked, docs/spec.md "Dépassement"): the changes
   * stay in the open editors. Serialized with the other writes of the owner.
   */
  async store(request: StoreRequest): Promise<StoreResponse> {
    const project = await this.prisma.client.project.findUnique({
      where: { id: request.projectId },
    });
    if (!project || project.deletedAt) return { code: 'not_found', text: null, key: null };
    const state = Buffer.from(request.state, 'base64');
    try {
      return await this.projects.runLocked(project.ownerId, async () => {
        const file = await this.textFile(request.projectId, request.fileId);
        // Replaced outside the editor since this document last read or wrote it: the document
        // takes the new text first (as a diff), then stores again.
        if (file.storageKey !== request.baseKey) {
          return { code: null, text: await this.readText(file), key: file.storageKey };
        }
        const fresh = await this.prisma.client.project.findUnique({
          where: { id: request.projectId },
          select: { readOnlyReason: true },
        });
        const blocked = (code: StoreBlockCode): StoreResponse => ({
          code,
          text: null,
          key: file.storageKey,
        });
        if (fresh?.readOnlyReason) return blocked('read_only');
        if (file.lockedBySubmissionId) return blocked('file_locked');
        const bytes = new TextEncoder().encode(request.text);
        if (bytes.length > MAX_PROJECT_FILE_BYTES) return blocked('file_too_large');
        try {
          await this.projects.checkStorageFor(project.ownerId, bytes.length - file.sizeBytes);
        } catch (error) {
          if (codeOf(error) === 'storage_limit') return blocked('storage_limit');
          throw error;
        }
        const storageKey = this.projects.newKey(request.projectId);
        await this.storage.put(PROJECTS_BUCKET, storageKey, bytes);
        await this.prisma.client.projectFile.update({
          where: { id: file.id },
          data: { storageKey, sizeBytes: bytes.length },
        });
        await this.saveState(file.id, state, storageKey);
        if (file.storageKey) {
          await this.storage
            .deleteKeys(PROJECTS_BUCKET, [file.storageKey])
            .catch((error: unknown) => this.logger.warn({ err: error }, 'Object deletion failed'));
        }
        return { code: null, text: null, key: storageKey };
      });
    } catch (error) {
      const code = codeOf(error);
      if (code === 'not_found') return { code: 'not_found', text: null, key: null };
      // Owner lock busy, database or storage down: the document stays changed and is stored
      // again on the next change or flush.
      this.logger.warn({ err: error, fileId: request.fileId }, 'Document not stored');
      return { code: 'unavailable', text: null, key: request.baseKey };
    } finally {
      await this.projects.touch(request.projectId).catch(() => undefined);
      await this.events.changed(request.projectId);
    }
  }

  private saveState(fileId: string, state: Uint8Array, syncedKey: string | null) {
    const data = { state: new Uint8Array(state), syncedKey };
    return this.prisma.client.fileDocument.upsert({
      where: { fileId },
      create: { fileId, ...data },
      update: data,
    });
  }
}

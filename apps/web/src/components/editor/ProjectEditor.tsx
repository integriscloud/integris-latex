'use client';

import type { ProjectDetail, ProjectFileInfo } from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  buildFileTree,
  EditorLayout,
  type EditorPane,
  EmptyState,
  FileTree,
  IconButton,
  SaveStatus,
  type SaveStatusValue,
  Tabs,
  type TreeFile,
} from '@integris/ui';
import {
  ArrowLeft,
  Code,
  FileText,
  FolderTree,
  Lock,
  MessagesSquare,
  Play,
  Search,
  SquarePen,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiRequest, type ClientErrorCode } from '../../lib/api-client';
import { loadFile, saveFile } from '../../lib/editor/file-api';
import { textKindOf } from '../../lib/editor/language';
import { type OutlineEntry, parseOutline } from '../../lib/editor/outline';
import { SaveQueue, type SaveSnapshot, worstStatus } from '../../lib/editor/save-queue';
import { formatBytes } from '../../lib/format';
import { TextDialog } from '../app/dialogs';
import { useApiErrorMessage } from '../app/use-api-error';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { ConflictDialog } from './ConflictDialog';
import styles from './editor.module.css';
import { OutlinePanel } from './OutlinePanel';
import { ProjectSearch, type ReplaceReport } from './ProjectSearch';
import { useEditorPhrases } from './phrases';
import { useProjectIndex } from './use-project-index';

/** An open file: its first text and, when the user may write it, its save queue. */
interface Session {
  id: string;
  text: string;
  queue: SaveQueue | null;
}

/** First file shown: the one asked in the URL, else the main file, else the first text file. */
function firstFile(project: ProjectDetail, asked: string | null): string | null {
  const text = project.files.filter((file) => file.kind === 'TEXT');
  return (
    (
      text.find((file) => file.id === asked) ??
      text.find((file) => file.path === project.mainFilePath) ??
      text[0]
    )?.id ?? null
  );
}

/** Errors after which saving this file cannot succeed: the editor turns read-only. */
const BLOCKING = new Set(['forbidden', 'read_only', 'file_locked', 'not_found', 'not_text']);
const MOBILE_NOTICE_KEY = 'integris.editor.mobileNoticeClosed';
const SIDE_KEY = 'integris.editor.sideOpen';

const readFlag = (key: string) => {
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
};
const writeFlag = (key: string, value: boolean) => {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Not remembered: asked again on the next visit.
  }
};

/**
 * Editor of a project (step 5): files, CodeMirror, outline, search in the file and in the project.
 * Every change is saved to storage 2 s after the last keystroke (Ctrl+S at once), against the
 * version loaded. The PDF (step 6), collaborators (step 7), comments and submissions (steps 8–9)
 * only have their place here.
 */
export function ProjectEditor({
  initial,
  initialFileId,
}: {
  initial: ProjectDetail;
  initialFileId: string | null;
}) {
  const t = useTranslations('Editor');
  const locale = useLocale();
  const errorMessage = useApiErrorMessage(locale);
  const phrases = useEditorPhrases();
  const [project, setProject] = useState(initial);
  const canEdit = project.rights.edit && !project.readOnly;

  const editor = useRef<CodeEditorHandle>(null);
  /** Open files, for event handlers and save queues; `sessions` is the same for rendering. */
  const sessionsRef = useRef(new Map<string, Session>());
  const [sessions, setSessions] = useState<ReadonlyMap<string, Session>>(() => new Map());
  const [snapshots, setSnapshots] = useState<Record<string, SaveSnapshot>>({});
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(() => firstFile(initial, initialFileId));
  const [loadError, setLoadError] = useState<{ id: string; code: ClientErrorCode } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<EditorPane>('code');
  const [leftTab, setLeftTab] = useState('files');
  const [sideTab, setSideTab] = useState('comments');
  // The editor renders in the browser only: preferences are read at once.
  const [sideOpen, setSideOpen] = useState(() => readFlag(SIDE_KEY));
  const [mobileNotice, setMobileNotice] = useState(
    () => window.matchMedia('(max-width: 599.98px)').matches && !readFlag(MOBILE_NOTICE_KEY),
  );
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [newFile, setNewFile] = useState(false);
  /** Conflict whose dialog was closed with "later". */
  const [conflictLater, setConflictLater] = useState<string | null>(null);
  const pendingGoTo = useRef<{ line: number; column: number } | null>(null);
  const outlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const index = useProjectIndex(project.id, project.files);
  const filesById = useMemo(
    () => new Map(project.files.map((file) => [file.id, file])),
    [project.files],
  );
  const active = activeId ? filesById.get(activeId) : undefined;
  const activeSession = activeId ? sessions.get(activeId) : undefined;
  const activeKind = active ? textKindOf(active.path) : 'plain';
  const loading = activeId !== null && !activeSession && loadError?.id !== activeId;

  const projectHref = getPathname({ href: `/app/projects/${project.id}`, locale });
  const editorHref = getPathname({ href: `/app/projects/${project.id}/edit`, locale });
  const fileHref = useCallback(
    (id: string) => `${editorHref}?file=${encodeURIComponent(id)}`,
    [editorHref],
  );

  // ───────────── Outline ─────────────

  const refreshOutline = useCallback((path: string, text: string, delay: number) => {
    if (outlineTimer.current) clearTimeout(outlineTimer.current);
    outlineTimer.current = setTimeout(() => {
      setOutline(textKindOf(path) === 'latex' ? parseOutline(text) : []);
    }, delay);
  }, []);

  // ───────────── Opening files ─────────────

  const addSession = useCallback(
    (file: ProjectFileInfo, loaded: { text: string; etag: string; writable: boolean }) => {
      const { id } = file;
      const queue =
        loaded.writable && canEdit
          ? new SaveQueue({
              text: loaded.text,
              etag: loaded.etag,
              send: (text, etag) => saveFile(project.id, id, text, etag),
              onChange: (snapshot) => {
                setSnapshots((current) => ({ ...current, [id]: snapshot }));
                if (
                  snapshot.status === 'error' &&
                  snapshot.errorCode &&
                  BLOCKING.has(snapshot.errorCode)
                ) {
                  setBlocked((current) => new Set(current).add(id));
                }
              },
            })
          : null;
      sessionsRef.current.set(id, { id, text: loaded.text, queue });
      setSessions(new Map(sessionsRef.current));
      if (queue) setSnapshots((current) => ({ ...current, [id]: queue.snapshot }));
      index.update({ id, path: file.path, text: loaded.text }, null);
      refreshOutline(file.path, loaded.text, 0);
    },
    [canEdit, project.id, index, refreshOutline],
  );

  // The open file is read from storage the first time it is shown.
  useEffect(() => {
    if (!activeId || sessionsRef.current.has(activeId)) return;
    const file = filesById.get(activeId);
    if (!file) return;
    let cancelled = false;
    void loadFile(project.id, file.id).then((result) => {
      if (cancelled) return;
      if (result.ok) addSession(file, result);
      else setLoadError({ id: file.id, code: result.code });
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, attempt, filesById, project.id, addSession]);

  const openFile = useCallback(
    (id: string, at?: { line: number; column?: number }) => {
      const file = filesById.get(id);
      if (!file || file.kind !== 'TEXT') return;
      setActiveId(id);
      setView('code');
      setLoadError(null);
      pendingGoTo.current = at ? { line: at.line, column: at.column ?? 1 } : null;
      window.history.replaceState(window.history.state, '', fileHref(id));
      const session = sessionsRef.current.get(id);
      if (session) refreshOutline(file.path, index.textOf(id) ?? session.text, 0);
    },
    [filesById, fileHref, index, refreshOutline],
  );

  const retryOpen = () => {
    setLoadError(null);
    setAttempt((value) => value + 1);
  };

  // Go to a line asked by the outline or the search, once the file is shown.
  useEffect(() => {
    if (!activeSession || !pendingGoTo.current) return;
    const { line, column } = pendingGoTo.current;
    pendingGoTo.current = null;
    // After the editor has switched to this file (its effect runs first).
    requestAnimationFrame(() => editor.current?.goTo(line, column));
  });

  // ───────────── Editing and saving ─────────────

  const onChange = useCallback(
    (id: string, text: string) => {
      const file = filesById.get(id);
      if (!file) return;
      sessionsRef.current.get(id)?.queue?.edit(text);
      index.update({ id, path: file.path, text }, null);
      if (id === activeId) refreshOutline(file.path, text, 300);
    },
    [filesById, index, activeId, refreshOutline],
  );

  const saveAll = useCallback(() => {
    for (const session of sessionsRef.current.values()) session.queue?.saveNow();
  }, []);

  // Back online: send at once what is waiting.
  useEffect(() => {
    const online = () => {
      for (const session of sessionsRef.current.values()) session.queue?.online();
    };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, []);

  // Leaving with unsaved changes: the browser asks for confirmation.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ([...sessionsRef.current.values()].some((session) => session.queue?.dirty)) {
        event.preventDefault();
        // Older browsers need returnValue set.
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  useEffect(
    () => () => {
      for (const session of sessionsRef.current.values()) session.queue?.dispose();
      if (outlineTimer.current) clearTimeout(outlineTimer.current);
    },
    [],
  );

  const tracked = Object.entries(snapshots).filter(([id]) => sessions.get(id)?.queue);
  const status: SaveStatusValue = worstStatus(tracked.map(([, snapshot]) => snapshot.status));
  const conflictId = tracked.find(([, snapshot]) => snapshot.status === 'conflict')?.[0] ?? null;
  const failed = tracked.find(([, snapshot]) => snapshot.status === 'error');
  const offline = tracked.some(([, snapshot]) => snapshot.status === 'offline');

  // ───────────── Conflict ─────────────

  const resolveConflict = async (keepMine: boolean): Promise<string | null> => {
    if (!conflictId) return null;
    const session = sessionsRef.current.get(conflictId);
    const file = filesById.get(conflictId);
    if (!session?.queue || !file) return null;
    const stored = await loadFile(project.id, conflictId);
    if (!stored.ok) return errorMessage({ code: stored.code });
    if (keepMine) {
      session.queue.overwrite(stored.etag);
    } else {
      session.queue.reload(stored.text, stored.etag);
      editor.current?.setText(conflictId, stored.text);
      index.update({ id: conflictId, path: file.path, text: stored.text }, null);
      if (conflictId === activeId) refreshOutline(file.path, stored.text, 0);
    }
    return null;
  };

  // ───────────── Replace in the project ─────────────

  const replaceInProject = async (
    changes: {
      file: { id: string; path: string; etag: string | null };
      text: string;
      count: number;
    }[],
  ): Promise<ReplaceReport> => {
    const report: ReplaceReport = { replaced: 0, files: 0, failed: [] };
    for (const { file, text, count } of changes) {
      const session = sessionsRef.current.get(file.id);
      if (session) {
        // Open file: changed in its editor, saved like any edit (undo works).
        if (!session.queue || blocked.has(file.id)) {
          report.failed.push(file.path);
          continue;
        }
        editor.current?.setText(file.id, text);
        onChange(file.id, text);
      } else {
        const result = file.etag
          ? await saveFile(project.id, file.id, text, file.etag)
          : ({ ok: false, reason: 'conflict' } as const);
        if (!result.ok) {
          report.failed.push(file.path);
          continue;
        }
        index.update({ id: file.id, path: file.path, text }, result.etag);
      }
      report.replaced += count;
      report.files++;
    }
    return report;
  };

  // ───────────── Files ─────────────

  const tree = useMemo(
    () =>
      buildFileTree(
        project.files.map((file) => ({
          id: file.id,
          path: file.path,
          size: formatBytes(file.sizeBytes, locale),
          main: file.path === project.mainFilePath,
          locked: file.locked,
        })),
      ),
    [project.files, project.mainFilePath, locale],
  );

  // A file created in the dialog is opened once the project lists it.
  const created = useRef<string | null>(null);
  const createFile = async (path: string) => {
    const result = await apiRequest<ProjectDetail>('POST', `projects/${project.id}/files`, {
      path,
    });
    if (!result.ok) return errorMessage(result.error);
    created.current = result.data.files.find((file) => !filesById.has(file.id))?.id ?? null;
    setProject(result.data);
    return null;
  };

  useEffect(() => {
    if (!created.current || !filesById.has(created.current)) return;
    const id = created.current;
    created.current = null;
    openFile(id);
  }, [filesById, openFile]);

  // ───────────── Rendering ─────────────

  const readOnlyReason = !project.rights.edit
    ? t('readOnlyRole')
    : project.readOnly
      ? t('readOnlyProject')
      : active?.locked
        ? t('readOnlyLocked')
        : activeId && blocked.has(activeId)
          ? t('readOnlyRefused')
          : activeSession && !activeSession.queue
            ? t('readOnlyProject')
            : null;

  const statusLabels: Record<SaveStatusValue, string> = {
    saved: t('status.saved'),
    pending: t('status.pending'),
    saving: t('status.saving'),
    offline: t('status.offline'),
    conflict: t('status.conflict'),
    error: t('status.error'),
  };

  const closeMobileNotice = () => {
    setMobileNotice(false);
    writeFlag(MOBILE_NOTICE_KEY, true);
  };

  const toggleSide = () => {
    setSideOpen((open) => {
      writeFlag(SIDE_KEY, !open);
      return !open;
    });
  };

  const notices = (
    <>
      {mobileNotice && (
        <div className={styles.dismissible}>
          <Alert tone="info">{t('mobileNotice')}</Alert>
          <IconButton icon={X} label={t('closeNotice')} onClick={closeMobileNotice} />
        </div>
      )}
      {offline && <Alert tone="warning">{t('offline')}</Alert>}
      {conflictId && conflictLater === conflictId && (
        <Alert tone="error">
          {t('conflictNotice', { path: filesById.get(conflictId)?.path ?? '' })}{' '}
          <Button variant="secondary" onClick={() => setConflictLater(null)}>
            {t('conflictResolve')}
          </Button>
        </Alert>
      )}
      {failed && (
        <Alert tone="error">
          {t('saveFailed', {
            path: filesById.get(failed[0])?.path ?? '',
            message: errorMessage({ code: (failed[1].errorCode ?? 'unknown') as ClientErrorCode }),
          })}{' '}
          {failed[1].errorCode === 'storage_limit' && (
            <ButtonLink href={`${getPathname({ href: '/', locale })}#pricing`} variant="accent">
              {t('upgrade')}
            </ButtonLink>
          )}{' '}
          {!blocked.has(failed[0]) && (
            <Button
              variant="secondary"
              onClick={() => sessionsRef.current.get(failed[0])?.queue?.saveNow()}
            >
              {t('retry')}
            </Button>
          )}
        </Alert>
      )}
    </>
  );

  const textFileHref = (file: TreeFile) =>
    filesById.get(file.id)?.kind === 'TEXT' ? fileHref(file.id) : undefined;

  const filesPane = (
    <>
      <div className={styles.paneHead}>
        <div className={styles.tabs}>
          <Tabs
            label={t('leftTabs')}
            idPrefix="editor-left"
            value={leftTab}
            onChange={setLeftTab}
            items={[
              { id: 'files', label: t('files') },
              { id: 'outline', label: t('outline') },
              { id: 'search', label: t('search') },
            ]}
          />
        </div>
      </div>
      <div
        className={styles.paneBody}
        role="tabpanel"
        id={`editor-left-panel-${leftTab}`}
        aria-labelledby={`editor-left-tab-${leftTab}`}
      >
        {leftTab === 'files' && (
          <>
            <div className={styles.filesActions}>
              {canEdit && (
                <Button variant="secondary" onClick={() => setNewFile(true)}>
                  <SquarePen size={20} strokeWidth={1.75} aria-hidden="true" />
                  {t('newFile')}
                </Button>
              )}
              <a className={styles.manage} href={projectHref}>
                {t('manageFiles')}
              </a>
            </div>
            <FileTree
              label={t('filesLabel')}
              entries={tree}
              mainLabel={t('main')}
              lockedLabel={t('locked')}
              fileHref={textFileHref}
              onOpenFile={(file) => openFile(file.id)}
              activeId={activeId ?? undefined}
            />
          </>
        )}
        {leftTab === 'outline' && (
          <OutlinePanel
            available={activeKind === 'latex'}
            entries={outline}
            onGoTo={(line) => {
              setView('code');
              editor.current?.goTo(line);
            }}
          />
        )}
        {leftTab === 'search' && (
          <ProjectSearch
            editable={canEdit}
            load={index.load}
            indexed={index.indexed}
            onOpen={(id, line, column) => openFile(id, { line, column })}
            onReplace={replaceInProject}
          />
        )}
      </div>
    </>
  );

  const codePane = (
    <>
      <div className={styles.paneHead}>
        <p className={styles.path} title={active?.path}>
          {active?.path ?? t('noFile')}
        </p>
        {activeSession && (
          <IconButton
            icon={Search}
            label={t('searchInFile')}
            onClick={() => editor.current?.openSearch()}
          />
        )}
      </div>
      <div className={styles.codeBody}>
        {loadError && loadError.id === activeId ? (
          <div className={styles.padded}>
            <Alert tone="error">{errorMessage({ code: loadError.code })}</Alert>
            <Button variant="secondary" onClick={retryOpen}>
              {t('retry')}
            </Button>
          </div>
        ) : loading ? (
          <p className={styles.loading} role="status">
            {t('loading')}
          </p>
        ) : activeSession && active ? (
          <CodeEditor
            ref={editor}
            fileId={activeSession.id}
            path={active.path}
            initialText={activeSession.text}
            readOnly={Boolean(readOnlyReason)}
            lang={locale}
            label={t('codeLabel', { path: active.path })}
            phrases={phrases}
            completionLabels={{
              inFile: (path) => t('inFile', { path }),
              command: t('completionCommand'),
              environment: t('completionEnvironment'),
            }}
            symbols={index.symbols}
            index={index}
            onChange={onChange}
            onSave={saveAll}
          />
        ) : (
          <EmptyState icon={FileText} title={t('noFile')} text={t('noFileHint')} />
        )}
      </div>
    </>
  );

  const pdfPane = (
    <div className={styles.placeholder}>
      <EmptyState icon={FileText} title={t('pdfTitle')} text={t('pdfSoon')} />
    </div>
  );

  const sidePane = (
    <>
      <div className={styles.paneHead}>
        <div className={styles.tabs}>
          <Tabs
            label={t('sideTabs')}
            idPrefix="editor-side"
            value={sideTab}
            onChange={setSideTab}
            items={[
              { id: 'comments', label: t('comments') },
              { id: 'submissions', label: t('submissions') },
            ]}
          />
        </div>
      </div>
      <div
        className={styles.paneBody}
        role="tabpanel"
        id={`editor-side-panel-${sideTab}`}
        aria-labelledby={`editor-side-tab-${sideTab}`}
      >
        <EmptyState
          icon={MessagesSquare}
          title={sideTab === 'comments' ? t('comments') : t('submissions')}
          text={sideTab === 'comments' ? t('commentsSoon') : t('submissionsSoon')}
        />
      </div>
    </>
  );

  return (
    <>
      <EditorLayout
        back={
          <a className={styles.back} href={projectHref} aria-label={t('back')} title={t('back')}>
            <ArrowLeft size={20} strokeWidth={1.75} aria-hidden="true" />
          </a>
        }
        title={project.name}
        subtitle={
          <>
            {active && <span className={styles.subtitlePath}>{active.path}</span>}
            {readOnlyReason && (
              <span title={readOnlyReason}>
                <Badge icon={Lock}>{t('readOnly')}</Badge>
              </span>
            )}
          </>
        }
        status={tracked.length > 0 && <SaveStatus status={status} labels={statusLabels} />}
        actions={
          <>
            <Button disabled title={t('compileSoon')}>
              <Play size={20} strokeWidth={1.75} aria-hidden="true" />
              <span className={styles.compileLabel}>{t('compile')}</span>
            </Button>
            <IconButton
              icon={MessagesSquare}
              label={sideOpen ? t('hideSide') : t('showSide')}
              aria-pressed={sideOpen}
              className={styles.wideOnly}
              onClick={toggleSide}
            />
          </>
        }
        notice={
          (mobileNotice || offline || failed || conflictId || readOnlyReason) && (
            <div className={styles.notices}>
              {notices}
              {readOnlyReason && activeSession && <Alert tone="info">{readOnlyReason}</Alert>}
            </div>
          )
        }
        files={filesPane}
        code={codePane}
        pdf={pdfPane}
        side={sidePane}
        tabs={[
          { pane: 'files', label: t('files'), icon: FolderTree },
          { pane: 'code', label: t('code'), icon: Code },
          { pane: 'pdf', label: t('pdf'), icon: FileText },
          { pane: 'side', label: t('comments'), icon: MessagesSquare },
        ]}
        view={view}
        onViewChange={setView}
        sideOpen={sideOpen}
        labels={{
          tabs: t('panes'),
          resizeFiles: t('resizeFiles'),
          resizePdf: t('resizePdf'),
          resizeSide: t('resizeSide'),
        }}
      />
      <ConflictDialog
        open={conflictId !== null && conflictLater !== conflictId}
        path={conflictId ? (filesById.get(conflictId)?.path ?? '') : ''}
        onResolve={resolveConflict}
        onClose={() => setConflictLater(conflictId)}
      />
      <TextDialog
        open={newFile}
        title={t('newFileTitle')}
        label={t('newFilePath')}
        help={t('newFileHelp')}
        initial=""
        submitLabel={t('create')}
        onSubmit={createFile}
        onClose={() => setNewFile(false)}
      />
    </>
  );
}

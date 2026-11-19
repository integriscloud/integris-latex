'use client';

import type { ProjectDetail, UserPreferences } from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  buildFileTree,
  CompileButton,
  type CompileButtonState,
  EditorLayout,
  type EditorPane,
  EmptyState,
  FileTree,
  IconButton,
  MenuButton,
  PresenceList,
  type PresencePerson,
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
  LocateFixed,
  Lock,
  MessagesSquare,
  Search,
  Settings,
  SquarePen,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiRead, apiRequest, type ClientErrorCode } from '../../lib/api-client';
import { collabUrl, ProjectCollab } from '../../lib/collab/project-collab';
import { replaceText } from '../../lib/collab/text';
import { textKindOf } from '../../lib/editor/language';
import { type OutlineEntry, parseOutline } from '../../lib/editor/outline';
import { formatBytes } from '../../lib/format';
import { forwardSearch, inverseSearch, type PdfArea } from '../../lib/pdf/synctex';
import { TextDialog } from '../app/dialogs';
import { useApiErrorMessage } from '../app/use-api-error';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { CompileResult } from './CompileResult';
import styles from './editor.module.css';
import { HistoryPanel } from './HistoryPanel';
import { OutlinePanel } from './OutlinePanel';
import { PdfViewer } from './PdfViewer';
import { ProjectSearch, type ReplaceReport } from './ProjectSearch';
import { useEditorPhrases } from './phrases';
import { useCompiler } from './use-compiler';
import { useProjectIndex } from './use-project-index';

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
 * Editor of a project: files, CodeMirror, outline, search in the file and in the project (step 5),
 * compilation, PDF and SyncTeX (step 6), real-time collaboration and version history (step 7).
 * Open files are shared documents of the collaboration server, which writes them to storage a
 * few seconds after a change; changes typed offline stay in the page and are sent when the
 * network comes back. Ctrl+S and Ctrl+Enter store and compile. Comments and submissions
 * (steps 8–9) only have their place here.
 */
export function ProjectEditor({
  initial,
  initialFileId,
  initialSpellcheck,
}: {
  initial: ProjectDetail;
  initialFileId: string | null;
  /** Spell checker in the code, a setting of the user's account. */
  initialSpellcheck: boolean;
}) {
  const t = useTranslations('Editor');
  const locale = useLocale();
  const errorMessage = useApiErrorMessage(locale);
  const phrases = useEditorPhrases();
  const [project, setProject] = useState(initial);
  const canEdit = project.rights.edit && !project.readOnly;

  const editor = useRef<CodeEditorHandle>(null);
  // The editor renders in the browser only: the socket address is known at once.
  const [collab] = useState(() => new ProjectCollab(initial.id, collabUrl(window.location)));
  const live = useSyncExternalStore(collab.subscribe, collab.getSnapshot, collab.getSnapshot);
  const [activeId, setActiveId] = useState<string | null>(() => firstFile(initial, initialFileId));
  const [view, setView] = useState<EditorPane>('code');
  const [leftTab, setLeftTab] = useState('files');
  const [sideTab, setSideTab] = useState('comments');
  // The editor renders in the browser only: preferences are read at once.
  const [sideOpen, setSideOpen] = useState(() => readFlag(SIDE_KEY));
  const [mobileNotice, setMobileNotice] = useState(
    () => window.matchMedia('(max-width: 599.98px)').matches && !readFlag(MOBILE_NOTICE_KEY),
  );
  const [spellcheck, setSpellcheck] = useState(initialSpellcheck);
  const [settingsFailed, setSettingsFailed] = useState(false);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [newFile, setNewFile] = useState(false);
  const pendingGoTo = useRef<{ line: number; column: number } | null>(null);
  const [highlight, setHighlight] = useState<(PdfArea & { at: number }) | null>(null);
  const [syncMissed, setSyncMissed] = useState(false);
  const [resultHidden, setResultHidden] = useState(false);
  const outlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const index = useProjectIndex(project.id, project.files);
  const filesById = useMemo(
    () => new Map(project.files.map((file) => [file.id, file])),
    [project.files],
  );
  const active = activeId ? filesById.get(activeId) : undefined;
  const activeState = activeId ? live.files.get(activeId) : undefined;
  const activeSession = activeState?.synced ? collab.session(activeId!) : undefined;
  const activeKind = active ? textKindOf(active.path) : 'plain';
  const loading = activeId !== null && !activeSession && !activeState?.closed;

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

  // ───────────── Collaboration ─────────────

  // Connected while the editor is shown; the open files keep their changes across reconnections.
  useEffect(() => {
    collab.connect();
    return () => collab.disconnect();
  }, [collab]);

  // The shown file is opened on the collaboration server; the others see where we are.
  useEffect(() => {
    if (activeId && filesById.get(activeId)?.kind === 'TEXT') collab.open(activeId);
    collab.setActiveFile(activeId);
  }, [activeId, filesById, collab]);

  const latestText = useRef({ filesById, activeId });
  useLayoutEffect(() => {
    latestText.current = { filesById, activeId };
  });

  const openFile = useCallback(
    (id: string, at?: { line: number; column?: number }) => {
      const file = filesById.get(id);
      if (!file || file.kind !== 'TEXT') return;
      setActiveId(id);
      setView('code');
      pendingGoTo.current = at ? { line: at.line, column: at.column ?? 1 } : null;
      window.history.replaceState(window.history.state, '', fileHref(id));
      const text = index.textOf(id);
      if (text !== undefined) refreshOutline(file.path, text, 0);
    },
    [filesById, fileHref, index, refreshOutline],
  );

  // Go to a line asked by the outline or the search, once the file is shown.
  useEffect(() => {
    if (!activeSession || !pendingGoTo.current) return;
    const { line, column } = pendingGoTo.current;
    pendingGoTo.current = null;
    // After the editor has switched to this file (its effect runs first).
    requestAnimationFrame(() => editor.current?.goTo(line, column));
  });

  // ───────────── Compiling ─────────────

  /** Writes every open file to storage now; true when all of them are stored. */
  const flushAll = useCallback(async () => (await collab.flush()).ok, [collab]);

  const compiler = useCompiler(project.id, flushAll);
  const { compile, edited } = compiler;

  // Ctrl+Enter and Ctrl+S outside the code editor (which handles them itself).
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey)) return;
      if (event.key !== 'Enter' && event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void compile();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [compile]);

  // ───────────── Editing and saving ─────────────

  // Texts of the open files, changed here or by the others: index, outline, and automatic
  // compilation after one's own typing only (the others compile on their side).
  useEffect(
    () =>
      collab.onText((id, text, local) => {
        const { filesById: files, activeId: shown } = latestText.current;
        const file = files.get(id);
        if (!file) return;
        index.update({ id, path: file.path, text });
        if (id === shown) refreshOutline(file.path, text, local ? 300 : 0);
        if (local) edited();
      }),
    [collab, index, refreshOutline, edited],
  );

  // Leaving with changes the server has not received, or reloading while the network is gone
  // (the page would not come back: the browser would show its offline page instead of the
  // editor): the browser asks for confirmation.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (collab.hasUnsyncedChanges() || collab.isCutOff()) {
        event.preventDefault();
        // Older browsers need returnValue set.
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [collab]);

  useEffect(
    () => () => {
      if (outlineTimer.current) clearTimeout(outlineTimer.current);
    },
    [],
  );

  /** Files of the project read again (restoration, file deleted by someone else). */
  const reloadProject = useCallback(async () => {
    const result = await apiRead<ProjectDetail>(`projects/${project.id}`);
    if (!result.ok) return;
    setProject(result.data);
    setActiveId((current) =>
      current && result.data.files.some((file) => file.id === current)
        ? current
        : firstFile(result.data, null),
    );
  }, [project.id]);

  // A file deleted elsewhere: the list of files is read again.
  useEffect(() => collab.onDeleted(() => void reloadProject()), [collab, reloadProject]);

  const tracked = [...live.files].filter(([, file]) => file.writable || file.unsynced > 0);
  const failed = tracked.find(([, file]) => file.storeCode && file.storeCode !== 'unavailable');
  const lost = tracked.some(([, file]) => !file.writable && file.unsynced > 0);
  const offline = !live.connected && tracked.length > 0;
  const status: SaveStatusValue =
    failed || lost
      ? 'error'
      : offline
        ? 'offline'
        : tracked.some(([, file]) => file.unsynced > 0)
          ? 'saving'
          : tracked.some(([, file]) => file.storeCode === 'unavailable')
            ? 'pending'
            : 'saved';

  // People online in the project (once each), in the color of their cursor.
  const people = useMemo(() => {
    const seen = new Set<string>(live.me ? [live.me.id] : []);
    const list: PresencePerson[] = [];
    for (const peer of live.peers) {
      if (seen.has(peer.user.id)) continue;
      seen.add(peer.user.id);
      const path = peer.fileId ? filesById.get(peer.fileId)?.path : undefined;
      list.push({
        key: String(peer.clientId),
        name: peer.user.name,
        color: peer.user.colorIndex,
        detail: path,
      });
    }
    return list;
  }, [live.peers, live.me, filesById]);

  // ───────────── Replace in the project ─────────────

  const replaceInProject = async (
    changes: { file: { id: string; path: string; text: string }; text: string; count: number }[],
  ): Promise<ReplaceReport> => {
    const report: ReplaceReport = { replaced: 0, files: 0, failed: [] };
    for (const { file, text, count } of changes) {
      // Every file changes through its shared text, like any edit (undo works, the others see
      // it). A text changed since the search (by someone else) is left as it is.
      const session = await collab.whenSynced(file.id).catch(() => null);
      const shared = session?.shared.text;
      if (!session?.snapshot.writable || !shared || shared.toString() !== file.text) {
        report.failed.push(file.path);
        continue;
      }
      replaceText(shared, text);
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

  // ───────────── Compilation and SyncTeX ─────────────

  const { state: compileState, current: compilation } = compiler;
  const lastPdf = compileState?.lastPdf ?? null;
  const finished =
    compilation && compilation.status !== 'QUEUED' && compilation.status !== 'RUNNING';
  const showResult = finished && compilation.outcome && !resultHidden ? compilation : null;

  const filesByPath = useMemo(
    () => new Map(project.files.map((file) => [file.path, file])),
    [project.files],
  );

  /** Opens a project file at a line (an issue, a double-click in the PDF). */
  const openAt = useCallback(
    (path: string, line: number) => {
      const file = filesByPath.get(path);
      if (!file || file.kind !== 'TEXT') return false;
      openFile(file.id, { line });
      return true;
    },
    [filesByPath, openFile],
  );

  const showInPdf = () => {
    const line = editor.current?.cursorLine();
    const area =
      compiler.synctex && active && line
        ? forwardSearch(compiler.synctex, active.path, line)
        : null;
    setSyncMissed(!area);
    if (area) {
      setHighlight({ ...area, at: Date.now() });
      setView('pdf');
    }
  };

  const showInCode = (page: number, x: number, y: number) => {
    const found = compiler.synctex ? inverseSearch(compiler.synctex, page, x, y) : null;
    if (found) openAt(found.path, found.line);
  };

  /** Kept on the account: the same choice on every device. Undone when it cannot be saved. */
  const changeSpellcheck = async (on: boolean) => {
    setSpellcheck(on);
    setSettingsFailed(false);
    const result = await apiRequest<UserPreferences>('PATCH', 'auth/preferences', {
      editorSpellcheck: on,
    });
    if (result.ok) {
      setSpellcheck(result.data.editorSpellcheck);
    } else {
      setSpellcheck(!on);
      setSettingsFailed(true);
    }
  };

  const changeEngine = async (engine: ProjectDetail['engine']) => {
    const result = await apiRequest<ProjectDetail>('PATCH', `projects/${project.id}`, { engine });
    if (result.ok) setProject(result.data);
  };

  const running = compilation?.status === 'RUNNING';
  const queued = compilation?.status === 'QUEUED';
  const buttonState: CompileButtonState = running
    ? 'running'
    : queued
      ? 'queued'
      : compiler.changed
        ? 'changed'
        : finished && compilation.errorCount > 0
          ? 'failed'
          : 'idle';
  const buttonLabel =
    buttonState === 'running'
      ? t('compileRunning', { seconds: compiler.elapsed })
      : buttonState === 'queued'
        ? t('compileQueued', { position: compilation?.position ?? 1 })
        : buttonState === 'failed'
          ? t('compileErrors', { count: compilation?.errorCount ?? 0 })
          : t('compileAction');

  const compileMenu = (
    <>
      {canEdit && (
        <fieldset className={styles.engines}>
          <legend>{t('engine')}</legend>
          {(['PDFLATEX', 'XELATEX', 'LUALATEX'] as const).map((engine) => (
            <label key={engine} className={styles.choice}>
              <input
                type="radio"
                name="engine"
                checked={project.engine === engine}
                onChange={() => void changeEngine(engine)}
              />
              {{ PDFLATEX: 'pdfLaTeX', XELATEX: 'XeLaTeX', LUALATEX: 'LuaLaTeX' }[engine]}
            </label>
          ))}
          <p className={styles.menuHelp}>{t('engineHelp')}</p>
        </fieldset>
      )}
      {compileState?.canCompile &&
        (compileState.autoCompile ? (
          <label className={styles.choice}>
            <input
              type="checkbox"
              checked={compiler.autoEnabled}
              onChange={(event) => compiler.setAutoEnabled(event.target.checked)}
            />
            {t('autoCompile')}
          </label>
        ) : (
          <p className={styles.menuHelp}>
            {t('autoCompileFree')}{' '}
            <a href={`${getPathname({ href: '/', locale })}#pricing`}>{t('upgrade')}</a>
          </p>
        ))}
      {compileState && !compileState.canCompile && (
        <p className={styles.menuHelp}>{t('compileReadOnly')}</p>
      )}
      {compileState && (
        <p className={styles.menuHelp}>
          {t('compileLimits', {
            seconds: compileState.maxSeconds,
            perHour: compileState.maxPerHour,
          })}
        </p>
      )}
      {finished && compilation.outcome && resultHidden && (
        <Button variant="secondary" onClick={() => setResultHidden(false)}>
          {t('showIssues')}
        </Button>
      )}
      {showResult && (
        <Button variant="secondary" onClick={() => setResultHidden(true)}>
          {t('hideIssues')}
        </Button>
      )}
    </>
  );

  const requestError = compiler.requestError;
  const compileNotice = requestError && (
    <Alert tone="error">
      {requestError.code === 'compile_limit'
        ? t('compileLimit', {
            perHour: compileState?.maxPerHour ?? 0,
            minutes: Math.max(1, Math.ceil((requestError.retryAfter ?? 60) / 60)),
          })
        : errorMessage(requestError)}{' '}
      {requestError.code === 'compile_limit' && (
        <ButtonLink href={`${getPathname({ href: '/', locale })}#pricing`} variant="accent">
          {t('upgrade')}
        </ButtonLink>
      )}
    </Alert>
  );

  // ───────────── Rendering ─────────────

  const readOnlyReason = !project.rights.edit
    ? t('readOnlyRole')
    : project.readOnly
      ? t('readOnlyProject')
      : active?.locked
        ? t('readOnlyLocked')
        : activeState?.closed === 'revoked'
          ? t('accessLost')
          : activeState?.synced && !activeState.writable
            ? activeState.unsynced > 0
              ? t('readOnlyRefused')
              : t('readOnlyProject')
            : null;

  const statusLabels: Record<SaveStatusValue, string> = {
    saved: t('status.saved'),
    pending: t('status.pending'),
    saving: t('status.saving'),
    offline: t('status.offline'),
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
      {failed && (
        <Alert tone="error">
          {t('saveFailed', {
            path: filesById.get(failed[0])?.path ?? '',
            message: errorMessage({ code: failed[1].storeCode as ClientErrorCode }),
          })}{' '}
          {failed[1].storeCode === 'storage_limit' && (
            <ButtonLink href={`${getPathname({ href: '/', locale })}#pricing`} variant="accent">
              {t('upgrade')}
            </ButtonLink>
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
        {activeSession && compiler.synctex && activeKind === 'latex' && (
          <IconButton icon={LocateFixed} label={t('syncToPdf')} onClick={showInPdf} />
        )}
        {activeSession && (
          <IconButton
            icon={Search}
            label={t('searchInFile')}
            onClick={() => editor.current?.openSearch()}
          />
        )}
      </div>
      <div className={styles.codeBody}>
        {activeState?.closed && !activeSession ? (
          <div className={styles.padded}>
            <Alert tone="error">
              {activeState.closed === 'deleted' ? t('fileDeleted') : t('accessLost')}
            </Alert>
            <Button variant="secondary" onClick={() => window.location.reload()}>
              {t('reload')}
            </Button>
          </div>
        ) : loading ? (
          <p className={styles.loading} role="status">
            {live.connected ? t('loading') : t('connecting')}
          </p>
        ) : activeSession && active ? (
          <CodeEditor
            ref={editor}
            fileId={activeSession.fileId}
            path={active.path}
            shared={activeSession.shared}
            readOnly={Boolean(readOnlyReason) || !activeState?.writable}
            spellcheck={spellcheck}
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
            onCompile={() => void compile()}
          />
        ) : (
          <EmptyState icon={FileText} title={t('noFile')} text={t('noFileHint')} />
        )}
      </div>
    </>
  );

  const pdfPane = (
    <div className={styles.pdfPane}>
      {showResult && (
        <CompileResult projectId={project.id} compilation={showResult} onOpen={openAt} />
      )}
      {syncMissed && (
        <div className={styles.notices}>
          <Alert tone="info">{t('syncNotFound')}</Alert>
        </div>
      )}
      <div className={styles.pdfBody}>
        {lastPdf?.pdf ? (
          <PdfViewer
            documentKey={lastPdf.id}
            url={lastPdf.pdf.url}
            downloadUrl={lastPdf.pdf.downloadUrl}
            highlight={highlight}
            onInverse={compiler.synctex ? showInCode : undefined}
            labels={{
              toolbar: t('pdfViewer.toolbar'),
              previous: t('pdfViewer.previous'),
              next: t('pdfViewer.next'),
              page: (page, pages) => t('pdfViewer.page', { page, pages }),
              pageLabel: (page) => t('pdfViewer.pageLabel', { page }),
              zoomIn: t('pdfViewer.zoomIn'),
              zoomOut: t('pdfViewer.zoomOut'),
              fit: t('pdfViewer.fit'),
              download: t('pdfViewer.download'),
              loading: t('pdfViewer.loading'),
              failed: t('pdfViewer.failed'),
              retry: t('retry'),
            }}
          />
        ) : (
          <div className={styles.placeholder}>
            <EmptyState
              icon={FileText}
              title={t('pdfEmpty')}
              text={compileState?.canCompile === false ? t('pdfEmptyReader') : t('pdfEmptyHint')}
            />
          </div>
        )}
      </div>
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
              { id: 'history', label: t('history') },
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
        {sideTab === 'history' ? (
          <HistoryPanel
            projectId={project.id}
            flush={flushAll}
            onRestored={() => void reloadProject()}
          />
        ) : (
          <EmptyState
            icon={MessagesSquare}
            title={sideTab === 'comments' ? t('comments') : t('submissions')}
            text={sideTab === 'comments' ? t('commentsSoon') : t('submissionsSoon')}
          />
        )}
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
            <PresenceList
              people={people}
              label={t('online')}
              moreLabel={(count) => t('onlineMore', { count })}
            />
            <CompileButton
              state={buttonState}
              label={buttonLabel}
              actionLabel={t('compileAction')}
              onCompile={() => void compile()}
              disabled={!compileState?.canCompile || compiler.sending}
              menuLabel={t('compileMenu')}
              menu={compileMenu}
            />
            <MenuButton icon={Settings} label={t('settings')}>
              <label className={styles.choice}>
                <input
                  type="checkbox"
                  checked={spellcheck}
                  onChange={(event) => void changeSpellcheck(event.target.checked)}
                />
                {t('spellcheck')}
              </label>
              <p className={styles.menuHelp}>{t('spellcheckHelp')}</p>
              {settingsFailed && (
                <p className={styles.menuHelp} role="alert">
                  {t('settingsFailed')}
                </p>
              )}
            </MenuButton>
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
          (mobileNotice || offline || failed || readOnlyReason || compileNotice) && (
            <div className={styles.notices}>
              {notices}
              {compileNotice}
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

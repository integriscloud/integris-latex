'use client';

import {
  COMMENT_LIMITS,
  type CommentInfo,
  MAX_PROJECT_FILE_BYTES,
  parentFolder,
  type ProjectDetail,
  type UserPreferences,
} from '@integris/shared';
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
  Download,
  FileText,
  FolderPlus,
  FolderTree,
  LocateFixed,
  Lock,
  MessageSquarePlus,
  MessagesSquare,
  Search,
  Settings,
  Share2,
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
import { apiRead, apiRequest, type ApiResult, type ClientErrorCode } from '../../lib/api-client';
import { anchorOf, rangeOf } from '../../lib/collab/anchors';
import { collabUrl, ProjectCollab } from '../../lib/collab/project-collab';
import { loadSubmission } from '../../lib/submissions/api';
import { replaceText } from '../../lib/collab/text';
import { textKindOf } from '../../lib/editor/language';
import type { LineSelection } from '../../lib/editor/line-comment';
import { type OutlineEntry, parseOutline } from '../../lib/editor/outline';
import { formatBytes } from '../../lib/format';
import { forwardSearch, inverseSearch, type PdfArea } from '../../lib/pdf/synctex';
import { useProjectDownload } from '../app/file-ops';
import { useFileTreeActions } from '../app/file-tree-actions';
import { useApiErrorMessage } from '../app/use-api-error';
import { ShareDialog } from '../sharing/ShareDialog';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { type CommentDraft, CommentsPanel } from './CommentsPanel';
import { CompileResult } from './CompileResult';
import styles from './editor.module.css';
import { HistoryPanel } from './HistoryPanel';
import { OutlinePanel } from './OutlinePanel';
import { PdfViewer } from './PdfViewer';
import { SubmissionsPanel } from '../submissions/SubmissionsPanel';
import { ProjectSearch, type ReplaceReport } from './ProjectSearch';
import { useEditorPhrases } from './phrases';
import { useCompiler } from './use-compiler';
import { useComments } from './use-comments';
import { useProjectIndex } from './use-project-index';
import { useWordCount } from './use-word-count';

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

const isPhone = () => window.matchMedia('(max-width: 599.98px)').matches;

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
 * network comes back. Ctrl+S and Ctrl+Enter store and compile. Sharing and comments anchored
 * to the text (step 8); submissions to supervisors (step 9).
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
  const tOps = useTranslations('FileOps');
  const ts = useTranslations('Submissions');
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
  const pendingGoTo = useRef<{ line: number; column: number } | null>(null);
  const [highlight, setHighlight] = useState<(PdfArea & { at: number }) | null>(null);
  const [syncMissed, setSyncMissed] = useState(false);
  const [resultHidden, setResultHidden] = useState(false);
  const outlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [commentHint, setCommentHint] = useState<string | null>(null);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const pendingShow = useRef<string | null>(null);
  // A file just locked by a validation: the version saved before its files were put back.
  const [lockNotice, setLockNotice] = useState<{ versionId: string; label: string } | null>(null);
  const [historyFocus, setHistoryFocus] = useState<string | null>(null);

  const index = useProjectIndex(project.id, project.files);
  const wordCount = useWordCount(project.id, project.files, project.mainFilePath, index);
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
  const submissionHref = useCallback(
    (id: string) => getPathname({ href: `/app/projects/${project.id}/submissions/${id}`, locale }),
    [project.id, locale],
  );
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

  // The open files are written to storage first: the archive holds what was typed.
  const download = useProjectDownload(project.id, flushAll);
  // Owner and editors download the project, read-only projects included (reading).
  const canDownload = project.role === 'OWNER' || project.role === 'EDITOR';

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

  // A file locked by a validation was opened again with the validated text: the changes not
  // stored were dropped, and the version saved before the validation is shown.
  useEffect(
    () =>
      collab.onLocked(() => {
        void apiRead<ProjectDetail>(`projects/${project.id}`).then(async (result) => {
          if (!result.ok) return;
          setProject(result.data);
          const ids = new Set(result.data.files.flatMap((file) => file.lockedBy ?? []));
          for (const id of ids) {
            const detail = await loadSubmission(project.id, id);
            if (!detail.ok) continue;
            const validated = [...detail.data.events]
              .reverse()
              .find((event) => event.action === 'SUBMISSION_VALIDATED');
            if (validated?.beforeVersionId && validated.beforeVersionLabel) {
              setLockNotice({
                versionId: validated.beforeVersionId,
                label: validated.beforeVersionLabel,
              });
              return;
            }
          }
        });
      }),
    [collab, project.id],
  );

  // The owner changed a role: the rights shown here follow (the servers already apply them).
  useEffect(
    () =>
      collab.onProjectChange((change) => {
        // Rights changed, or files created, moved or deleted by someone else.
        if (change === 'access' || change === 'files') void reloadProject();
      }),
    [collab, reloadProject],
  );

  // ───────────── Comments ─────────────

  const commentsState = useComments(project.id, collab);
  const comments = commentsState.comments;

  // Places of the comments of the open file, computed again after each change of its text
  // (once per frame): the anchors follow the text whoever changes it.
  const [textVersion, setTextVersion] = useState(0);
  useEffect(() => {
    let frame = 0;
    const stop = collab.onText((id) => {
      if (id !== latestText.current.activeId || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setTextVersion((version) => version + 1);
      });
    });
    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, [collab]);

  const ranges = useMemo(() => {
    const places = new Map<string, { from: number; to: number } | null>();
    const text = activeSession?.shared.text;
    if (!text || !comments) return places;
    for (const comment of comments) {
      if (comment.fileId === activeSession.fileId) {
        places.set(comment.id, rangeOf(text, comment.anchor));
      }
    }
    return places;
    // textVersion: the shared text changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, activeSession, textVersion]);

  const marks = useMemo(
    () =>
      (comments ?? [])
        .filter((comment) => comment.status === 'OPEN' && ranges.get(comment.id))
        .map((comment) => ({
          id: comment.id,
          ...ranges.get(comment.id)!,
          active: comment.id === activeComment,
        })),
    [comments, ranges, activeComment],
  );

  const tracked = [...live.files].filter(
    ([, file]) => file.writable || (file.edited && file.unsynced > 0),
  );
  const failed = tracked.find(([, file]) => file.storeCode && file.storeCode !== 'unavailable');
  // Typed here, then refused: the server took the right to write away meanwhile.
  const lost = tracked.some(([, file]) => !file.writable && file.edited && file.unsynced > 0);
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

  const openComments = () => {
    setSideTab('comments');
    if (isPhone()) {
      setView('side');
    } else if (!sideOpen) {
      setSideOpen(true);
      writeFlag(SIDE_KEY, true);
    }
  };

  /** Starts a comment on the selection of the code. */
  const requestDraft = () => {
    const selection = editor.current?.selection();
    setCommentHint(null);
    if (!selection || !activeSession) {
      setCommentHint(t('commentSelectFirst'));
    } else if (selection.text.length > COMMENT_LIMITS.quoted) {
      setCommentHint(t('commentTooLong', { max: COMMENT_LIMITS.quoted }));
    } else {
      setDraft({
        fileId: activeSession.fileId,
        quotedText: selection.text,
        anchor: anchorOf(activeSession.shared.text, selection.from, selection.to),
      });
    }
    openComments();
  };

  /** Comments a whole line ("+" in the margin, long press on phones). */
  const commentLine = (line: LineSelection | null) => {
    setCommentHint(null);
    if (!line || !activeSession) {
      setCommentHint(t('commentEmptyLine'));
    } else if (line.text.length > COMMENT_LIMITS.quoted) {
      setCommentHint(t('commentTooLong', { max: COMMENT_LIMITS.quoted }));
    } else {
      setDraft({
        fileId: activeSession.fileId,
        quotedText: line.text,
        anchor: anchorOf(activeSession.shared.text, line.from, line.to),
      });
    }
    openComments();
  };

  /** Shows the text of a comment in the code (opening its file first when needed). */
  const showComment = (comment: CommentInfo) => {
    setActiveComment(comment.id);
    if (!comment.fileId) return;
    if (comment.fileId !== activeId) {
      pendingShow.current = comment.id;
      openFile(comment.fileId);
      return;
    }
    const range = ranges.get(comment.id);
    setView('code');
    if (range) requestAnimationFrame(() => editor.current?.select(range.from, range.to));
  };

  // A comment of another file is shown once that file is open.
  useEffect(() => {
    const id = pendingShow.current;
    if (!id || !activeSession) return;
    pendingShow.current = null;
    const comment = comments?.find((item) => item.id === id);
    const range = comment ? rangeOf(activeSession.shared.text, comment.anchor) : null;
    if (range) requestAnimationFrame(() => editor.current?.select(range.from, range.to));
  });

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
        project.folders,
      ),
    [project.files, project.folders, project.mainFilePath, locale],
  );

  /** Applies an answer carrying the project: the open file stays open while it exists. */
  const apply = (result: ApiResult<ProjectDetail>) => {
    if (!result.ok) return errorMessage(result.error);
    setProject(result.data);
    setActiveId((current) =>
      current && result.data.files.some((file) => file.id === current)
        ? current
        : firstFile(result.data, null),
    );
    return null;
  };

  // A file created from the tree is opened once the project lists it.
  const created = useRef<string | null>(null);
  const files = useFileTreeActions({
    project,
    apply,
    canEdit,
    maxFileBytes: MAX_PROJECT_FILE_BYTES,
    fallbackFolder: active ? parentFolder(active.path) : '',
    onCreated: (file) => {
      if (file.kind === 'TEXT') created.current = file.id;
    },
  });

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
      {/* The plan of the owner: given to the owner and editors only. */}
      {compileState?.maxSeconds && compileState.maxPerHour && (
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
    ? project.rights.comment
      ? t('readOnlyCommenter')
      : t('readOnlyRole')
    : project.readOnly
      ? t('readOnlyProject')
      : active?.locked
        ? t('readOnlyLocked')
        : activeState?.closed === 'revoked'
          ? t('accessLost')
          : activeState?.synced && !activeState.writable
            ? activeState.edited && activeState.unsynced > 0
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

  /** Opens the history on a version (side pane, or its view on phones). */
  const showVersion = (versionId: string) => {
    setHistoryFocus(versionId);
    setSideTab('history');
    if (isPhone()) {
      setView('side');
    } else if (!sideOpen) {
      setSideOpen(true);
      writeFlag(SIDE_KEY, true);
    }
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
      {lockNotice && (
        <div className={styles.dismissible}>
          <Alert tone="info">
            {ts('restoredNotice', { label: lockNotice.label })}{' '}
            <Button variant="ghost" onClick={() => showVersion(lockNotice.versionId)}>
              {t('showBeforeValidation', { label: lockNotice.label })}
            </Button>
          </Alert>
          <IconButton icon={X} label={t('closeNotice')} onClick={() => setLockNotice(null)} />
        </div>
      )}
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
                <>
                  <Button variant="secondary" onClick={files.newFile}>
                    <SquarePen size={20} strokeWidth={1.75} aria-hidden="true" />
                    {tOps('newFile')}
                  </Button>
                  <Button variant="secondary" onClick={files.newFolder}>
                    <FolderPlus size={20} strokeWidth={1.75} aria-hidden="true" />
                    {tOps('newFolder')}
                  </Button>
                </>
              )}
              <a className={styles.manage} href={projectHref}>
                {t('manageFiles')}
              </a>
            </div>
            {files.status}
            <FileTree
              label={t('filesLabel')}
              entries={tree}
              mainLabel={t('main')}
              lockedLabel={t('locked')}
              fileHref={textFileHref}
              onOpenFile={(file) => {
                // The folder of the open file becomes the current folder.
                files.selectFolder(null);
                openFile(file.id);
              }}
              activeId={activeId ?? undefined}
              rootLabel={tOps('root')}
              {...files.treeProps}
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
        {activeSession && project.rights.comment && (
          <IconButton
            icon={MessageSquarePlus}
            label={t('commentSelection')}
            onClick={requestDraft}
          />
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
            selectable={project.rights.comment}
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
            marks={marks}
            onCommentLine={project.rights.comment ? commentLine : undefined}
            commentLineLabel={(line) => t('commentLine', { line })}
            onMarkClick={(id) => {
              setActiveComment(id);
              if (!isPhone()) openComments();
            }}
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
            key={historyFocus ?? ''}
            projectId={project.id}
            initialSelected={historyFocus}
            flush={flushAll}
            onRestored={() => void reloadProject()}
          />
        ) : sideTab === 'comments' ? (
          <CommentsPanel
            projectId={project.id}
            collab={collab}
            rights={project.rights}
            readOnly={project.readOnly}
            files={filesById}
            activeFileId={activeId}
            comments={comments}
            error={commentsState.error}
            ranges={ranges}
            activeCommentId={activeComment}
            meId={live.me?.id ?? null}
            draft={draft}
            hint={commentHint}
            onRequestDraft={requestDraft}
            onCancelDraft={() => setDraft(null)}
            onChanged={commentsState.update}
            onShow={showComment}
          />
        ) : (
          <SubmissionsPanel
            projectId={project.id}
            paths={project.files.map((file) => file.path)}
            flush={flushAll}
            reviewHref={submissionHref}
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
            <IconButton icon={Share2} label={t('share')} onClick={() => setShareOpen(true)} />
            <MenuButton icon={Settings} label={t('settings')} onOpen={() => void wordCount.count()}>
              <section className={styles.wordCount} aria-live="polite">
                <h2 className={styles.menuTitle}>{t('wordCount')}</h2>
                {wordCount.state.status === 'done' ? (
                  <>
                    <p className={styles.wordCountValue}>
                      {t('wordCountValue', { count: wordCount.state.count.words })}
                    </p>
                    <p className={styles.menuHelp}>
                      {t('wordCountDetail', {
                        files: wordCount.state.count.files.length,
                        formulas: wordCount.state.count.formulas,
                      })}
                    </p>
                    {wordCount.state.count.missing.length > 0 && (
                      <p className={styles.menuHelp}>
                        {t('wordCountMissing', {
                          paths: wordCount.state.count.missing.join(', '),
                        })}
                      </p>
                    )}
                  </>
                ) : wordCount.state.status === 'no-main' ? (
                  <p className={styles.menuHelp}>
                    {t('wordCountNoMain', { path: project.mainFilePath })}
                  </p>
                ) : (
                  <p className={styles.menuHelp}>{t('wordCountLoading')}</p>
                )}
                <p className={styles.menuHelp}>{t('wordCountHelp')}</p>
                <Button
                  variant="secondary"
                  busy={wordCount.state.status === 'counting'}
                  onClick={() => void wordCount.count()}
                >
                  {t('wordCountRecount')}
                </Button>
              </section>
              {canDownload && (
                <Button
                  variant="secondary"
                  busy={download.busy}
                  onClick={() => void download.start()}
                >
                  <Download size={20} strokeWidth={1.75} aria-hidden="true" />
                  {tOps('download')}
                </Button>
              )}
              {download.error && (
                <p className={styles.menuHelp} role="alert">
                  {download.error}
                </p>
              )}
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
      <ShareDialog
        projectId={project.id}
        projectName={project.name}
        open={shareOpen}
        onClose={() => {
          setShareOpen(false);
          // Rights may have changed (someone removed): the project is read again.
          void reloadProject();
        }}
      />
      {files.dialogs}
      {download.dialog}
    </>
  );
}

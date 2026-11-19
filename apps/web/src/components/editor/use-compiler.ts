'use client';

import {
  AUTO_COMPILE_DELAY_MS,
  type Compilation,
  type CompileState,
  type SynctexIndex,
} from '@integris/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClientError } from '../../lib/api-client';
import {
  loadCompilation,
  loadCompileState,
  loadSynctex,
  startCompile,
} from '../../lib/compile/api';

const POLL_MS = 1000;
/** Signed PDF links last 15 minutes: new ones are asked for 2 minutes before. */
const RENEW_BEFORE_MS = 2 * 60_000;
const AUTO_KEY = 'integris.editor.autoCompile';

const isOpen = (compilation: Compilation | null) =>
  compilation?.status === 'QUEUED' || compilation?.status === 'RUNNING';

function readAuto(): boolean {
  try {
    return window.localStorage.getItem(AUTO_KEY) !== 'false';
  } catch {
    return true;
  }
}

export interface Compiler {
  state: CompileState | null;
  /** The compilation in progress or the last one. */
  current: Compilation | null;
  /** Error of the last request to compile (quota reached, service down…). */
  requestError: ClientError | null;
  /** The code changed since the last compilation started. */
  changed: boolean;
  /** Seconds since the running compilation started. */
  elapsed: number;
  /** A compilation request is being sent (files saved first). */
  sending: boolean;
  synctex: SynctexIndex | null;
  autoEnabled: boolean;
  setAutoEnabled: (enabled: boolean) => void;
  compile: (auto?: boolean) => Promise<void>;
  /** To call on every edit: marks the PDF as outdated and schedules the automatic compilation. */
  edited: () => void;
}

/**
 * Compilation in the editor (docs/spec.md, "Compilation"): saves the open files, queues a
 * compilation, follows it until it ends (position in the queue, time), keeps the last PDF and its
 * SyncTeX index, renews the signed PDF links, and compiles automatically 2 s after the last
 * keystroke when the plan allows it and the user did not turn it off.
 */
export function useCompiler(projectId: string, flush: () => Promise<boolean>): Compiler {
  const [state, setState] = useState<CompileState | null>(null);
  const [current, setCurrent] = useState<Compilation | null>(null);
  const [requestError, setRequestError] = useState<ClientError | null>(null);
  const [changed, setChanged] = useState(false);
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [synctex, setSynctex] = useState<SynctexIndex | null>(null);
  const [autoEnabled, setAuto] = useState(readAuto);

  const latest = useRef({ state, current, sending, autoEnabled, flush });
  useLayoutEffect(() => {
    latest.current = { state, current, sending, autoEnabled, flush };
  });
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** An automatic compilation asked while another one was running. */
  const autoPending = useRef(false);

  const apply = useCallback((data: CompileState) => {
    setState(data);
    setCurrent((previous) =>
      previous && isOpen(previous) && data.current?.id !== previous.id ? previous : data.current,
    );
  }, []);

  const refresh = useCallback(async () => {
    const result = await loadCompileState(projectId);
    if (result.ok) apply(result.data);
  }, [projectId, apply]);

  useEffect(() => {
    let cancelled = false;
    void loadCompileState(projectId).then((result) => {
      if (!cancelled && result.ok) apply(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, apply]);

  const compile = useCallback(
    async (auto = false) => {
      const { state: known, sending: busy } = latest.current;
      if (busy || !known?.canCompile) {
        // Ctrl+S without the right to compile still saves.
        await latest.current.flush();
        return;
      }
      if (autoTimer.current) clearTimeout(autoTimer.current);
      setSending(true);
      setRequestError(null);
      await latest.current.flush();
      setChanged(false);
      const result = await startCompile(projectId, auto);
      setSending(false);
      if (result.ok) {
        setCurrent(result.data);
        setNow(Date.now());
      } else {
        setRequestError(result.error);
      }
    },
    [projectId],
  );

  // Follow the compilation while it is queued or running.
  useEffect(() => {
    if (!current || !isOpen(current)) return;
    const timer = setTimeout(async () => {
      const result = await loadCompilation(projectId, current.id);
      if (!result.ok) {
        setCurrent({ ...current });
        return;
      }
      setCurrent(result.data);
      if (!isOpen(result.data)) {
        await refresh();
        if (autoPending.current) {
          autoPending.current = false;
          void compile(true);
        }
      }
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [current, projectId, refresh, compile]);

  // Running time, every second.
  useEffect(() => {
    if (current?.status !== 'RUNNING') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [current?.status]);

  // New signed links before the shown ones expire.
  const expiresAt = state?.lastPdf?.pdf?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const delay = Math.max(new Date(expiresAt).getTime() - Date.now() - RENEW_BEFORE_MS, 5000);
    const timer = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  }, [expiresAt, refresh]);

  // SyncTeX index of the PDF shown.
  const pdfId = state?.lastPdf?.synctex ? state.lastPdf.id : null;
  useEffect(() => {
    if (!pdfId) return;
    let cancelled = false;
    void loadSynctex(projectId, pdfId).then((result) => {
      if (!cancelled) setSynctex(result.ok ? result.data : null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, pdfId]);

  const edited = useCallback(() => {
    setChanged(true);
    const { state: known, autoEnabled: auto } = latest.current;
    if (!known?.canCompile || !known.autoCompile || !auto) return;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      if (latest.current.sending || isOpen(latest.current.current)) autoPending.current = true;
      else void compile(true);
    }, AUTO_COMPILE_DELAY_MS);
  }, [compile]);

  useEffect(
    () => () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    },
    [],
  );

  const setAutoEnabled = useCallback((enabled: boolean) => {
    setAuto(enabled);
    if (!enabled && autoTimer.current) clearTimeout(autoTimer.current);
    try {
      window.localStorage.setItem(AUTO_KEY, String(enabled));
    } catch {
      // Not remembered: on again on the next visit.
    }
  }, []);

  const started = current?.startedAt ? new Date(current.startedAt).getTime() : now;
  return {
    state,
    current,
    requestError,
    changed,
    elapsed: current?.status === 'RUNNING' ? Math.max(0, Math.floor((now - started) / 1000)) : 0,
    sending,
    synctex: pdfId ? synctex : null,
    autoEnabled,
    setAutoEnabled,
    compile,
    edited,
  };
}

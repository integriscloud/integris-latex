'use client';

import type { ProjectFileInfo } from '@integris/shared';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { ProjectSymbols } from '../../lib/editor/completion';
import { loadFile } from '../../lib/editor/file-api';
import { textKindOf } from '../../lib/editor/language';
import {
  extractBibKeys,
  extractDefinitions,
  extractLabels,
  uniqueByName,
} from '../../lib/editor/symbols';

/** Files read for completion and project search: bigger ones are left out (slow connections). */
export const INDEX_MAX_FILE_BYTES = 2 * 1024 * 1024;
const PARALLEL_READS = 4;

export interface IndexedFile {
  id: string;
  path: string;
  text: string;
  /** Version of the stored text; null once the text comes from an open (maybe unsaved) editor. */
  etag: string | null;
}

interface SymbolCache {
  text: string;
  symbols: ProjectSymbols;
}

const EMPTY: ProjectSymbols = { labels: [], citations: [], commands: [], environments: [] };

function symbolsOf(file: IndexedFile): ProjectSymbols {
  const kind = textKindOf(file.path);
  if (kind === 'bibtex') return { ...EMPTY, citations: extractBibKeys(file.text, file.path) };
  if (kind !== 'latex') return EMPTY;
  return {
    ...EMPTY,
    labels: extractLabels(file.text, file.path),
    ...extractDefinitions(file.text, file.path),
  };
}

/**
 * Texts of the project files, read on demand only (first `\ref`/`\cite` completion or project
 * search), four at a time, and kept up to date with the open editors. Feeds the completion of
 * labels, citations and defined commands, and the search in the whole project.
 */
export function useProjectIndex(projectId: string, files: readonly ProjectFileInfo[]) {
  const entries = useRef(new Map<string, IndexedFile>());
  const cache = useRef(new Map<string, SymbolCache>());
  const loading = useRef<Promise<void> | null>(null);

  const indexable = useMemo(
    () => files.filter((file) => file.kind === 'TEXT' && file.sizeBytes <= INDEX_MAX_FILE_BYTES),
    [files],
  );
  const filesRef = useRef(indexable);
  useLayoutEffect(() => {
    filesRef.current = indexable;
  }, [indexable]);

  const missing = useCallback(
    () => filesRef.current.filter((file) => !entries.current.has(file.id)),
    [],
  );

  /** Reads every file not read yet. Failures are skipped (retried on the next call). */
  const load = useCallback((): Promise<void> => {
    if (loading.current) return loading.current;
    const queue = missing();
    if (!queue.length) return Promise.resolve();
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const result = await loadFile(projectId, file.id);
        if (result.ok && !entries.current.has(file.id)) {
          entries.current.set(file.id, {
            id: file.id,
            path: file.path,
            text: result.text,
            etag: result.etag,
          });
        }
      }
    };
    loading.current = Promise.all(Array.from({ length: PARALLEL_READS }, worker)).then(() => {
      loading.current = null;
    });
    return loading.current;
  }, [projectId, missing]);

  /** Every file of the project is read. */
  const ready = useCallback((): boolean => !missing().length, [missing]);

  /** Text of a file changed in an editor, or saved (with its new version). */
  const update = useCallback(
    (file: Pick<IndexedFile, 'id' | 'path' | 'text'>, etag: string | null) => {
      entries.current.set(file.id, { ...file, etag });
    },
    [],
  );

  const remove = useCallback((fileId: string) => {
    entries.current.delete(fileId);
    cache.current.delete(fileId);
  }, []);

  /** Indexed files that still exist, with their current path. */
  const indexed = useCallback((): IndexedFile[] => {
    const paths = new Map(filesRef.current.map((file) => [file.id, file.path]));
    return [...entries.current.values()]
      .filter((entry) => paths.has(entry.id))
      .map((entry) => ({ ...entry, path: paths.get(entry.id)! }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, []);

  const symbols = useCallback((): ProjectSymbols => {
    const all = indexed().map((file) => {
      const cached = cache.current.get(file.id);
      if (cached && cached.text === file.text) return cached.symbols;
      const fresh = symbolsOf(file);
      cache.current.set(file.id, { text: file.text, symbols: fresh });
      return fresh;
    });
    return {
      labels: uniqueByName(all.flatMap((item) => item.labels)),
      citations: uniqueByName(all.flatMap((item) => item.citations)),
      commands: uniqueByName(all.flatMap((item) => item.commands)),
      environments: uniqueByName(all.flatMap((item) => item.environments)),
    };
  }, [indexed]);

  /** Text of a file as last read or typed. */
  const textOf = useCallback((fileId: string) => entries.current.get(fileId)?.text, []);

  // Stable object: the editor's callbacks and effects depend on it.
  return useMemo(
    () => ({ load, ready, update, remove, indexed, symbols, textOf }),
    [load, ready, update, remove, indexed, symbols, textOf],
  );
}

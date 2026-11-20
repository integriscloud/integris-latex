'use client';

import type { ProjectFileInfo } from '@integris/shared';
import { useCallback, useState } from 'react';
import { loadFile } from '../../lib/editor/file-api';
import { countDocumentWords, type WordCount } from '../../lib/editor/word-count';
import { INDEX_MAX_FILE_BYTES, type IndexedFile } from './use-project-index';

type State =
  { status: 'idle' | 'counting' } | { status: 'done'; count: WordCount } | { status: 'no-main' };

/**
 * Word count of the document (editor menu): the main file and the files it includes, from the
 * project index (open files as typed, the others as stored). Counted on demand.
 */
export function useWordCount(
  projectId: string,
  files: readonly ProjectFileInfo[],
  mainFilePath: string,
  index: { load: () => Promise<void>; indexed: () => IndexedFile[] },
) {
  const [state, setState] = useState<State>({ status: 'idle' });

  const count = useCallback(async () => {
    setState({ status: 'counting' });
    await index.load();
    const texts = new Map(index.indexed().map((file) => [file.path, file.text]));
    // Text files too large for the index are read for the count only.
    for (const file of files) {
      if (file.kind !== 'TEXT' || file.sizeBytes <= INDEX_MAX_FILE_BYTES) continue;
      const result = await loadFile(projectId, file.id);
      if (result.ok) texts.set(file.path, result.text);
    }
    const counted = countDocumentWords(mainFilePath, (path) => texts.get(path));
    setState(counted ? { status: 'done', count: counted } : { status: 'no-main' });
  }, [projectId, files, mainFilePath, index]);

  return { state, count };
}

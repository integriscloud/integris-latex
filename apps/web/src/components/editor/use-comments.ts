'use client';

import type { CommentInfo, CommentList } from '@integris/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiRead, type ClientError } from '../../lib/api-client';
import type { ProjectCollab } from '../../lib/collab/project-collab';

/**
 * Comments of a project, read again whenever the collaboration server says they changed (someone
 * commented, answered, resolved or decided a proposal), and after one's own changes.
 */
export function useComments(projectId: string, collab: ProjectCollab) {
  const [comments, setComments] = useState<CommentInfo[] | null>(null);
  const [error, setError] = useState<ClientError | null>(null);

  const read = useCallback(
    () => apiRead<CommentList>(`projects/${projectId}/comments`),
    [projectId],
  );
  const show = useCallback((result: Awaited<ReturnType<typeof read>>) => {
    if (result.ok) {
      setComments(result.data.comments);
      setError(null);
    } else {
      setError(result.error);
    }
  }, []);

  const reload = useCallback(async () => show(await read()), [read, show]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void read().then((result) => {
        if (!cancelled) show(result);
      });
    load();
    const stop = collab.onProjectChange((change) => {
      if (change === 'comments') load();
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [collab, read, show]);

  /** One comment as the API returned it after a change (shown before the next reading). */
  const update = useCallback((comment: CommentInfo) => {
    setComments((list) => {
      if (!list) return [comment];
      return list.some((item) => item.id === comment.id)
        ? list.map((item) => (item.id === comment.id ? comment : item))
        : [...list, comment];
    });
  }, []);

  return { comments, error, reload, update };
}

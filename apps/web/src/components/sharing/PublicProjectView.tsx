'use client';

import { API_PREFIX, apiErrorSchema, type PublicProject } from '@integris/shared';
import { Alert, Badge, Button, EmptyState, FileTree, buildFileTree } from '@integris/ui';
import { FileText, Lock } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../../lib/format';
import { PdfViewer } from '../editor/PdfViewer';
import styles from './public.module.css';

type State =
  | { kind: 'loading' }
  /** Refused by the API: revoked, expired or unknown link, or too many readings. */
  | { kind: 'invalid'; rateLimited: boolean }
  /** No answer from the API (network, server, or a front that refused the request). */
  | { kind: 'unavailable' }
  | { kind: 'shown'; project: PublicProject };

/**
 * Reads a public link. The API never reads the session of the visitor on these routes, but the
 * request keeps the browser's credentials for the site: a front with HTTP authentication
 * (latex-dev) refuses requests made without them.
 */
async function readPublic(path: string): Promise<Response | null> {
  try {
    return await fetch(`/${API_PREFIX}/public/${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return null;
  }
}

/**
 * Public read-only link (docs/spec.md, "Lien public"), without an account: the last successful
 * PDF, and the sources when the owner included them. Never comments, history or compilation.
 */
export function PublicProjectView({ token }: { token: string }) {
  const t = useTranslations('PublicLink');
  const tEditor = useTranslations('Editor');
  const locale = useLocale();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [fileId, setFileId] = useState<string | null>(null);
  const [text, setText] = useState<{ id: string; value: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readPublic(token).then(async (response) => {
      if (cancelled) return;
      if (response?.ok) {
        setState({ kind: 'shown', project: (await response.json()) as PublicProject });
        return;
      }
      // Only an answer of the API says the link is not valid; anything else is a failure to read.
      const body = apiErrorSchema.safeParse(await response?.json().catch(() => null));
      const code = body.success ? body.data.code : null;
      if (code === 'link_invalid' || code === 'rate_limited') {
        setState({ kind: 'invalid', rateLimited: code === 'rate_limited' });
      } else {
        setState({ kind: 'unavailable' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  // The chosen source file, read once shown.
  useEffect(() => {
    if (!fileId) return;
    let cancelled = false;
    void readPublic(`${token}/files/${fileId}`).then(async (response) => {
      const value = response?.ok ? await response.text() : null;
      if (!cancelled) setText({ id: fileId, value });
    });
    return () => {
      cancelled = true;
    };
  }, [token, fileId]);

  const project = state.kind === 'shown' ? state.project : null;
  const tree = useMemo(
    () =>
      buildFileTree(
        (project?.files ?? []).map((file) => ({
          id: file.id,
          path: file.path,
          size: formatBytes(file.sizeBytes, locale),
        })),
      ),
    [project, locale],
  );

  if (state.kind === 'loading') {
    return (
      <p className={styles.muted} role="status">
        {t('loading')}
      </p>
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <Alert tone="error">
        <p>{t('unavailable')}</p>
        <Button
          variant="secondary"
          onClick={() => {
            setState({ kind: 'loading' });
            setAttempt((value) => value + 1);
          }}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  }
  if (state.kind === 'invalid') {
    return (
      <Alert tone="error">
        <p>{state.rateLimited ? t('rateLimited') : t('invalid')}</p>
      </Alert>
    );
  }

  const { project: shown } = state;
  const selected = shown.files?.find((file) => file.id === fileId);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>{shown.name}</h1>
        <Badge icon={Lock}>{t('readOnly')}</Badge>
      </header>
      <div className={styles.layout}>
        <section className={styles.pdf} aria-label={t('pdf')}>
          {shown.pdf ? (
            <PdfViewer
              documentKey={token}
              url={shown.pdf.url}
              downloadUrl={shown.pdf.downloadUrl}
              highlight={null}
              labels={{
                toolbar: tEditor('pdfViewer.toolbar'),
                previous: tEditor('pdfViewer.previous'),
                next: tEditor('pdfViewer.next'),
                page: (page, pages) => tEditor('pdfViewer.page', { page, pages }),
                pageLabel: (page) => tEditor('pdfViewer.pageLabel', { page }),
                zoomIn: tEditor('pdfViewer.zoomIn'),
                zoomOut: tEditor('pdfViewer.zoomOut'),
                fit: tEditor('pdfViewer.fit'),
                download: tEditor('pdfViewer.download'),
                loading: tEditor('pdfViewer.loading'),
                failed: tEditor('pdfViewer.failed'),
                retry: tEditor('retry'),
              }}
            />
          ) : (
            <EmptyState icon={FileText} title={t('noPdf')} text={t('noPdfHint')} />
          )}
        </section>
        {shown.files && (
          <section className={styles.sources} aria-label={t('sources')}>
            <h2 className={styles.subtitle}>{t('sources')}</h2>
            <FileTree
              label={t('sources')}
              entries={tree}
              mainLabel=""
              lockedLabel=""
              fileHref={(file) =>
                shown.files?.find((item) => item.id === file.id)?.kind === 'TEXT'
                  ? `#${file.id}`
                  : undefined
              }
              onOpenFile={(file) => {
                setFileId(file.id);
                setText(null);
              }}
              activeId={fileId ?? undefined}
            />
            {selected &&
              (selected.kind === 'TEXT' ? (
                text?.id === selected.id ? (
                  text.value === null ? (
                    <Alert tone="error">
                      <p>{t('fileFailed')}</p>
                    </Alert>
                  ) : (
                    <pre className={styles.code} aria-label={selected.path} tabIndex={0}>
                      {text.value}
                    </pre>
                  )
                ) : (
                  <p className={styles.muted} role="status">
                    {t('loading')}
                  </p>
                )
              ) : (
                <p className={styles.muted}>{t('binary')}</p>
              ))}
          </section>
        )}
      </div>
    </div>
  );
}

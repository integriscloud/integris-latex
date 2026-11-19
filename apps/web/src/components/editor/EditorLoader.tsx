'use client';

import type { ProjectDetail } from '@integris/shared';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import styles from './editor.module.css';

function Loading() {
  const t = useTranslations('Editor');
  return (
    <p className={styles.loading} role="status">
      {t('loading')}
    </p>
  );
}

// CodeMirror is loaded with the editor only, in its own chunk, and only in the browser.
const ProjectEditor = dynamic(
  () => import('./ProjectEditor').then((module) => module.ProjectEditor),
  {
    ssr: false,
    loading: Loading,
  },
);

export function EditorLoader(props: {
  initial: ProjectDetail;
  initialFileId: string | null;
  initialSpellcheck: boolean;
}) {
  return <ProjectEditor {...props} />;
}

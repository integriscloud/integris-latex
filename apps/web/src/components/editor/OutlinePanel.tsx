'use client';

import { EmptyState } from '@integris/ui';
import { ListTree } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { OutlineEntry } from '../../lib/editor/outline';
import styles from './editor.module.css';

/** Document outline of the open LaTeX file; a click moves the cursor to the section. */
export function OutlinePanel({
  entries,
  available,
  onGoTo,
}: {
  /** False when the open file is not a LaTeX file. */
  available: boolean;
  entries: readonly OutlineEntry[];
  onGoTo: (line: number) => void;
}) {
  const t = useTranslations('Editor');
  if (!available) return <EmptyState icon={ListTree} title={t('outlineNotLatex')} />;
  if (!entries.length) {
    return <EmptyState icon={ListTree} title={t('outlineEmpty')} text={t('outlineEmptyHint')} />;
  }
  // Indentation relative to the outermost level used in the file.
  const top = Math.min(...entries.map((entry) => entry.level));
  return (
    <nav aria-label={t('outline')}>
      <ol className={styles.outline}>
        {entries.map((entry) => (
          <li key={`${entry.from}`} data-depth={Math.min(entry.level - top, 4)}>
            <button type="button" className={styles.outlineItem} onClick={() => onGoTo(entry.line)}>
              <span className={styles.outlineTitle}>{entry.title || t('untitled')}</span>
              <span className={styles.outlineLine}>{t('line', { line: entry.line })}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

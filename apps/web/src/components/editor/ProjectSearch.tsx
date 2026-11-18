'use client';

import { Alert, Button, Checkbox, TextField } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import {
  findMatches,
  replaceAll,
  type SearchMatch,
  type SearchOptions,
  searchPattern,
} from '../../lib/editor/search';
import styles from './editor.module.css';
import type { IndexedFile } from './use-project-index';

export interface FileMatches {
  file: IndexedFile;
  matches: SearchMatch[];
}

export interface ReplaceReport {
  replaced: number;
  files: number;
  /** Paths not changed: modified elsewhere meanwhile, or refused. */
  failed: string[];
}

const MAX_RESULTS = 500;

/** Search, and replace when the user may edit, in every text file of the project. */
export function ProjectSearch({
  editable,
  load,
  indexed,
  onOpen,
  onReplace,
}: {
  editable: boolean;
  /** Reads the files of the project not read yet. */
  load: () => Promise<void>;
  indexed: () => IndexedFile[];
  onOpen: (fileId: string, line: number, column: number) => void;
  onReplace: (
    changes: { file: IndexedFile; text: string; count: number }[],
  ) => Promise<ReplaceReport>;
}) {
  const t = useTranslations('Editor');
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    regexp: false,
    wholeWord: false,
  });
  const [results, setResults] = useState<FileMatches[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [report, setReport] = useState<ReplaceReport | null>(null);

  const run = async () => {
    const pattern = searchPattern(query, options);
    setInvalid(Boolean(query) && !pattern);
    setReport(null);
    if (!pattern) {
      setResults(null);
      return null;
    }
    setBusy(true);
    await load();
    setBusy(false);
    let total = 0;
    const found: FileMatches[] = [];
    for (const file of indexed()) {
      if (total >= MAX_RESULTS) break;
      const matches = findMatches(file.text, pattern, MAX_RESULTS - total);
      if (matches.length) {
        found.push({ file, matches });
        total += matches.length;
      }
    }
    setResults(found);
    return { pattern, found };
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run();
  };

  const replace = async () => {
    const searched = await run();
    if (!searched || !searched.found.length) return;
    setBusy(true);
    const changes = searched.found.map(({ file }) => ({
      file,
      ...replaceAll(file.text, searched.pattern, replacement, options),
    }));
    const done = await onReplace(changes);
    setBusy(false);
    setReport(done);
    setResults(null);
  };

  const total = results?.reduce((sum, item) => sum + item.matches.length, 0) ?? 0;
  const option = (key: keyof SearchOptions, label: string) => (
    <Checkbox
      checked={options[key]}
      onChange={(event) => setOptions((current) => ({ ...current, [key]: event.target.checked }))}
    >
      {label}
    </Checkbox>
  );

  return (
    <div className={styles.search}>
      <form
        className={styles.searchForm}
        onSubmit={submit}
        role="search"
        aria-label={t('searchProject')}
      >
        <TextField
          label={t('searchLabel')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          error={invalid ? t('searchInvalid') : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <div className={styles.searchOptions}>
          {option('caseSensitive', t('matchCase'))}
          {option('wholeWord', t('wholeWord'))}
          {option('regexp', t('regexp'))}
        </div>
        <Button type="submit" variant="secondary" busy={busy}>
          {t('searchButton')}
        </Button>
        {editable && (
          <>
            <TextField
              label={t('replaceLabel')}
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <Button variant="secondary" disabled={!query || busy} onClick={() => void replace()}>
              {t('replaceAll')}
            </Button>
          </>
        )}
      </form>

      <div aria-live="polite" className={styles.searchResults}>
        {report && (
          <Alert tone={report.failed.length ? 'warning' : 'success'} announce={false}>
            {t('replaceDone', { count: report.replaced, files: report.files })}
            {report.failed.length > 0 && (
              <> {t('replaceFailed', { paths: report.failed.join(', ') })}</>
            )}
          </Alert>
        )}
        {results && (
          <p className={styles.muted}>
            {total >= MAX_RESULTS
              ? t('searchTooMany', { count: MAX_RESULTS })
              : t('searchCount', { count: total, files: results.length })}
          </p>
        )}
        {results?.map(({ file, matches }) => (
          <section key={file.id} className={styles.resultFile}>
            <h3 className={styles.resultPath}>{file.path}</h3>
            <ul className={styles.resultList}>
              {matches.map((match) => (
                <li key={match.from}>
                  <button
                    type="button"
                    className={styles.result}
                    onClick={() => onOpen(file.id, match.line, match.column)}
                  >
                    <span className={styles.resultLine}>{match.line}</span>
                    <span className={styles.resultText}>
                      {match.preview.before}
                      <mark>{match.preview.match}</mark>
                      {match.preview.after}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

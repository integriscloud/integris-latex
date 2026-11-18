'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

/** CodeMirror interface texts (search panel, folding, completion) in the language of the UI. */
export function useEditorPhrases(): Record<string, string> {
  const t = useTranslations('Editor.phrases');
  return useMemo(
    () => ({
      Find: t('find'),
      Replace: t('replace'),
      next: t('next'),
      previous: t('previous'),
      all: t('all'),
      'match case': t('matchCase'),
      regexp: t('regexp'),
      'by word': t('byWord'),
      replace: t('replaceOne'),
      'replace all': t('replaceAll'),
      close: t('close'),
      'current match': t('currentMatch'),
      'replaced $ matches': t('replacedMatches'),
      'replaced match on line $': t('replacedMatchOnLine'),
      'on line': t('onLine'),
      'Go to line': t('goToLine'),
      go: t('go'),
      'Folded lines': t('foldedLines'),
      'Unfolded lines': t('unfoldedLines'),
      to: t('to'),
      'folded code': t('foldedCode'),
      unfold: t('unfold'),
      'Fold line': t('foldLine'),
      'Unfold line': t('unfoldLine'),
      Completions: t('completions'),
      'Control character': t('controlCharacter'),
    }),
    [t],
  );
}

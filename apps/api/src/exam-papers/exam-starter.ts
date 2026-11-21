import { EXAM_PART_FILES } from '@integris/shared';

const TEXTS = {
  fr: {
    babel: 'french',
    subject: 'Sujet',
    answers: 'Corrigé',
    marking: 'Barème',
    duration: 'Durée : 2 heures · Documents non autorisés',
    exercise: 'Exercice 1',
    question: 'Énoncé de la première question.',
    answer: 'Réponse attendue à la première question.',
    criteria: 'Critère',
    points: 'Points',
    total: 'Total',
  },
  en: {
    babel: 'english',
    subject: 'Exam paper',
    answers: 'Answer key',
    marking: 'Marking scheme',
    duration: 'Duration: 2 hours · No documents allowed',
    exercise: 'Exercise 1',
    question: 'Statement of the first question.',
    answer: 'Expected answer to the first question.',
    criteria: 'Criterion',
    points: 'Points',
    total: 'Total',
  },
} as const;

const preamble = (babel: string) => [
  '\\documentclass[a4paper,12pt]{article}',
  '\\usepackage[T1]{fontenc}',
  `\\usepackage[${babel}]{babel}`,
  '\\usepackage[margin=2cm]{geometry}',
  '',
];

/**
 * Starting files of a new exam paper: the subject (sent to the secretariat), the answer key and
 * the marking scheme (never sent), each compilable on its own.
 */
export function examStarterFiles(
  locale: 'fr' | 'en',
  title: string,
): { path: string; content: string }[] {
  const t = TEXTS[locale];
  const safeTitle = title.replace(/[\\{}$&#^_%~]/g, ' ').trim();
  const heading = (part: string) => [
    '\\begin{center}',
    `  {\\Large\\bfseries ${safeTitle}}\\\\[4pt]`,
    `  ${part}`,
    '\\end{center}',
    '',
  ];
  return [
    {
      path: EXAM_PART_FILES.subject,
      content: [
        ...preamble(t.babel),
        '\\begin{document}',
        ...heading(t.duration),
        `\\section*{${t.exercise}}`,
        '\\begin{enumerate}',
        `  \\item ${t.question}`,
        '\\end{enumerate}',
        '',
        '\\end{document}',
        '',
      ].join('\n'),
    },
    {
      path: EXAM_PART_FILES.answers,
      content: [
        ...preamble(t.babel),
        '\\begin{document}',
        ...heading(t.answers),
        `\\section*{${t.exercise}}`,
        '\\begin{enumerate}',
        `  \\item ${t.answer}`,
        '\\end{enumerate}',
        '',
        '\\end{document}',
        '',
      ].join('\n'),
    },
    {
      path: EXAM_PART_FILES.marking,
      content: [
        ...preamble(t.babel),
        '\\begin{document}',
        ...heading(t.marking),
        '\\begin{tabular}{|l|r|}',
        '  \\hline',
        `  ${t.criteria} & ${t.points} \\\\`,
        '  \\hline',
        `  ${t.exercise} & 6 \\\\`,
        '  \\hline',
        `  \\textbf{${t.total}} & \\textbf{20} \\\\`,
        '  \\hline',
        '\\end{tabular}',
        '',
        '\\end{document}',
        '',
      ].join('\n'),
    },
  ];
}

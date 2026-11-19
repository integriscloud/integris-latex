/**
 * Step 6 acceptance (docs/spec.md, "Plan de développement"): an 80-page thesis compiles, with
 * chapters in separate files, figures, tables, equations, cross-references, a table of contents
 * and a BibTeX bibliography, with each engine, within the Standard plan's duration (2 min).
 * The second pdfLaTeX run reuses the cache. Run: pnpm test:thesis
 */
import { gunzipSync, crc32, deflateSync } from 'node:zlib';
import type { EngineValue, SynctexIndex } from '@integris/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxHarness } from './harness.js';

const STANDARD_SECONDS = 120;

const WORDS = (
  'analyse bassin versant débit station mesure saison pluie modèle données hydrologie ' +
  'ressource eau irrigation agriculture rendement climat température variation tendance ' +
  'méthode résultat discussion hypothèse étude terrain enquête population région commune ' +
  'barrage réservoir sédiment érosion sol végétation couvert cartographie satellite image ' +
  'série temporelle moyenne écart calcul simulation calibration validation incertitude'
).split(' ');

/** Deterministic pseudo-random French-like prose. */
function prose(seed: number, sentences: number): string {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648);
  const out: string[] = [];
  for (let s = 0; s < sentences; s++) {
    const length = 12 + (next() % 14);
    const words = Array.from({ length }, () => WORDS[next() % WORDS.length]!);
    const sentence = words.join(' ');
    out.push(`${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`);
  }
  return out.join(' ');
}

/** A small valid PNG (grey gradient), as a figure of the thesis. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = (x + y) % 256;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CHAPTERS = 6;

function chapter(index: number): string {
  const parts = [`\\chapter{Chapitre ${index}}\\label{chap:${index}}`, prose(index, 6)];
  for (let section = 1; section <= 9; section++) {
    const id = `${index}-${section}`;
    parts.push(`\\section{Section ${id}}\\label{sec:${id}}`);
    parts.push(prose(index * 100 + section, 14));
    parts.push(
      `Comme le montrent \\cite{knuth1984} et \\cite{lamport1994}, voir la section~\\ref{sec:${index}-1}.`,
    );
    parts.push(
      `\\begin{equation}\\label{eq:${id}} Q_{${section}} = \\int_0^T \\alpha_{${index}} \\, P(t)\\,\\mathrm{d}t + \\sum_{k=1}^{n} \\frac{\\beta_k}{k^2} \\end{equation}`,
    );
    parts.push(prose(index * 1000 + section, 12));
    if (section % 3 === 0) {
      parts.push(
        `\\begin{figure}[htbp]\\centering\\includegraphics[width=0.6\\textwidth]{figures/figure${(section / 3) % 2}.png}\\caption{Figure ${id}.}\\label{fig:${id}}\\end{figure}`,
      );
      parts.push(
        `\\begin{table}[htbp]\\centering\\begin{tabular}{lrr}\\hline Station & Débit & Pluie \\\\ \\hline A & ${section}2 & ${index}4 \\\\ B & ${section}7 & ${index}1 \\\\ \\hline\\end{tabular}\\caption{Tableau ${id}.}\\label{tab:${id}}\\end{table}`,
      );
      parts.push(
        `La figure~\\ref{fig:${id}} et le tableau~\\ref{tab:${id}} résument l'équation~\\eqref{eq:${id}}.`,
      );
    }
  }
  return parts.join('\n\n');
}

function thesis(): Map<string, Buffer> {
  const main = `\\documentclass[12pt,a4paper]{report}
\\usepackage{iftex}
\\ifPDFTeX
  \\usepackage[T1]{fontenc}
  \\usepackage[utf8]{inputenc}
  \\usepackage{lmodern}
\\else
  \\usepackage{fontspec}
\\fi
\\usepackage[french]{babel}
\\usepackage[left=3cm,right=2.5cm,top=2.5cm,bottom=2.5cm]{geometry}
\\usepackage{setspace}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\onehalfspacing
\\begin{document}
\\begin{titlepage}\\centering{\\LARGE\\bfseries Mémoire de test de 80 pages\\par}\\end{titlepage}
\\tableofcontents
\\listoffigures
\\listoftables
${Array.from({ length: CHAPTERS }, (_, index) => `\\include{chapitres/chapitre${index + 1}}`).join('\n')}
\\bibliographystyle{plain}
\\bibliography{references}
\\end{document}
`;
  const bibliography = `@book{knuth1984, author = {Donald E. Knuth}, title = {The {\\TeX}book}, publisher = {Addison-Wesley}, year = {1984}}
@book{lamport1994, author = {Leslie Lamport}, title = {{\\LaTeX}: A Document Preparation System}, publisher = {Addison-Wesley}, year = {1994}}
`;
  const files = new Map<string, Buffer>([
    ['main.tex', Buffer.from(main)],
    ['references.bib', Buffer.from(bibliography)],
    ['figures/figure0.png', png(320, 200)],
    ['figures/figure1.png', png(200, 320)],
  ]);
  for (let index = 1; index <= CHAPTERS; index++) {
    files.set(`chapitres/chapitre${index}.tex`, Buffer.from(chapter(index)));
  }
  return files;
}

const pagesOf = (log: string) =>
  Number(log.match(/Output written on \S+ \((\d+) pages?/)?.[1] ?? 0);

describe('80-page thesis', () => {
  const harness = new SandboxHarness();
  const timings: string[] = [];

  beforeAll(() => harness.start());
  afterAll(() => {
    harness.stop();
    console.log(`\n80-page thesis (limit ${STANDARD_SECONDS} s)\n${timings.join('\n')}\n`);
  });

  describe.concurrent.each(['PDFLATEX', 'XELATEX', 'LUALATEX'] as EngineValue[])('%s', (engine) => {
    it('compiles with its bibliography, references and SyncTeX', async () => {
      const files = thesis();
      const project = `thesis-${engine.toLowerCase()}`;
      const first = await harness.compile(project, files, { engine, seconds: STANDARD_SECONDS });
      const pages = pagesOf(first.log);
      timings.push(
        `${engine.padEnd(9)} first run  ${(first.result.durationMs / 1000).toFixed(1).padStart(5)} s, ${pages} pages, ${first.result.warningCount} warnings`,
      );

      expect(first.result.outcome).toBe('success');
      expect(pages).toBeGreaterThanOrEqual(80);
      // References and citations were resolved by the reruns of latexmk.
      expect(first.result.issues.filter((issue) => issue.id.startsWith('undefined_'))).toEqual([]);
      const index = JSON.parse(gunzipSync(first.synctex!).toString('utf8')) as SynctexIndex;
      expect(index.inputs).toContain('chapitres/chapitre3.tex');
      expect(index.pages.length).toBe(pages);

      if (engine === 'PDFLATEX') {
        // Same sources again: the cache (.aux, .bbl, .toc…) saves the extra runs.
        const second = await harness.compile(project, files, { engine, seconds: STANDARD_SECONDS });
        timings.push(
          `${engine.padEnd(9)} with cache ${(second.result.durationMs / 1000).toFixed(1).padStart(5)} s`,
        );
        expect(second.result.outcome).toBe('success');
        expect(second.result.durationMs).toBeLessThan(first.result.durationMs);
      }
    });
  });
});

import { describe, expect, it } from 'vitest';
import { COMPILE_ISSUE_IDS, parseLatexLog, projectPathOf } from './compile-log.js';

// Lines as written by TeX Live 2026 with -file-line-error and max_print_line=10000.
const LOG = String.raw`This is pdfTeX, Version 3.141592653-2.6-1.40.29 (TeX Live 2026)
 restricted \write18 enabled.
(./main.tex
LaTeX2e <2026-11-01>
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls
Document Class: article 2026-06-04 v1.4n Standard LaTeX document class
)
(./chapitres/intro.tex
./chapitres/intro.tex:42: Undefined control sequence.
l.42 La figure \fgure
                     {bassin}
./chapitres/intro.tex:50: LaTeX Error: Environment itemise undefined.
l.50 \begin{itemise}

LaTeX Warning: Reference ${'`'}fig:bassin' on page 3 undefined on input line 57.

)
./main.tex:118: Missing } inserted.
runsystem(cat /etc/passwd > pwned.tex)...disabled (restricted).
./main.tex:120: LaTeX Error: File ${'`'}pwned.tex' not found.
./main.tex:121: I can't find file ${'`'}/etc/passwd'.
./main.tex:122: I can't write on file ${'`'}/tmp/x.tex'.
[\directlua]:1: Not reading from /etc/passwd (Integris sandbox).
l.130 }
LaTeX Warning: Citation ${'`'}knuth' on page 4 undefined on input line 140.
LaTeX Warning: Citation ${'`'}knuth' on page 4 undefined on input line 140.
)`;

describe('parseLatexLog', () => {
  const parsed = parseLatexLog(LOG);
  const byId = (id: string) => parsed.issues.find((issue) => issue.id === id);

  it('finds errors with their project file, line and arguments, in order', () => {
    expect(
      parsed.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.id),
    ).toEqual([
      'undefined_control_sequence',
      'environment_undefined',
      'missing_brace',
      'missing_file',
      'outside_project',
      'write_refused',
      'outside_project',
    ]);
    expect(byId('undefined_control_sequence')).toMatchObject({
      file: 'chapitres/intro.tex',
      line: 42,
      args: { command: '\\fgure' },
    });
    expect(byId('environment_undefined')).toMatchObject({ line: 50, args: { name: 'itemise' } });
    expect(byId('missing_file')?.args).toEqual({ file: 'pwned.tex' });
    expect(byId('write_refused')?.args).toEqual({ file: '/tmp/x.tex' });
  });

  it('explains what the sandbox refused', () => {
    expect(byId('shell_escape_refused')).toMatchObject({
      severity: 'warning',
      args: { command: 'cat /etc/passwd > pwned.tex' },
    });
    const lua = parsed.issues.filter((issue) => issue.id === 'outside_project').at(-1);
    expect(lua).toMatchObject({ file: null, line: 130, args: { file: '/etc/passwd' } });
  });

  it('locates warnings in the file being read and drops repeated ones', () => {
    expect(byId('undefined_reference')).toMatchObject({
      file: 'chapitres/intro.tex',
      line: 57,
      args: { label: 'fig:bassin' },
    });
    expect(byId('undefined_citation')).toMatchObject({ file: 'main.tex', line: 140 });
    expect(parsed.issues.filter((issue) => issue.id === 'undefined_citation')).toHaveLength(1);
    expect(parsed.errorCount).toBe(7);
    expect(parsed.warningCount).toBe(3);
  });

  it('shortens what it copies from the log and caps the number of issues', () => {
    const long = parseLatexLog(`./main.tex:1: Package foo Error: ${'x'.repeat(5000)}`);
    expect(long.issues[0]!.raw.length).toBeLessThanOrEqual(300);
    expect(long.issues[0]!.args.message!.length).toBeLessThanOrEqual(120);
    const many = parseLatexLog(
      Array.from(
        { length: 200 },
        (_, index) => `./main.tex:${index + 1}: Missing $ inserted.`,
      ).join('\n'),
    );
    expect(many.issues).toHaveLength(50);
    expect(many.errorCount).toBe(200);
  });

  it('reads hostile lines in linear time', () => {
    const lines = [
      `! Font \\a${'='.repeat(10_000)}`,
      `./main.tex:1: Package ${'x'.repeat(10_000)} Error ${'y'.repeat(10_000)}`,
      `LaTeX Warning: Reference \`${"'".repeat(10_000)} on page`,
      `runsystem(${'('.repeat(10_000)}`,
      `(${'(./a.tex '.repeat(5000)}`,
    ];
    const start = performance.now();
    for (const line of lines) parseLatexLog(Array.from({ length: 50 }, () => line).join('\n'));
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('knows about 50 messages', () => {
    expect(COMPILE_ISSUE_IDS.length).toBeGreaterThanOrEqual(50);
    expect(new Set(COMPILE_ISSUE_IDS).size).toBe(COMPILE_ISSUE_IDS.length);
  });
});

describe('projectPathOf', () => {
  it('keeps project files only', () => {
    expect(projectPathOf('./chapitres/intro.tex')).toBe('chapitres/intro.tex');
    expect(projectPathOf('/work/./main.tex')).toBe('main.tex');
    expect(
      projectPathOf('/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls'),
    ).toBeNull();
    expect(projectPathOf('../etc/passwd')).toBeNull();
  });
});

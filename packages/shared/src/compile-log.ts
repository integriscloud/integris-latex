/**
 * Reading of a TeX log (docs/spec.md, "Compilation": the first 1 to 3 errors translated, about
 * 50 common errors, clickable to the line). The log is untrusted text: it is only matched
 * against fixed patterns, and every value taken from it is shortened.
 */

interface IssueRule {
  id: string;
  severity: 'error' | 'warning';
  pattern: RegExp;
  /** Names of the capture groups of `pattern`, in order. */
  args?: readonly string[];
}

/**
 * Known messages, most specific first: the first matching rule wins. `latex_error`,
 * `package_error`, `class_error` and `tex_error` catch everything else.
 */
const RULES = [
  // Sandbox: reading or writing outside the project, system commands.
  {
    id: 'outside_project',
    severity: 'error',
    pattern: /Not reading from (\S+) \(Integris sandbox\)/,
    args: ['file'],
  },
  {
    id: 'shell_escape_refused',
    severity: 'warning',
    pattern: /^runsystem\((.*)\)\.\.\.disabled/,
    args: ['command'],
  },
  {
    id: 'system_command_refused',
    severity: 'error',
    pattern: /command execution disabled|execution disabled/,
  },
  {
    id: 'lua_module_unavailable',
    severity: 'error',
    pattern: /module '([^']+)' not found/,
    args: ['module'],
  },
  {
    id: 'write_refused',
    severity: 'error',
    pattern: /Not writing to (.+) \(openout_any = p\)/,
    args: ['file'],
  },
  {
    id: 'cannot_write',
    severity: 'error',
    pattern: /^I can't write on file [`'](.+)'\.?$/,
    args: ['file'],
  },
  {
    id: 'file_not_found',
    severity: 'error',
    pattern: /^I can't find file [`'](.+?)'\.?$/,
    args: ['file'],
  },
  // LaTeX kernel errors.
  {
    id: 'missing_file',
    severity: 'error',
    pattern: /LaTeX Error: File [`'](.+?)' not found/,
    args: ['file'],
  },
  {
    id: 'environment_undefined',
    severity: 'error',
    pattern: /LaTeX Error: Environment (\S+) undefined/,
    args: ['name'],
  },
  {
    id: 'begin_end_mismatch',
    severity: 'error',
    pattern: /LaTeX Error: \\begin\{([^}]+)\} on input line (\d+) ended by \\end\{([^}]+)\}/,
    args: ['begin', 'beginLine', 'end'],
  },
  {
    id: 'missing_begin_document',
    severity: 'error',
    pattern: /LaTeX Error: Missing \\begin\{document\}/,
  },
  {
    id: 'missing_item',
    severity: 'error',
    pattern: /LaTeX Error: Something's wrong--perhaps a missing \\item/,
  },
  {
    id: 'lonely_item',
    severity: 'error',
    pattern: /LaTeX Error: Lonely \\item--perhaps a missing list environment/,
  },
  {
    id: 'option_clash',
    severity: 'error',
    pattern: /LaTeX Error: Option clash for package (\S+?)\.?$/,
    args: ['package'],
  },
  {
    id: 'unknown_option',
    severity: 'error',
    pattern: /Error: Unknown option [`'](.+?)' for package [`'](.+?)'/,
    args: ['option', 'package'],
  },
  {
    id: 'command_already_defined',
    severity: 'error',
    pattern: /LaTeX Error: Command (\S+) already defined/,
    args: ['command'],
  },
  { id: 'no_line_to_end', severity: 'error', pattern: /LaTeX Error: There's no line here to end/ },
  { id: 'not_in_outer_par', severity: 'error', pattern: /LaTeX Error: Not in outer par mode/ },
  { id: 'too_many_floats', severity: 'error', pattern: /LaTeX Error: Too many unprocessed floats/ },
  {
    id: 'unknown_graphics_extension',
    severity: 'error',
    pattern: /LaTeX Error: Unknown graphics extension: (\S+?)\.?$/,
    args: ['extension'],
  },
  {
    id: 'graphic_size',
    severity: 'error',
    pattern: /LaTeX Error: Cannot determine size of graphic/,
  },
  { id: 'preamble_only', severity: 'error', pattern: /LaTeX Error: Can be used only in preamble/ },
  {
    id: 'unicode_not_set_up',
    severity: 'error',
    pattern: /LaTeX Error: Unicode character (.+?) \(U\+([0-9A-Fa-f]+)\)/,
    args: ['character', 'code'],
  },
  { id: 'invalid_utf8', severity: 'error', pattern: /Invalid UTF-8 byte/ },
  {
    id: 'missing_dollar_math',
    severity: 'error',
    pattern: /LaTeX Error: Bad math environment delimiter/,
  },
  { id: 'counter_too_large', severity: 'error', pattern: /LaTeX Error: Counter too large/ },
  {
    id: 'font_not_found',
    severity: 'error',
    pattern: /Package fontspec Error: The font "(.+?)" cannot be found/,
    args: ['font'],
  },
  {
    id: 'font_not_loadable',
    severity: 'error',
    pattern: /^Font \\[^=\s]+=(\S+) not loadable: Metric \(TFM\) file not found/,
    args: ['font'],
  },
  {
    id: 'babel_language',
    severity: 'error',
    pattern: /Package babel Error: Unknown option [`'](.+?)'/,
    args: ['language'],
  },
  {
    id: 'package_error',
    severity: 'error',
    pattern: /^Package (\S+) Error: (.+)$/,
    args: ['package', 'message'],
  },
  {
    id: 'class_error',
    severity: 'error',
    pattern: /^Class (\S+) Error: (.+)$/,
    args: ['class', 'message'],
  },
  { id: 'latex_error', severity: 'error', pattern: /LaTeX Error: (.+)$/, args: ['message'] },
  // TeX primitive errors.
  { id: 'undefined_control_sequence', severity: 'error', pattern: /^Undefined control sequence/ },
  { id: 'missing_dollar', severity: 'error', pattern: /^Missing \$ inserted/ },
  {
    id: 'too_many_braces',
    severity: 'error',
    pattern: /^(?:Too many \}'s|Argument of .+ has an extra \})/,
  },
  { id: 'extra_brace', severity: 'error', pattern: /^Extra \}, or forgotten/ },
  { id: 'missing_brace', severity: 'error', pattern: /^Missing [{}] inserted/ },
  { id: 'runaway_argument', severity: 'error', pattern: /^Runaway argument/ },
  {
    id: 'file_ended',
    severity: 'error',
    pattern: /^File ended while scanning use of (\S+?)\.?$/,
    args: ['command'],
  },
  {
    id: 'paragraph_ended',
    severity: 'error',
    pattern: /^Paragraph ended before (\S+) was complete/,
    args: ['command'],
  },
  {
    id: 'math_delimiter',
    severity: 'error',
    pattern: /^(?:Missing delimiter|Extra \\right|Missing \\right\. inserted)/,
  },
  {
    id: 'double_script',
    severity: 'error',
    pattern: /^Double (superscript|subscript)/,
    args: ['kind'],
  },
  { id: 'display_math', severity: 'error', pattern: /^Display math should end with \$\$/ },
  {
    id: 'invalid_character',
    severity: 'error',
    pattern: /^Text line contains an invalid character/,
  },
  { id: 'misplaced_alignment', severity: 'error', pattern: /^Misplaced alignment tab character &/ },
  {
    id: 'extra_alignment_tab',
    severity: 'error',
    pattern: /^Extra alignment tab has been changed to \\cr/,
  },
  {
    id: 'misplaced_noalign',
    severity: 'error',
    pattern: /^Misplaced \\(noalign|omit|cr|crcr)/,
    args: ['command'],
  },
  {
    id: 'illegal_parameter',
    severity: 'error',
    pattern: /^Illegal parameter number in definition of (\S+?)\.?$/,
    args: ['command'],
  },
  { id: 'illegal_unit', severity: 'error', pattern: /^Illegal unit of measure/ },
  { id: 'missing_number', severity: 'error', pattern: /^Missing number, treated as zero/ },
  { id: 'dimension_too_large', severity: 'error', pattern: /^Dimension too large/ },
  {
    id: 'extra_conditional',
    severity: 'error',
    pattern: /^Extra \\(else|fi|or|endcsname)/,
    args: ['command'],
  },
  { id: 'missing_endcsname', severity: 'error', pattern: /^Missing \\endcsname inserted/ },
  {
    id: 'capacity_exceeded',
    severity: 'error',
    pattern: /^TeX capacity exceeded, sorry \[(.+?)\]/,
    args: ['what'],
  },
  {
    id: 'lua_error',
    severity: 'error',
    pattern: /^(?:LuaTeX error |Lua error |.*\[\\directlua\]:\d+: )(.*)$/,
    args: ['message'],
  },
  {
    id: 'no_end_document',
    severity: 'error',
    pattern: /^\*\*\* \(job aborted, no legal \\end found\)/,
  },
  { id: 'emergency_stop', severity: 'error', pattern: /^Emergency stop/ },
  { id: 'tex_error', severity: 'error', pattern: /^(.+)$/, args: ['message'] },
] as const satisfies readonly IssueRule[];

/** Warnings worth showing when there is no error (docs/spec.md: references, citations). */
const WARNING_RULES = [
  {
    id: 'undefined_reference',
    severity: 'warning',
    pattern: /Warning: Reference [`'](.+?)' on page \d+ undefined on input line (\d+)/,
    args: ['label', 'line'],
  },
  {
    id: 'undefined_citation',
    severity: 'warning',
    pattern: /Warning: Citation [`'](.+?)' on page \d+ undefined on input line (\d+)/,
    args: ['key', 'line'],
  },
  {
    id: 'multiply_defined_label',
    severity: 'warning',
    pattern: /LaTeX Warning: Label [`'](.+?)' multiply defined/,
    args: ['label'],
  },
  {
    id: 'empty_bibliography',
    severity: 'warning',
    pattern: /Package biblatex Warning: Please \(re\)run Biber/,
  },
  { id: 'no_pages', severity: 'warning', pattern: /^No pages of output\./ },
] as const satisfies readonly IssueRule[];

/** Every issue the web app translates (keys of `CompileIssues` in the messages). */
export const COMPILE_ISSUE_IDS = [
  ...RULES.map((rule) => rule.id),
  ...WARNING_RULES.map((rule) => rule.id),
] as const;
export type CompileIssueId = (typeof COMPILE_ISSUE_IDS)[number];

export interface ParsedIssue {
  id: CompileIssueId;
  severity: 'error' | 'warning';
  file: string | null;
  line: number | null;
  args: Record<string, string>;
  raw: string;
}

export interface ParsedLog {
  issues: ParsedIssue[];
  errorCount: number;
  warningCount: number;
}

const MAX_ISSUES = 50;
/**
 * Characters of a log line matched against the rules: lines are untrusted (a document can write
 * any line), and every rule must stay linear on what it sees.
 */
const MAX_LINE = 2000;
const MAX_ARG = 120;
const MAX_RAW = 300;

const shorten = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/**
 * Project path of a file named in the log ("./chapitres/intro.tex", "/work/main.tex"), or null
 * for files of the distribution and anything outside the working directory.
 */
export function projectPathOf(name: string, workDir = '/work'): string | null {
  let path = name.trim();
  if (path.startsWith(`${workDir}/`)) path = path.slice(workDir.length + 1);
  if (path.startsWith('/')) return null;
  while (path.startsWith('./')) path = path.slice(2);
  if (!path || path.split('/').some((segment) => segment === '..' || segment === '')) return null;
  return shorten(path, 300);
}

/** Command named at the end of the context line of an "Undefined control sequence". */
function undefinedCommand(context: string | undefined): string | null {
  const match = context?.match(/(\\(?:[A-Za-z@]+|.))\s*$/);
  return match?.[1] ?? null;
}

function argsOf(rule: IssueRule, match: RegExpMatchArray): Record<string, string> {
  const args: Record<string, string> = {};
  (rule.args ?? []).forEach((name, index) => {
    const value = match[index + 1];
    if (value !== undefined) args[name] = shorten(value, MAX_ARG);
  });
  return args;
}

/**
 * Files TeX is reading, from the parentheses of the log: "(./chapitres/intro.tex" opens a file,
 * ")" closes the last one. Approximate (a parenthesis in a message breaks it), so only used to
 * locate warnings, which name a line but no file.
 */
class FileStack {
  private readonly stack: string[] = [];
  private static readonly OPEN =
    /^\(((?:\.\/|\/)[^\s()]*|[^\s()]+\.(?:tex|sty|cls|clo|cfg|def|fd|aux|bbl|toc|lof|lot|out))/;

  read(text: string): void {
    for (let at = 0; at < text.length; at++) {
      const char = text[at];
      if (char === ')') {
        this.stack.pop();
      } else if (char === '(') {
        const match = text.slice(at).match(FileStack.OPEN);
        if (match?.[1]) {
          this.stack.push(match[1]);
          at += match[1].length;
        } else {
          // A parenthesis of a message: keep the stack balanced.
          this.stack.push('');
        }
      }
    }
    if (this.stack.length > 200) this.stack.splice(0, this.stack.length - 200);
  }

  /** Project path of the innermost file being read, if it belongs to the project. */
  current(): string | null {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      const name = this.stack[index];
      if (name) return projectPathOf(name);
    }
    return null;
  }
}

const ERROR_LINE = /^([^:\s][^:]*):(\d+): (.+)$/;
const RUNSYSTEM = /^runsystem\(/;
const LUA_LINE = /^\[\\directlua\]:\d+: /;
const CONTEXT_LINE = /^l\.(\d+) (.*)$/;

/**
 * Finds the errors and the useful warnings of a TeX log written with -file-line-error and a long
 * max_print_line (one message per line). Errors keep their order; at most 50 issues are kept,
 * the counts cover them all.
 */
export function parseLatexLog(log: string): ParsedLog {
  const lines = log.split(/\r?\n/);
  const issues: ParsedIssue[] = [];
  let errorCount = 0;
  let warningCount = 0;
  const seen = new Set<string>();
  const files = new FileStack();

  const add = (issue: ParsedIssue) => {
    if (issue.severity === 'error') errorCount++;
    else warningCount++;
    // The same warning is printed again on every run of latexmk.
    const key = `${issue.id}|${issue.file}|${issue.line}|${JSON.stringify(issue.args)}`;
    if (seen.has(key)) {
      if (issue.severity === 'error') errorCount--;
      else warningCount--;
      return;
    }
    seen.add(key);
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };

  for (let index = 0; index < lines.length; index++) {
    const text = (lines[index] ?? '').slice(0, MAX_LINE);
    let file: string | null = null;
    let line: number | null = null;
    let message: string | null = null;

    const located = text.match(ERROR_LINE);
    if (LUA_LINE.test(text)) {
      // "[\directlua]:1: message": the Lua chunk, not a file of the project.
      message = text;
    } else if (located && !/ Warning: /.test(text)) {
      file = projectPathOf(located[1] ?? '');
      line = Number(located[2]);
      message = located[3] ?? '';
    } else if (text.startsWith('! ')) {
      message = text.slice(2);
    } else if (RUNSYSTEM.test(text)) {
      message = text;
    } else if (/Not reading from .+ \(Integris sandbox\)/.test(text)) {
      message = text.slice(text.indexOf('Not reading from'));
    }

    if (message !== null) {
      const rule = RULES.find((candidate) => candidate.pattern.test(message));
      if (!rule) continue;
      const match = message.match(rule.pattern) as RegExpMatchArray;
      const args = argsOf(rule, match);
      // The context line ("l.42 \fgure") follows within a few lines.
      const context = lines
        .slice(index + 1, index + 6)
        .map((next) => next.match(CONTEXT_LINE))
        .find(Boolean);
      if (line === null && context) line = Number(context[1]);
      if (rule.id === 'undefined_control_sequence') {
        const command = undefinedCommand(context?.[2]);
        if (command) args.command = shorten(command, MAX_ARG);
      }
      // Reading a file outside the project fails as "file not found" (the sandbox has nothing
      // else to read): say why.
      let id: CompileIssueId = rule.id;
      if ((id === 'file_not_found' || id === 'missing_file') && args.file) {
        if (args.file.startsWith('/') || args.file.split('/').includes('..'))
          id = 'outside_project';
      }
      if (id === 'cannot_write' && args.file) {
        const name = args.file;
        if (name.startsWith('/') || name.startsWith('.') || name.split('/').includes('..')) {
          id = 'write_refused';
        }
      }
      add({ id, severity: rule.severity, file, line, args, raw: shorten(text, MAX_RAW) });
      continue;
    }

    let warned = false;
    for (const rule of WARNING_RULES) {
      const match = text.match(rule.pattern);
      if (!match) continue;
      warned = true;
      const args = argsOf(rule, match);
      const warningLine = args.line ? Number(args.line) : null;
      delete args.line;
      add({
        id: rule.id,
        severity: 'warning',
        file: files.current(),
        line: warningLine,
        args,
        raw: shorten(text, MAX_RAW),
      });
      break;
    }
    if (!warned) files.read(text);
  }

  return { issues, errorCount, warningCount };
}

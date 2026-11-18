import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippet,
  snippetCompletion,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import {
  CITATION_COMMANDS,
  LATEX_COMMANDS,
  LATEX_ENVIRONMENTS,
  REFERENCE_COMMANDS,
} from './latex-words';
import type { ProjectSymbol } from './symbols';

/** Symbols of the whole project, read when the completion opens (they change as files load). */
export interface ProjectSymbols {
  labels: ProjectSymbol[];
  citations: ProjectSymbol[];
  commands: (ProjectSymbol & { args: number })[];
  environments: ProjectSymbol[];
}

export interface CompletionLabels {
  /** Detail of a label or citation: the file defining it. */
  inFile: (path: string) => string;
  command: string;
  environment: string;
}

/** `\frac{…}{…}`: one snippet field per mandatory argument. */
const snippetOf = (name: string, args: number) => `\\${name}${'{${}}'.repeat(args)}`;

function commandOptions(symbols: ProjectSymbols, labels: CompletionLabels): Completion[] {
  const seen = new Set<string>();
  const options: Completion[] = [];
  for (const command of [...LATEX_COMMANDS, ...symbols.commands]) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    const args = command.args ?? 0;
    const detail = 'path' in command ? labels.inFile(command.path as string) : labels.command;
    options.push(
      args > 0
        ? snippetCompletion(snippetOf(command.name, args), {
            label: `\\${command.name}`,
            detail,
            type: 'function',
          })
        : { label: `\\${command.name}`, detail, type: 'keyword' },
    );
  }
  return options;
}

/**
 * `\begin{env}` completed with its body and the matching `\end{env}`. The closing brace is
 * usually there already (brackets close themselves): it is replaced, not doubled.
 */
function beginEnvironment(environment: string) {
  const insert = snippet(`${environment}}\n\t\${}\n\\end{${environment}}`);
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const closed = view.state.sliceDoc(to, to + 1) === '}';
    insert(view, completion, from, closed ? to + 1 : to);
  };
}

// Command, optional arguments (`\autocite[p.~3][]{`), then the braced argument being typed.
const BEFORE_ARGUMENT = /\\([a-zA-Z]+\*?)\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)$/;

/**
 * LaTeX completion: commands after `\`, environments in `\begin{`/`\end{` (`\begin` inserts the
 * matching `\end`), labels in `\ref{…}` and the like, bibliography keys in `\cite{…}`.
 */
export function latexCompletion(
  symbols: () => ProjectSymbols,
  labels: CompletionLabels,
  /** The other files of the project, read on the first \ref or \cite. */
  index: { ready: () => boolean; load: () => Promise<void> },
) {
  const keys = (isReference: boolean, from: number): CompletionResult => ({
    from,
    options: (isReference ? symbols().labels : symbols().citations).map((symbol) => ({
      label: symbol.name,
      detail: symbol.detail ?? labels.inFile(symbol.path),
      info: symbol.detail ? labels.inFile(symbol.path) : undefined,
      type: isReference ? 'constant' : 'text',
    })),
    validFor: /^[^\s,{}]*$/,
  });

  return (
    context: CompletionContext,
  ): CompletionResult | null | Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const argument = BEFORE_ARGUMENT.exec(before);
    if (argument) {
      const [, command, typed] = argument;
      const name = command!.replace(/\*$/, '');
      // Only the key being typed in a list like \cite{a,b,…}.
      const word = typed!.slice(typed!.lastIndexOf(',') + 1).trimStart();
      const from = context.pos - word.length;
      if (name === 'begin' || name === 'end') {
        const environments = [
          ...LATEX_ENVIRONMENTS.map((environment) => ({
            name: environment,
            detail: labels.environment,
          })),
          ...symbols().environments.map((environment) => ({
            name: environment.name,
            detail: labels.inFile(environment.path),
          })),
        ];
        const unique = [...new Map(environments.map((item) => [item.name, item])).values()];
        return {
          from,
          options: unique.map(({ name: environment, detail }) =>
            name === 'begin'
              ? { label: environment, detail, type: 'type', apply: beginEnvironment(environment) }
              : { label: environment, detail, type: 'type' },
          ),
          validFor: /^[a-zA-Z*]*$/,
        };
      }
      const isReference = REFERENCE_COMMANDS.includes(name);
      const isCitation = CITATION_COMMANDS.test(name);
      if (isReference || isCitation) {
        // Shown as soon as the braces are typed, once the project files are read.
        if (index.ready()) return keys(isReference, from);
        return index.load().then(() => keys(isReference, from));
      }
      return null;
    }
    const command = context.matchBefore(/\\[a-zA-Z@]*/);
    if (!command || (command.from === command.to && !context.explicit)) return null;
    return {
      from: command.from,
      options: commandOptions(symbols(), labels),
      validFor: /^\\[a-zA-Z@]*$/,
    };
  };
}

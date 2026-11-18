/**
 * Common LaTeX commands and environments offered by the autocompletion. `args` is the number of
 * mandatory arguments inserted as `{}` placeholders.
 */
export interface LatexCommand {
  name: string;
  args?: number;
}

const plain = (names: string) => names.split(' ').map((name) => ({ name }));
const withArgs = (args: number, names: string) => names.split(' ').map((name) => ({ name, args }));

export const LATEX_COMMANDS: readonly LatexCommand[] = [
  // Document structure
  ...withArgs(1, 'documentclass usepackage'),
  ...withArgs(1, 'part chapter section subsection subsubsection paragraph subparagraph'),
  ...withArgs(1, 'title author date thanks'),
  ...plain('maketitle tableofcontents listoffigures listoftables appendix frontmatter mainmatter'),
  ...plain('backmatter printbibliography today centering raggedright raggedleft noindent'),
  ...withArgs(1, 'input include includeonly bibliography bibliographystyle addbibresource'),
  ...withArgs(1, 'begin end'),
  // References and citations
  ...withArgs(1, 'label ref eqref pageref autoref nameref cref Cref'),
  ...withArgs(1, 'cite citep citet parencite textcite autocite footcite nocite'),
  ...withArgs(1, 'footnote footnotetext url'),
  ...withArgs(2, 'href'),
  // Text formatting
  ...withArgs(1, 'textbf textit emph underline texttt textsc textsf textrm textup textsl'),
  ...withArgs(1, 'textsuperscript textsubscript mbox fbox makebox text'),
  ...plain('bfseries itshape ttfamily scshape sffamily rmfamily normalfont upshape'),
  ...plain('tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge'),
  ...withArgs(2, 'textcolor colorbox'),
  ...withArgs(1, 'color'),
  // Spacing and layout
  ...plain('newline linebreak newpage clearpage cleardoublepage pagebreak nopagebreak'),
  ...plain('smallskip medskip bigskip hfill vfill quad qquad indent par item'),
  ...withArgs(1, 'hspace vspace'),
  ...withArgs(1, 'pagestyle thispagestyle pagenumbering setlength'),
  ...withArgs(2, 'setcounter addtocounter'),
  // Figures and tables
  ...withArgs(1, 'includegraphics'),
  ...withArgs(1, 'caption'),
  ...plain('hline toprule midrule bottomrule centering'),
  ...withArgs(1, 'cline multicolumn multirow'),
  // Definitions
  ...withArgs(2, 'newcommand renewcommand providecommand'),
  ...withArgs(3, 'newenvironment renewenvironment'),
  ...withArgs(2, 'newtheorem DeclareMathOperator'),
  // Mathematics
  ...withArgs(2, 'frac dfrac tfrac binom'),
  ...withArgs(1, 'sqrt'),
  ...withArgs(1, 'mathbb mathcal mathbf mathrm mathit mathsf mathfrak boldsymbol operatorname'),
  ...withArgs(1, 'hat bar vec tilde dot ddot overline underline overbrace underbrace'),
  ...plain('sum prod int iint iiint oint lim limsup liminf sup inf max min'),
  ...plain('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa'),
  ...plain('lambda mu nu xi pi varpi rho sigma tau upsilon phi varphi chi psi omega'),
  ...plain('Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega'),
  ...plain('infty partial nabla cdot cdots ldots dots times div pm mp leq geq neq approx'),
  ...plain('equiv sim simeq propto in notin subset subseteq supset cup cap emptyset forall'),
  ...plain('exists neg land lor implies iff to mapsto rightarrow leftarrow Rightarrow'),
  ...plain('Leftarrow leftrightarrow Leftrightarrow left right big Big bigg Bigg'),
  ...plain('sin cos tan log ln exp det'),
] as const;

export const LATEX_ENVIRONMENTS: readonly string[] = [
  'document',
  'abstract',
  'itemize',
  'enumerate',
  'description',
  'figure',
  'figure*',
  'table',
  'table*',
  'tabular',
  'tabularx',
  'longtable',
  'center',
  'flushleft',
  'flushright',
  'quote',
  'quotation',
  'verse',
  'verbatim',
  'minipage',
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'split',
  'cases',
  'matrix',
  'pmatrix',
  'bmatrix',
  'array',
  'theorem',
  'lemma',
  'proposition',
  'corollary',
  'definition',
  'proof',
  'remark',
  'example',
  'thebibliography',
  'titlepage',
  'frame',
  'columns',
  'column',
  'subfigure',
  'lstlisting',
];

/** Commands whose argument is a label (`\ref{…}` completes with the labels of the project). */
export const REFERENCE_COMMANDS = [
  'ref',
  'eqref',
  'pageref',
  'autoref',
  'nameref',
  'cref',
  'Cref',
  'vref',
];

/** Commands whose argument is a list of bibliography keys. */
export const CITATION_COMMANDS =
  /^(?:no)?cite[a-zA-Z]*$|^(?:paren|text|auto|foot|super|full)cite\*?$|^citep?\*?$|^citet\*?$/;

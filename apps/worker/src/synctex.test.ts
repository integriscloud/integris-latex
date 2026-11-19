import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildSynctexIndex } from './synctex.js';

// Excerpt of a pdfTeX SyncTeX file (article class, one page).
const SYNCTEX = `SyncTeX Version:1
Input:1:/work/./main.tex
Input:2:/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls
Input:3:/work/./chapitres/intro.tex
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
!358
{1
[1,1:4736286,46220574:26673152,41484288,0
(1,7:8799518,6571294:22609920,455111,0
x1,7:11257121,6571294
)
(2,40:8799518,9000000:22609920,455111,0
)
(3,12,-1:8799518,11032290:22609920,647495,10000
)
]
}1
Input:4:/work/./main.aux
Postamble:
`;

describe('buildSynctexIndex', () => {
  it('keeps the boxes of project files, in PDF points from the top-left corner', () => {
    const index = buildSynctexIndex(gzipSync(SYNCTEX));
    expect(index?.inputs).toEqual(['main.tex', 'chapitres/intro.tex']);
    expect(index?.pages).toHaveLength(1);
    const boxes = index!.pages[0]!;
    // The box of article.cls (input 2) is left out.
    expect(boxes.map(([input, line]) => [input, line])).toEqual([
      [0, 7],
      [0, 7],
      [1, 12],
    ]);
    // 8799518 sp = 133.77 bp (1 inch + the left margin of article).
    expect(boxes[0]!.slice(2)).toEqual([133.77, 99.9, 343.71, 6.92, 0]);
  });

  it('returns null for unreadable data or a document without project files', () => {
    expect(buildSynctexIndex(Buffer.from('not gzip'))).toBeNull();
    expect(buildSynctexIndex(gzipSync('SyncTeX Version:1\nContent:\n'))).toBeNull();
  });
});

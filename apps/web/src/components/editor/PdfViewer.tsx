'use client';

import { Alert, Button, IconButton } from '@integris/ui';
import { ChevronDown, ChevronUp, Download, MoveHorizontal, ZoomIn, ZoomOut } from 'lucide-react';
import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PdfArea } from '../../lib/pdf/synctex';
import styles from './pdf-viewer.module.css';

/** Zoom levels offered by the buttons; "fit" follows the width of the pane. */
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** CSS pixels per PDF point at 100 %. */
const CSS_PER_POINT = 96 / 72;

type PdfJs = typeof PdfJsModule;
let pdfjs: Promise<PdfJs> | null = null;

/**
 * PDF.js and its worker, loaded once, only when a PDF is shown. The legacy build: the default
 * one calls JavaScript methods missing from browsers still in use (`Map.getOrInsertComputed`
 * needs Firefox 144 and Chrome 145, `Math.sumPrecise` Chrome 147). It still needs the
 * polyfills of lib/polyfills.ts for the oldest browsers of the target (Firefox 120, iOS 15).
 */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= import('../../lib/polyfills')
    .then(() => import('pdfjs-dist/legacy/build/pdf.mjs'))
    .then((module) => {
      module.GlobalWorkerOptions.workerPort = new Worker(
        new URL('../../lib/pdf/pdf-worker.ts', import.meta.url),
        { type: 'module' },
      );
      return module;
    });
  return pdfjs;
}

export interface PdfViewerLabels {
  toolbar: string;
  previous: string;
  next: string;
  page: (page: number, pages: number) => string;
  zoomIn: string;
  zoomOut: string;
  fit: string;
  download: string;
  loading: string;
  failed: string;
  retry: string;
  pageLabel: (page: number) => string;
}

export interface PdfViewerProps {
  /** Identifies the PDF: a new key loads a new document (a renewed link does not). */
  documentKey: string;
  url: string;
  downloadUrl: string;
  labels: PdfViewerLabels;
  /** Area to show (code → PDF), highlighted briefly. */
  highlight: (PdfArea & { at: number }) | null;
  /** Double-click on a page (PDF → code), in points from the top-left corner. */
  onInverse?: (page: number, x: number, y: number) => void;
}

interface PageSize {
  width: number;
  height: number;
}

/**
 * PDF.js viewer of the editor: pages drawn on canvases when they come into view, zoom, page
 * navigation and download. The PDF comes from the files domain by a signed link (CORS); its
 * scripts never run (PDF.js runs none without its scripting sandbox, not loaded here) and its
 * text is not selectable in V1.
 */
export function PdfViewer({
  documentKey,
  url,
  downloadUrl,
  labels,
  highlight,
  onInverse,
}: PdfViewerProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const marks = useRef<(HTMLDivElement | null)[]>([]);
  const rendered = useRef(new Map<number, number>());
  const tasks = useRef(new Map<number, RenderTask>());
  const latestUrl = useRef(url);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);

  useLayoutEffect(() => {
    latestUrl.current = url;
  }, [url]);

  // A new document (new compilation): load it, keeping the reading position.
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    const position = scroller.current
      ? scroller.current.scrollTop / Math.max(scroller.current.scrollHeight, 1)
      : 0;
    void loadPdfJs()
      .then(async (module) => {
        task = module.getDocument({
          url: latestUrl.current,
          disableRange: true,
          disableStream: true,
          withCredentials: false,
        });
        const loaded = await task.promise;
        const pageSizes: PageSize[] = [];
        for (let number = 1; number <= loaded.numPages; number++) {
          const viewport = (await loaded.getPage(number)).getViewport({ scale: 1 });
          pageSizes.push({ width: viewport.width, height: viewport.height });
        }
        if (cancelled) {
          void loaded.loadingTask.destroy();
          return;
        }
        rendered.current.clear();
        setFailed(false);
        setSizes(pageSizes);
        setDoc((previous) => {
          void previous?.loadingTask.destroy();
          return loaded;
        });
        requestAnimationFrame(() => {
          if (scroller.current)
            scroller.current.scrollTop = position * scroller.current.scrollHeight;
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [documentKey, attempt]);

  useEffect(() => () => void doc?.loadingTask.destroy(), [doc]);

  // Width available for the pages ("fit" zoom).
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const widest = sizes.reduce((max, size) => Math.max(max, size.width), 0) || 595;
  /** CSS pixels per PDF point. */
  const scale = zoom === 'fit' ? Math.max(width - 32, 120) / widest : zoom * CSS_PER_POINT;

  useLayoutEffect(() => {
    column.current?.style.setProperty('--pdf-column', `${Math.round(widest * scale)}px`);
  }, [widest, scale]);

  const renderPage = useCallback(
    async (number: number) => {
      const canvas = canvases.current[number - 1];
      if (!doc || !canvas || rendered.current.get(number) === scale) return;
      rendered.current.set(number, scale);
      tasks.current.get(number)?.cancel();
      const page = await doc.getPage(number);
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const task = page.render({ canvas, viewport });
      tasks.current.set(number, task);
      try {
        await task.promise;
      } catch {
        // Cancelled by a newer rendering of the same page.
      }
    },
    [doc, scale],
  );

  // Pages are drawn when they come near the visible area; the current page follows the scroll.
  useEffect(() => {
    const root = scroller.current;
    if (!doc || !root) return;
    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const number = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) {
            visible.add(number);
            void renderPage(number);
          } else {
            visible.delete(number);
          }
        }
        if (visible.size) setCurrent(Math.min(...visible));
      },
      { root, rootMargin: '200px 0px' },
    );
    for (const canvas of canvases.current) {
      if (canvas?.parentElement) observer.observe(canvas.parentElement);
    }
    return () => observer.disconnect();
  }, [doc, renderPage, sizes.length]);

  // Code → PDF: scroll to the area and outline it.
  useEffect(() => {
    if (!highlight || !doc) return;
    const mark = marks.current[highlight.page - 1];
    const size = sizes[highlight.page - 1];
    if (!mark || !size) return;
    mark.style.setProperty('--mark-left', `${(highlight.x / size.width) * 100}%`);
    mark.style.setProperty('--mark-top', `${(highlight.y / size.height) * 100}%`);
    mark.style.setProperty('--mark-width', `${(highlight.width / size.width) * 100}%`);
    mark.style.setProperty('--mark-height', `${(highlight.height / size.height) * 100}%`);
    mark.dataset.active = 'true';
    mark.scrollIntoView({ block: 'center' });
    const timer = setTimeout(() => {
      mark.dataset.active = 'false';
    }, 2500);
    return () => clearTimeout(timer);
  }, [highlight, doc, sizes]);

  const goToPage = (number: number) => {
    const target = canvases.current[number - 1]?.parentElement;
    target?.scrollIntoView({ block: 'start' });
  };

  const zoomBy = (direction: 1 | -1) => {
    const now = zoom === 'fit' ? scale / CSS_PER_POINT : zoom;
    const next =
      direction > 0
        ? (ZOOMS.find((level) => level > now + 0.01) ?? ZOOMS.at(-1)!)
        : ([...ZOOMS].reverse().find((level) => level < now - 0.01) ?? ZOOMS[0]!);
    setZoom(next);
  };

  const onDoubleClick = (number: number, event: React.MouseEvent<HTMLCanvasElement>) => {
    const size = sizes[number - 1];
    if (!onInverse || !size) return;
    const box = event.currentTarget.getBoundingClientRect();
    onInverse(
      number,
      ((event.clientX - box.left) / box.width) * size.width,
      ((event.clientY - box.top) / box.height) * size.height,
    );
  };

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar} role="toolbar" aria-label={labels.toolbar}>
        <IconButton
          icon={ChevronUp}
          label={labels.previous}
          disabled={!doc || current <= 1}
          onClick={() => goToPage(current - 1)}
        />
        <span className={styles.pageNumber} aria-live="polite">
          {doc ? labels.page(current, doc.numPages) : ''}
        </span>
        <IconButton
          icon={ChevronDown}
          label={labels.next}
          disabled={!doc || current >= doc.numPages}
          onClick={() => goToPage(current + 1)}
        />
        <span className={styles.spacer} />
        <IconButton
          icon={ZoomOut}
          label={labels.zoomOut}
          disabled={!doc}
          onClick={() => zoomBy(-1)}
        />
        <span className={styles.zoom}>{Math.round((scale / CSS_PER_POINT) * 100)} %</span>
        <IconButton icon={ZoomIn} label={labels.zoomIn} disabled={!doc} onClick={() => zoomBy(1)} />
        <IconButton
          icon={MoveHorizontal}
          label={labels.fit}
          aria-pressed={zoom === 'fit'}
          disabled={!doc}
          onClick={() => setZoom('fit')}
        />
        <a
          className={styles.download}
          href={downloadUrl}
          rel="noopener noreferrer"
          aria-label={labels.download}
          title={labels.download}
        >
          <Download size={20} strokeWidth={1.75} aria-hidden="true" />
        </a>
      </div>
      <div ref={scroller} className={styles.pages}>
        {failed ? (
          <div className={styles.message}>
            <Alert tone="error">{labels.failed}</Alert>
            <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
              {labels.retry}
            </Button>
          </div>
        ) : !doc ? (
          <p className={styles.message} role="status">
            {labels.loading}
          </p>
        ) : (
          <div ref={column} className={styles.column}>
            {sizes.map((size, index) => (
              <div key={`${documentKey}-${index}`} className={styles.page} data-page={index + 1}>
                <canvas
                  ref={(element) => {
                    canvases.current[index] = element;
                  }}
                  className={styles.canvas}
                  width={Math.round(size.width)}
                  height={Math.round(size.height)}
                  aria-label={labels.pageLabel(index + 1)}
                  onDoubleClick={(event) => onDoubleClick(index + 1, event)}
                />
                <div
                  ref={(element) => {
                    marks.current[index] = element;
                  }}
                  className={styles.mark}
                  aria-hidden="true"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

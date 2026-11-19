// Entry of the PDF.js worker, bundled by Next.js as a separate module worker (same origin).
// The polyfills of the browser target come first; then the legacy build, like the main thread
// (components/editor/PdfViewer.tsx).
import '../polyfills';
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';

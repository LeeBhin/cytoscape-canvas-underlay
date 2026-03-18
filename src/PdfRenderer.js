/**
 * PDF rendering helper using pdfjs-dist.
 * Only loaded when a PDF source is used.
 */

let pdfjsLib = null;

function getPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  try {
    pdfjsLib = globalThis.__pdfjsLib || null;
    if (!pdfjsLib) {
      // Try dynamic import hint — caller should have already loaded pdfjs-dist
      throw new Error('pdfjs-dist not found');
    }
  } catch {
    throw new Error(
      'cytoscape-canvas-underlay: pdfjs-dist is required for PDF sources. ' +
      'Install it and set globalThis.__pdfjsLib or call setPdfjs() before use.'
    );
  }
  return pdfjsLib;
}

/**
 * Manually provide the pdfjs-dist module reference.
 * @param {object} lib - The pdfjs-dist module (e.g. `import * as pdfjsLib from 'pdfjs-dist'`)
 */
export function setPdfjs(lib) {
  pdfjsLib = lib;
}

// Cache loaded PDF documents by URL
const docCache = new Map();

/**
 * Load a PDF document (cached).
 * @param {string} url
 * @returns {Promise<{doc, baseScale: number}>}
 */
export async function loadPdf(url, pdfOptions = {}) {
  if (docCache.has(url)) return docCache.get(url);

  const lib = getPdfjs();
  const loadingTask = lib.getDocument({ url, cMapPacked: true, ...pdfOptions });
  const doc = await loadingTask.promise;

  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const baseScale = 1; // normalised; caller provides desired dimensions

  const entry = { doc, baseScale, pageViewports: [vp] };
  docCache.set(url, entry);
  return entry;
}

/**
 * Render a specific PDF page to an OffscreenCanvas (or regular canvas).
 * Returns the canvas for drawing.
 *
 * @param {object} doc - PDFDocumentProxy
 * @param {number} pageNum - 1-based page number
 * @param {number} renderWidth - desired output width in px
 * @param {number} renderHeight - desired output height in px
 * @param {AbortSignal} [signal]
 * @returns {Promise<{canvas, width, height}>}
 */
export async function renderPdfPage(doc, pageNum, renderWidth, renderHeight, signal) {
  const page = await doc.getPage(pageNum);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const vp = page.getViewport({ scale: 1 });
  const scaleX = renderWidth / vp.width;
  const scaleY = renderHeight / vp.height;
  const scale = Math.min(scaleX, scaleY);

  const w = Math.ceil(vp.width * scale);
  const h = Math.ceil(vp.height * scale);

  // Clamp canvas dimensions to avoid GPU memory issues
  const maxDim = 8192;
  const clampedW = Math.min(w, maxDim);
  const clampedH = Math.min(h, maxDim);

  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(clampedW, clampedH);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = clampedW;
    canvas.height = clampedH;
  }

  const ctx = canvas.getContext('2d');
  const finalScale = Math.min(clampedW / vp.width, clampedH / vp.height);

  const renderTask = page.render({
    canvasContext: ctx,
    viewport: page.getViewport({ scale: finalScale }),
  });

  if (signal) {
    signal.addEventListener('abort', () => renderTask.cancel(), { once: true });
  }

  await renderTask.promise;
  return { canvas, width: clampedW, height: clampedH };
}

/**
 * Clear the PDF document cache.
 */
export function clearPdfCache() {
  for (const entry of docCache.values()) {
    entry.doc.destroy();
  }
  docCache.clear();
}

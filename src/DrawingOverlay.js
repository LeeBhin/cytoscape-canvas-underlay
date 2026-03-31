/**
 * Core drawing overlay engine.
 * Renders image/PDF backgrounds behind Cytoscape graph, synced to zoom/pan.
 * Supports a main drawing + multiple additional drawings.
 */
import { loadPdf } from './PdfRenderer.js';
import { Minimap } from './Minimap.js';

const DEFAULTS = {
  // ── Source ──
  source: null,              // URL string (image or PDF)
  page: 1,                   // PDF page number (1-based)

  // ── Appearance ──
  opacity: 1,                // Background opacity (0–1)
  brightness: 1,             // CSS brightness filter (0–2)
  contrast: 1,               // CSS contrast filter (0–2)
  saturate: 1,               // CSS saturate filter (0–2)
  grayscale: 0,              // CSS grayscale filter (0–1)
  invert: 0,                 // CSS invert filter (0–1)
  rotation: 0,               // Drawing rotation in degrees (0, 90, 180, 270)
  backgroundColor: null,     // Canvas background color (null = transparent)

  // ── Layout ──
  zIndex: 0,                 // Canvas z-index within overlay container
  fitOnLoad: true,           // Auto-fit drawing to viewport on load
  fitPadding: 50,            // Padding (px) for fit operations

  // ── Pan Clamping ──
  panClamp: false,           // Prevent panning too far from drawing bounds
  panClampPadding: 200,      // Extra padding (px) beyond drawing bounds
  panClampMode: 'soft',      // 'hard' = strict boundary, 'soft' = spring-back

  // ── Visibility ──
  drawingVisible: true,      // Show/hide the background drawing
  graphVisible: true,        // Show/hide the cytoscape graph layer

  // ── PDF Quality ──
  qualityDelay: 100,         // ms delay before high-quality PDF re-render
  pdfMinRenderSize: 2048,    // Minimum PDF render dimension (px)
  pdfMaxRenderSize: 8192,    // Maximum PDF render dimension (px)
  pdfClipPadding: 0.5,       // Extra render margin around visible area (0.5 = 50% each side)

  // ── PDF Options ──
  pdfOptions: {},            // Extra options passed to pdfjs getDocument()

  // ── Minimap ──
  minimap: null,             // Minimap options object or false. See Minimap defaults.

  // ── Legacy Callbacks (prefer on()/off() event emitter) ──
  onSourceLoad: null,        // (source, {width, height}) => void
  onSourceError: null,       // (source, error) => void
  onZoom: null,              // (zoomLevel) => void
  onPan: null,               // ({x, y}) => void
  onDrawingVisibilityChange: null, // (visible) => void
};

/* ── Helpers ── */

async function loadDrawingState(state, url, page, sourceType, pdfOptions) {
  state.source = url;
  state.page = page;
  state.isPdf = sourceType === 'pdf' || (sourceType !== 'image' && /\.pdf(\?|$)/i.test(url));

  if (state.isPdf) {
    const { doc } = await loadPdf(url, pdfOptions);
    state.pdfDoc = doc;
    state.img = null;
    const pdfPage = await doc.getPage(page);
    state.pdfPage = pdfPage;
    const vp = pdfPage.getViewport({ scale: 1 });
    state.w = vp.width;
    state.h = vp.height;
    // baseScale maps PDF points → drawing pixel coordinates
    // will be recalculated after dimension overrides
    state.baseScale = state.w / vp.width;
  } else {
    await new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        state.img = img;
        state.pdfDoc = null;
        state.w = img.naturalWidth;
        state.h = img.naturalHeight;
        resolve();
      };
      img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
      img.src = url;
    });
  }
}

/**
 * Render only the visible portion of a PDF page (viewport-based clipping).
 * Output canvas maps ~1:1 to screen pixels for crisp rendering at any zoom.
 *
 * @param {object} state - Drawing state with pdfDoc, pdfPage, w, h, baseScale
 * @param {{ x: number, y: number, w: number, h: number }} clipRect - Visible area in drawing coords
 * @param {number} zoom - Current cytoscape zoom level
 * @param {object} opts - Plugin options (pdfMinRenderSize, pdfMaxRenderSize)
 * @param {AbortSignal} [signal]
 */
async function renderPdfClipToState(state, clipRect, zoom, opts, signal) {
  if (!state.pdfDoc || !state.pdfPage) return;

  const dpr = window.devicePixelRatio || 1;
  const minSize = opts.pdfMinRenderSize || 2048;
  const maxSize = opts.pdfMaxRenderSize || 8192;

  // Clamp clip rect to drawing bounds
  const x0 = Math.max(0, clipRect.x);
  const y0 = Math.max(0, clipRect.y);
  const x1 = Math.min(state.w, clipRect.x + clipRect.w);
  const y1 = Math.min(state.h, clipRect.y + clipRect.h);
  const cw = x1 - x0;
  const ch = y1 - y0;

  if (cw <= 0 || ch <= 0) {
    state.pdfCanvas = null;
    state.pdfClip = null;
    return;
  }

  // Target canvas size in screen pixels
  let canvasW = Math.ceil(cw * zoom * dpr);
  let canvasH = Math.ceil(ch * zoom * dpr);

  if (canvasW <= 0 || canvasH <= 0) return;

  // Enforce minimum canvas resolution to prevent PDF.js minimum line-width artifacts
  const curMax = Math.max(canvasW, canvasH);
  if (curMax < minSize) {
    const up = minSize / curMax;
    canvasW = Math.ceil(canvasW * up);
    canvasH = Math.ceil(canvasH * up);
  }

  // Clamp to prevent GPU memory exhaustion
  const maxDim = Math.max(canvasW, canvasH);
  if (maxDim > maxSize) {
    const down = maxSize / maxDim;
    canvasW = Math.round(canvasW * down);
    canvasH = Math.round(canvasH * down);
  }

  // PDF scale: maps PDF points → canvas pixels for the clipped region
  const pdfScale = (canvasW * state.baseScale) / cw;

  // Use viewport offsetX/offsetY — pdf.js internally calls ctx.setTransform()
  // for patterns/transparency groups, which would override a manual ctx.translate()
  const vpOffsetX = -(x0 * pdfScale / state.baseScale);
  const vpOffsetY = -(y0 * pdfScale / state.baseScale);
  const viewport = state.pdfPage.getViewport({ scale: pdfScale, offsetX: vpOffsetX, offsetY: vpOffsetY });

  const offscreen = new OffscreenCanvas(canvasW, canvasH);
  const ctx = offscreen.getContext('2d');

  if (signal?.aborted) return;

  const renderTask = state.pdfPage.render({
    canvasContext: ctx,
    viewport,
    intent: 'display',
  });

  if (signal) {
    signal.addEventListener('abort', () => renderTask.cancel(), { once: true });
  }

  try {
    await renderTask.promise;
  } catch (err) {
    if (err.name === 'RenderingCancelledException' || err.name === 'AbortError') return;
    throw err;
  }

  state.pdfCanvas = offscreen;
  state.pdfClip = { x: x0, y: y0, w: cw, h: ch };
}

function buildFilterString(opts) {
  const parts = [];
  // invert를 먼저 적용해야 brightness/contrast가 반전 후 결과에 작용
  if (opts.invert > 0) parts.push(`invert(${opts.invert})`);
  if (opts.brightness !== 1) parts.push(`brightness(${opts.brightness})`);
  if (opts.contrast !== 1) parts.push(`contrast(${opts.contrast})`);
  if (opts.saturate !== 1) parts.push(`saturate(${opts.saturate})`);
  if (opts.grayscale > 0) parts.push(`grayscale(${opts.grayscale})`);
  return parts.length ? parts.join(' ') : 'none';
}

/* ── Main Class ── */

export class DrawingOverlay {
  constructor(cy, userOpts = {}) {
    this.cy = cy;
    this.opts = { ...DEFAULTS, ...userOpts };
    this.canvas = null;
    this.ctx = null;

    // Main drawing state
    this._main = { source: null, img: null, pdfDoc: null, pdfPage: null, pdfCanvas: null, pdfClip: null, baseScale: 1, w: 0, h: 0, isPdf: false, page: 1 };
    this._loading = false;
    this._destroyed = false;

    // Additional drawings
    this._drawings = new Map();

    // RAF / debounce
    this._rafId = null;
    this._qualityTimer = null;
    this._abortController = null;

    // Pan clamping re-entry guard
    this._isPanAdjusting = false;

    // Rubber-band pan clamping state
    this._isUserDragging = false;
    this._rubberBandRaf = null;
    this._rubberBandDebtX = 0;
    this._rubberBandDebtY = 0;

    // Graph visibility
    this._graphHidden = false;
    this._savedGraphStyles = null;

    // Minimap
    this._minimap = null;

    // Event emitter
    this._listeners = new Map();

    this._init();
  }

  /* ═══════════════════════════════════════
     Lifecycle
     ═══════════════════════════════════════ */

  _init() {
    const container = this.cy.container();
    if (!container) return;

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `
      position: absolute; top: 0; left: 0;
      z-index: ${this.opts.zIndex};
      pointer-events: none;
    `;

    // Insert canvas before cytoscape's first child (direct child only)
    const firstChild = container.firstChild;
    if (firstChild) {
      container.insertBefore(this.canvas, firstChild);
    } else {
      container.appendChild(this.canvas);
    }

    this._setupCanvas();
    this._bindEvents();

    // Apply initial visibility
    if (!this.opts.graphVisible) this._hideGraph();
    if (!this.opts.drawingVisible) this.canvas.style.display = 'none';

    // Minimap
    if (this.opts.minimap) {
      this._minimap = new Minimap(this, { enabled: true, ...this.opts.minimap });
    }

    if (this.opts.source) {
      this.setSource(this.opts.source, this.opts.page);
    }
  }

  _setupCanvas() {
    const rect = this.cy.container().getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(rect.width);
    const ch = Math.round(rect.height);
    const tw = Math.round(cw * dpr);
    const th = Math.round(ch * dpr);
    if (this.canvas.width !== tw || this.canvas.height !== th) {
      this.canvas.width = tw;
      this.canvas.height = th;
      this.canvas.style.width = `${cw}px`;
      this.canvas.style.height = `${ch}px`;
    }
    this.ctx = this.canvas.getContext('2d');
  }

  _bindEvents() {
    this._onViewport = () => {
      this._enforceLimits();
      this._scheduleRedraw();
    };
    this._onResize = () => {
      this._setupCanvas();
      this._scheduleRedraw();
      const rect = this.cy.container().getBoundingClientRect();
      this._emit('resize', { width: rect.width, height: rect.height });
    };

    this.cy.on('zoom', this._onViewport);
    this.cy.on('pan', this._onViewport);
    this._resizeObserver = new ResizeObserver(this._onResize);
    this._resizeObserver.observe(this.cy.container());

    // Track user drag for rubber-band pan clamping
    this._onContainerMouseDown = () => {
      this._isUserDragging = true;
      this._cancelSpringBack();
      this._rubberBandDebtX = 0;
      this._rubberBandDebtY = 0;
    };
    this._onContainerMouseUp = () => {
      this._isUserDragging = false;
      this._rubberBandDebtX = 0;
      this._rubberBandDebtY = 0;
      this._springBackIfNeeded();
    };
    const container = this.cy.container();
    container.addEventListener('mousedown', this._onContainerMouseDown);
    window.addEventListener('mouseup', this._onContainerMouseUp);
  }

  destroy() {
    this._destroyed = true;
    this._cancelSpringBack();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._qualityTimer) clearTimeout(this._qualityTimer);
    if (this._abortController) this._abortController.abort();

    // Remove rubber-band drag listeners
    const container = this.cy.container();
    if (container) container.removeEventListener('mousedown', this._onContainerMouseDown);
    window.removeEventListener('mouseup', this._onContainerMouseUp);

    this.cy.off('zoom', this._onViewport);
    this.cy.off('pan', this._onViewport);
    if (this._resizeObserver) this._resizeObserver.disconnect();

    // Destroy minimap
    if (this._minimap) { this._minimap.destroy(); this._minimap = null; }

    // Restore graph visibility
    if (this._graphHidden) this._showGraph();

    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    this._main = { source: null, img: null, pdfDoc: null, pdfPage: null, pdfCanvas: null, pdfClip: null, baseScale: 1, w: 0, h: 0, isPdf: false, page: 1 };
    this._drawings.clear();
    this._listeners.clear();
    this.ctx = null;
    this.canvas = null;
  }

  /* ═══════════════════════════════════════
     Event Emitter
     ═══════════════════════════════════════ */

  /**
   * Subscribe to an event.
   * Events: sourceLoad, sourceError, zoom, pan, drawingVisibilityChange,
   *         drawingAdd, drawingRemove, rotate, resize
   * @param {string} event
   * @param {Function} fn
   * @returns {this}
   */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }

  /**
   * Unsubscribe from an event. If fn is omitted, removes all listeners for the event.
   */
  off(event, fn) {
    if (fn) {
      this._listeners.get(event)?.delete(fn);
    } else {
      this._listeners.delete(event);
    }
    return this;
  }

  /**
   * Subscribe to an event, but only fire once.
   */
  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    wrapper._original = fn;
    return this.on(event, wrapper);
  }

  /**
   * Emit an event. Fires both new-style listeners and legacy onXxx callbacks.
   */
  _emit(event, ...args) {
    const fns = this._listeners.get(event);
    if (fns) {
      for (const fn of fns) {
        try { fn(...args); } catch (e) { console.error(`[canvasUnderlay] event "${event}" handler error:`, e); }
      }
    }
    // Legacy callback: onSourceLoad, onSourceError, etc.
    const cbName = 'on' + event.charAt(0).toUpperCase() + event.slice(1);
    if (typeof this.opts[cbName] === 'function') {
      try { this.opts[cbName](...args); } catch (e) { console.error(`[canvasUnderlay] callback "${cbName}" error:`, e); }
    }
  }

  /* ═══════════════════════════════════════
     Zoom / Pan Enforcement
     ═══════════════════════════════════════ */

  _enforceLimits() {
    // Pan clamping (skip if already adjusting to prevent recursive convergence)
    if (this.opts.panClamp && this._main.w > 0 && !this._isPanAdjusting) {
      this._clampPan();
    }

    // Fire events
    this._emit('zoom', this.cy.zoom());
    this._emit('pan', this.cy.pan());
  }

  _getPanBounds() {
    const zoom = this.cy.zoom();
    const container = this.cy.container().getBoundingClientRect();
    const pad = this.opts.panClampPadding;
    const bounds = this._getAllDrawingsBounds();
    if (!bounds) return null;

    const drawW = bounds.w * zoom;
    const drawH = bounds.h * zoom;
    const drawX = bounds.x * zoom;
    const drawY = bounds.y * zoom;

    return {
      minX: container.width - drawX - drawW - pad,
      maxX: -drawX + pad,
      minY: container.height - drawY - drawH - pad,
      maxY: -drawY + pad,
    };
  }

  /** iOS-style rubber-band: diminishing returns past boundary. */
  _rubberBandValue(overflow, maxOvershoot) {
    if (overflow === 0) return 0;
    const sign = overflow > 0 ? 1 : -1;
    const abs = Math.abs(overflow);
    return sign * maxOvershoot * abs / (abs + maxOvershoot);
  }

  _cancelSpringBack() {
    if (this._rubberBandRaf) {
      cancelAnimationFrame(this._rubberBandRaf);
      this._rubberBandRaf = null;
    }
  }

  /** Animate spring-back to boundary on mouse release (fixed-duration ease-out). */
  _springBackIfNeeded() {
    if (this._isUserDragging || !this.opts.panClamp || this.opts.panClampMode !== 'soft') return;
    this._cancelSpringBack();

    const b = this._getPanBounds();
    if (!b) return;

    const pan = this.cy.pan();
    const targetX = b.minX <= b.maxX ? Math.max(b.minX, Math.min(b.maxX, pan.x)) : pan.x;
    const targetY = b.minY <= b.maxY ? Math.max(b.minY, Math.min(b.maxY, pan.y)) : pan.y;

    const dx = targetX - pan.x;
    const dy = targetY - pan.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      if (dx !== 0 || dy !== 0) {
        this._isPanAdjusting = true;
        this.cy.pan({ x: targetX, y: targetY });
        this._isPanAdjusting = false;
      }
      return;
    }

    const startX = pan.x;
    const startY = pan.y;
    const duration = 280; // ms
    const startTime = performance.now();

    const animate = (now) => {
      if (this._destroyed || this._isUserDragging) return;
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - (1 - t) * (1 - t) * (1 - t); // cubic ease-out

      if (t >= 1) {
        this._isPanAdjusting = true;
        this.cy.pan({ x: targetX, y: targetY });
        this._isPanAdjusting = false;
        this._rubberBandRaf = null;
      } else {
        this._isPanAdjusting = true;
        this.cy.pan({ x: startX + dx * ease, y: startY + dy * ease });
        this._isPanAdjusting = false;
        this._rubberBandRaf = requestAnimationFrame(animate);
      }
    };

    this._rubberBandRaf = requestAnimationFrame(animate);
  }

  _clampPan() {
    const cy = this.cy;
    const pan = cy.pan();
    const b = this._getPanBounds();
    if (!b) return;

    let clampedX = pan.x;
    let clampedY = pan.y;

    if (this.opts.panClampMode === 'hard' || (this.opts.panClampMode === 'soft' && !this._isUserDragging)) {
      // Hard clamp — also used in soft mode when not dragging (spring-back handles animation)
      if (b.minX <= b.maxX) clampedX = Math.max(b.minX, Math.min(b.maxX, pan.x));
      if (b.minY <= b.maxY) clampedY = Math.max(b.minY, Math.min(b.maxY, pan.y));
    } else {
      // Soft + dragging: iOS rubber-band with debt tracking
      const maxOvershoot = 80;

      if (b.minX <= b.maxX) {
        const realX = pan.x + this._rubberBandDebtX;
        let overflowX = 0;
        if (realX < b.minX) overflowX = realX - b.minX;
        else if (realX > b.maxX) overflowX = realX - b.maxX;

        if (overflowX !== 0) {
          const boundary = overflowX < 0 ? b.minX : b.maxX;
          clampedX = boundary + this._rubberBandValue(overflowX, maxOvershoot);
          this._rubberBandDebtX = realX - clampedX;
        } else {
          clampedX = realX;
          this._rubberBandDebtX = 0;
        }
      }

      if (b.minY <= b.maxY) {
        const realY = pan.y + this._rubberBandDebtY;
        let overflowY = 0;
        if (realY < b.minY) overflowY = realY - b.minY;
        else if (realY > b.maxY) overflowY = realY - b.maxY;

        if (overflowY !== 0) {
          const boundary = overflowY < 0 ? b.minY : b.maxY;
          clampedY = boundary + this._rubberBandValue(overflowY, maxOvershoot);
          this._rubberBandDebtY = realY - clampedY;
        } else {
          clampedY = realY;
          this._rubberBandDebtY = 0;
        }
      }
    }

    if (clampedX !== pan.x || clampedY !== pan.y) {
      this._isPanAdjusting = true;
      cy.pan({ x: clampedX, y: clampedY });
      this._isPanAdjusting = false;
    }
  }

  _getAllDrawingsBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasDrawing = false;

    if (this._main.w > 0) {
      minX = 0; minY = 0;
      maxX = this._main.w;
      maxY = this._main.h;
      hasDrawing = true;
    }

    for (const d of this._drawings.values()) {
      if (!d.visible || !d.width) continue;
      minX = Math.min(minX, d.x);
      minY = Math.min(minY, d.y);
      maxX = Math.max(maxX, d.x + d.width);
      maxY = Math.max(maxY, d.y + d.height);
      hasDrawing = true;
    }

    if (!hasDrawing) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /* ═══════════════════════════════════════
     Public API: Main Drawing
     ═══════════════════════════════════════ */

  async setSource(url, pageOrOpts = 1) {
    const isOpts = typeof pageOrOpts === 'object' && pageOrOpts !== null;
    const page = isOpts ? (pageOrOpts.page || 1) : pageOrOpts;
    const sourceType = isOpts ? pageOrOpts.sourceType : undefined;
    const overrideW = isOpts ? pageOrOpts.width : undefined;
    const overrideH = isOpts ? pageOrOpts.height : undefined;

    this.opts.source = url;
    this.opts.page = page;

    if (!url) {
      this._main = { source: null, img: null, pdfDoc: null, pdfPage: null, pdfCanvas: null, pdfClip: null, baseScale: 1, w: 0, h: 0, isPdf: false, page: 1 };
      this._draw();
      return;
    }

    this._loading = true;
    try {
      await loadDrawingState(this._main, url, page, sourceType, this.opts.pdfOptions);
      // Override dimensions if provided (e.g. PDF coordinate space mapping)
      if (overrideW > 0) this._main.w = overrideW;
      if (overrideH > 0) this._main.h = overrideH;
      // Recalculate baseScale after overrides
      if (this._main.isPdf && this._main.pdfPage) {
        const baseVp = this._main.pdfPage.getViewport({ scale: 1 });
        this._main.baseScale = this._main.w / baseVp.width;
        // Initial render: visible area + padding
        const clip = this._getPaddedVisibleArea();
        await renderPdfClipToState(this._main, clip, this.cy.zoom(), this.opts);
      }
      this._emit('sourceLoad', url, { width: this._main.w, height: this._main.h });
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('cytoscape-canvas-underlay: failed to load source', e);
        this._emit('sourceError', url, e);
      }
    }
    this._loading = false;

    if (this.opts.fitOnLoad) this.fit();
    this._draw();
  }

  async setPage(page) {
    if (!this._main.isPdf || !this._main.pdfDoc) return;
    this._main.page = page;
    this.opts.page = page;

    // Update page reference and dimensions
    const pdfPage = await this._main.pdfDoc.getPage(page);
    this._main.pdfPage = pdfPage;
    const vp = pdfPage.getViewport({ scale: 1 });
    this._main.w = vp.width;
    this._main.h = vp.height;
    this._main.baseScale = this._main.w / vp.width;

    const clip = this._getPaddedVisibleArea();
    await renderPdfClipToState(this._main, clip, this.cy.zoom(), this.opts);
    this._draw();
  }

  setOpacity(v) {
    this.opts.opacity = Math.max(0, Math.min(1, v));
    this._draw();
  }

  setBrightness(v) {
    this.opts.brightness = v;
    this._draw();
  }

  setContrast(v) {
    this.opts.contrast = v;
    this._draw();
  }

  setSaturate(v) {
    this.opts.saturate = v;
    this._draw();
  }

  setGrayscale(v) {
    this.opts.grayscale = Math.max(0, Math.min(1, v));
    this._draw();
  }

  setInvert(v) {
    this.opts.invert = Math.max(0, Math.min(1, v));
    this._draw();
  }

  /** Set main drawing rotation (0, 90, 180, 270 degrees). */
  setRotation(degrees) {
    const d = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360; // normalize to 0/90/180/270
    if (this.opts.rotation === d) return;
    this.opts.rotation = d;
    this._draw();
    this._emit('rotate', d);
  }

  /** Get current main drawing rotation. */
  getRotation() {
    return this.opts.rotation;
  }

  /* ═══════════════════════════════════════
     Public API: Navigation
     ═══════════════════════════════════════ */

  /** Fit the main drawing to viewport. */
  fit(padding) {
    if (!this._main.w || !this._main.h) return;
    const pad = padding ?? this.opts.fitPadding;
    const container = this.cy.container().getBoundingClientRect();
    const scaleX = (container.width - pad * 2) / this._main.w;
    const scaleY = (container.height - pad * 2) / this._main.h;
    const zoom = Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(),Math.min(scaleX, scaleY)));

    this.cy.zoom({
      level: zoom,
      renderedPosition: { x: container.width / 2, y: container.height / 2 },
    });
    this.cy.pan({
      x: (container.width - this._main.w * zoom) / 2,
      y: (container.height - this._main.h * zoom) / 2,
    });
  }

  /** Fit a specific additional drawing to viewport. */
  fitToDrawing(id, padding) {
    const state = this._drawings.get(id);
    if (!state || !state.width || !state.height) return;
    const pad = padding ?? this.opts.fitPadding;
    const container = this.cy.container().getBoundingClientRect();
    const scaleX = (container.width - pad * 2) / state.width;
    const scaleY = (container.height - pad * 2) / state.height;
    const zoom = Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(),Math.min(scaleX, scaleY)));

    const cx = state.x + state.width / 2;
    const cy_ = state.y + state.height / 2;

    this.cy.zoom({
      level: zoom,
      renderedPosition: { x: container.width / 2, y: container.height / 2 },
    });
    this.cy.pan({
      x: container.width / 2 - cx * zoom,
      y: container.height / 2 - cy_ * zoom,
    });
  }

  /** Fit all drawings (main + additional) to viewport. */
  fitAll(padding) {
    const bounds = this._getAllDrawingsBounds();
    if (!bounds) return;
    const pad = padding ?? this.opts.fitPadding;
    const container = this.cy.container().getBoundingClientRect();
    const scaleX = (container.width - pad * 2) / bounds.w;
    const scaleY = (container.height - pad * 2) / bounds.h;
    const zoom = Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(),Math.min(scaleX, scaleY)));

    const cx = bounds.x + bounds.w / 2;
    const cy_ = bounds.y + bounds.h / 2;

    this.cy.zoom({
      level: zoom,
      renderedPosition: { x: container.width / 2, y: container.height / 2 },
    });
    this.cy.pan({
      x: container.width / 2 - cx * zoom,
      y: container.height / 2 - cy_ * zoom,
    });
  }

  /** Pan to center a world coordinate point in viewport. */
  panTo(x, y, zoom) {
    const container = this.cy.container().getBoundingClientRect();
    if (zoom != null) {
      const z = Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(),zoom));
      this.cy.zoom({
        level: z,
        renderedPosition: { x: container.width / 2, y: container.height / 2 },
      });
    }
    const z = this.cy.zoom();
    this.cy.pan({
      x: container.width / 2 - x * z,
      y: container.height / 2 - y * z,
    });
  }

  /** Pan to center a cytoscape element in viewport. */
  panToElement(eleOrId, padding) {
    const cy = this.cy;
    const ele = typeof eleOrId === 'string' ? cy.getElementById(eleOrId) : eleOrId;
    if (!ele || ele.empty?.()) return;

    const bb = ele.boundingBox();
    const pad = padding ?? this.opts.fitPadding;
    const container = cy.container().getBoundingClientRect();

    // Calculate zoom to fit element
    const scaleX = (container.width - pad * 2) / bb.w;
    const scaleY = (container.height - pad * 2) / bb.h;
    const zoom = Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(),Math.min(scaleX, scaleY)));

    const cx = (bb.x1 + bb.x2) / 2;
    const cy_ = (bb.y1 + bb.y2) / 2;

    this.cy.zoom({
      level: zoom,
      renderedPosition: { x: container.width / 2, y: container.height / 2 },
    });
    this.cy.pan({
      x: container.width / 2 - cx * zoom,
      y: container.height / 2 - cy_ * zoom,
    });
  }

  /** Pan to a specific region of the drawing. */
  panToRegion(x, y, w, h, padding) {
    const pad = padding ?? this.opts.fitPadding;
    const container = this.cy.container().getBoundingClientRect();
    const scaleX = (container.width - pad * 2) / w;
    const scaleY = (container.height - pad * 2) / h;
    const zoom = Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(),Math.min(scaleX, scaleY)));

    const cx = x + w / 2;
    const cy_ = y + h / 2;

    this.cy.zoom({
      level: zoom,
      renderedPosition: { x: container.width / 2, y: container.height / 2 },
    });
    this.cy.pan({
      x: container.width / 2 - cx * zoom,
      y: container.height / 2 - cy_ * zoom,
    });
  }

  /* ═══════════════════════════════════════
     Public API: Visibility
     ═══════════════════════════════════════ */

  /** Show/hide the background drawing canvas. */
  setDrawingVisible(v) {
    // If called with (id, visible) signature, delegate to additional drawing
    if (typeof v === 'boolean' && typeof arguments[0] === 'string' && this._drawings.has(arguments[0])) {
      return this._setAdditionalDrawingVisible(arguments[0], v);
    }

    this.opts.drawingVisible = !!v;
    if (this.canvas) {
      this.canvas.style.display = v ? '' : 'none';
    }
    this._emit('drawingVisibilityChange', !!v);
  }

  /** Show/hide the cytoscape graph layer. */
  setGraphVisible(v) {
    this.opts.graphVisible = !!v;
    if (v) {
      this._showGraph();
    } else {
      this._hideGraph();
    }
  }

  _hideGraph() {
    if (this._graphHidden) return;
    this._graphHidden = true;
    const container = this.cy.container();
    // Hide all cy canvases except our overlay canvas
    const cyCanvases = container.querySelectorAll('canvas');
    cyCanvases.forEach(c => {
      if (c !== this.canvas) {
        c._savedDisplay = c.style.display;
        c.style.display = 'none';
      }
    });
  }

  _showGraph() {
    if (!this._graphHidden) return;
    this._graphHidden = false;
    const container = this.cy.container();
    const cyCanvases = container.querySelectorAll('canvas');
    cyCanvases.forEach(c => {
      if (c !== this.canvas && '_savedDisplay' in c) {
        c.style.display = c._savedDisplay || '';
        delete c._savedDisplay;
      }
    });
  }

  /* ═══════════════════════════════════════
     Public API: Utility
     ═══════════════════════════════════════ */

  /** Force redraw. */
  refresh() {
    this._setupCanvas();
    this._draw();
  }

  /** Get main drawing dimensions. */
  getDrawingSize() {
    return { width: this._main.w, height: this._main.h };
  }

  /** Get current zoom level. */
  getZoom() {
    return this.cy.zoom();
  }

  /** Get current pan position. */
  getPan() {
    return this.cy.pan();
  }

  /** Convert screen coordinates to world coordinates. */
  screenToWorld(screenX, screenY) {
    const zoom = this.cy.zoom();
    const pan = this.cy.pan();
    const rect = this.cy.container().getBoundingClientRect();
    return {
      x: (screenX - rect.left - pan.x) / zoom,
      y: (screenY - rect.top - pan.y) / zoom,
    };
  }

  /** Convert world coordinates to screen coordinates. */
  worldToScreen(worldX, worldY) {
    const zoom = this.cy.zoom();
    const pan = this.cy.pan();
    const rect = this.cy.container().getBoundingClientRect();
    return {
      x: worldX * zoom + pan.x + rect.left,
      y: worldY * zoom + pan.y + rect.top,
    };
  }

  /** Check if a world coordinate point is inside the main drawing. */
  isPointInDrawing(x, y) {
    return x >= 0 && y >= 0 && x <= this._main.w && y <= this._main.h;
  }

  /** Get the visible area in world coordinates. */
  getVisibleArea() {
    const zoom = this.cy.zoom();
    const pan = this.cy.pan();
    const rect = this.cy.container().getBoundingClientRect();
    return {
      x: -pan.x / zoom,
      y: -pan.y / zoom,
      w: rect.width / zoom,
      h: rect.height / zoom,
    };
  }

  /** Get the visible area expanded by pdfClipPadding for PDF rendering. */
  _getPaddedVisibleArea() {
    const v = this.getVisibleArea();
    const pad = this.opts.pdfClipPadding;
    const padW = v.w * pad;
    const padH = v.h * pad;
    return {
      x: v.x - padW,
      y: v.y - padH,
      w: v.w + padW * 2,
      h: v.h + padH * 2,
    };
  }

  /** Update options at runtime. */
  setOptions(patch) {
    Object.assign(this.opts, patch);

    // Update minimap options
    if (patch.minimap && this._minimap) {
      this._minimap.setOptions(patch.minimap);
    }

    this._draw();
  }

  /** Check if source is loading. */
  isLoading() {
    return this._loading;
  }

  /* ═══════════════════════════════════════
     Public API: Minimap
     ═══════════════════════════════════════ */

  /** Show/hide the minimap. */
  setMinimapEnabled(v) {
    if (v && !this._minimap) {
      this._minimap = new Minimap(this, { enabled: true, ...(this.opts.minimap || {}) });
    } else if (this._minimap) {
      this._minimap.setEnabled(!!v);
    }
  }

  /** Update minimap options at runtime. */
  setMinimapOptions(patch) {
    if (!this._minimap) {
      this._minimap = new Minimap(this, { enabled: true, ...patch });
    } else {
      this._minimap.setOptions(patch);
    }
  }

  /* ═══════════════════════════════════════
     Public API: Additional Drawings
     ═══════════════════════════════════════ */

  async addDrawing(id, opts = {}) {
    const state = {
      source: null, img: null, pdfDoc: null, pdfPage: null, pdfCanvas: null, pdfClip: null, baseScale: 1,
      w: 0, h: 0, isPdf: false, page: opts.page || 1,
      x: opts.x || 0,
      y: opts.y || 0,
      width: opts.width || null,
      height: opts.height || null,
      opacity: opts.opacity ?? 1,
      visible: opts.visible ?? true,
      rotation: ((Math.round((opts.rotation || 0) / 90) * 90) % 360 + 360) % 360,
    };

    if (opts.source) {
      try {
        await loadDrawingState(state, opts.source, state.page, opts.sourceType, this.opts.pdfOptions);
        if (!state.width) state.width = state.w;
        if (!state.height) state.height = state.h;
        if (state.isPdf && state.pdfPage) {
          const baseVp = state.pdfPage.getViewport({ scale: 1 });
          state.baseScale = state.width / baseVp.width;
          // Visible clip relative to this drawing's position
          const visible = this._getPaddedVisibleArea();
          const drawingClip = {
            x: visible.x - state.x, y: visible.y - state.y,
            w: visible.w, h: visible.h,
          };
          await renderPdfClipToState(state, drawingClip, this.cy.zoom(), this.opts);
        }
      } catch (e) {
        console.error(`cytoscape-canvas-underlay: failed to load drawing "${id}"`, e);
      }
    }

    this._drawings.set(id, state);
    this._draw();
    this._emit('drawingAdd', id, { x: state.x, y: state.y, width: state.width, height: state.height });
  }

  updateDrawing(id, patch) {
    const state = this._drawings.get(id);
    if (!state) return;
    Object.assign(state, patch);
    this._draw();
  }

  _setAdditionalDrawingVisible(id, visible) {
    const state = this._drawings.get(id);
    if (!state) return;
    state.visible = visible;
    this._draw();
  }

  /** Set visibility of an additional drawing by ID. */
  setAdditionalDrawingVisible(id, visible) {
    this._setAdditionalDrawingVisible(id, visible);
  }

  removeDrawing(id) {
    this._drawings.delete(id);
    this._draw();
    this._emit('drawingRemove', id);
  }

  clearDrawings() {
    this._drawings.clear();
    this._draw();
  }

  getDrawingIds() {
    return [...this._drawings.keys()];
  }

  /** Get an additional drawing's state. */
  getDrawing(id) {
    const state = this._drawings.get(id);
    if (!state) return null;
    return {
      x: state.x, y: state.y,
      width: state.width, height: state.height,
      opacity: state.opacity, visible: state.visible,
      rotation: state.rotation || 0,
      sourceWidth: state.w, sourceHeight: state.h,
    };
  }

  /* ═══════════════════════════════════════
     Drawing
     ═══════════════════════════════════════ */

  _scheduleRedraw() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._draw();
      if (this._minimap) this._minimap.render();
    });

    // Schedule high-quality PDF re-render
    const hasPdf = this._main.isPdf || [...this._drawings.values()].some(d => d.isPdf && d.visible);
    if (hasPdf) {
      if (this._qualityTimer) clearTimeout(this._qualityTimer);
      this._qualityTimer = setTimeout(() => {
        this._reRenderAllPdfs().then(() => this._draw());
      }, this.opts.qualityDelay);
    }
  }

  async _reRenderAllPdfs() {
    if (this._abortController) this._abortController.abort();
    this._abortController = new AbortController();
    const signal = this._abortController.signal;
    const zoom = this.cy.zoom();
    const visible = this._getPaddedVisibleArea();

    const tasks = [];
    if (this._main.isPdf && this._main.pdfDoc) {
      tasks.push(renderPdfClipToState(this._main, visible, zoom, this.opts, signal));
    }
    for (const state of this._drawings.values()) {
      if (state.isPdf && state.pdfDoc && state.visible) {
        // Adjust visible area relative to drawing position
        const drawingClip = {
          x: visible.x - state.x, y: visible.y - state.y,
          w: visible.w, h: visible.h,
        };
        tasks.push(renderPdfClipToState(state, drawingClip, zoom, this.opts, signal));
      }
    }

    try {
      await Promise.all(tasks);
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
  }

  /** Draw an image/canvas with optional rotation around its center. */
  _drawRotated(ctx, source, x, y, w, h, rotation) {
    if (!rotation) {
      ctx.drawImage(source, x, y, w, h);
      return;
    }
    const rad = (rotation % 360) * Math.PI / 180;
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rad);
    ctx.drawImage(source, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  _draw() {
    if (this._destroyed || !this.ctx || !this.canvas) return;
    if (!this.opts.drawingVisible) return;

    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const zoom = this.cy.zoom();
    const pan = this.cy.pan();

    // Clear
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);

    // Background color
    if (this.opts.backgroundColor) {
      ctx.fillStyle = this.opts.backgroundColor;
      ctx.fillRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
    }

    const hasMain = this._main.img || this._main.pdfCanvas;
    const hasAdditional = this._drawings.size > 0;
    if (!hasMain && !hasAdditional) return;

    // High-quality image smoothing
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Apply cytoscape transform
    ctx.setTransform(
      zoom * dpr, 0,
      0, zoom * dpr,
      Math.round(pan.x * dpr),
      Math.round(pan.y * dpr)
    );

    // CSS filters
    ctx.filter = buildFilterString(this.opts);

    // Draw main source
    if (hasMain) {
      ctx.globalAlpha = this.opts.opacity;
      const mainRot = this.opts.rotation || 0;
      if (this._main.img) {
        this._drawRotated(ctx, this._main.img, 0, 0, this._main.w, this._main.h, mainRot);
      } else if (this._main.pdfCanvas && this._main.pdfClip) {
        const c = this._main.pdfClip;
        this._drawRotated(ctx, this._main.pdfCanvas, c.x, c.y, c.w, c.h, mainRot);
      }
    }

    // Draw additional drawings
    for (const state of this._drawings.values()) {
      if (!state.visible) continue;
      ctx.globalAlpha = state.opacity * this.opts.opacity;
      const rot = state.rotation || 0;
      if (state.img) {
        this._drawRotated(ctx, state.img, state.x, state.y, state.width, state.height, rot);
      } else if (state.pdfCanvas && state.pdfClip) {
        const c = state.pdfClip;
        this._drawRotated(ctx, state.pdfCanvas, state.x + c.x, state.y + c.y, c.w, c.h, rot);
      }
    }

    // Reset
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
  }
}

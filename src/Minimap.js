/**
 * Minimap component for cytoscape-canvas-underlay.
 * DOM-based rendering with CSS backgroundImage for crisp image quality.
 *
 * Two viewport display styles:
 *   'dim'  — darkens everything outside the viewport (boxShadow technique)
 *   'rect' — clean image with a rectangle highlight on the viewport area
 *
 * Click/drag on the minimap to navigate.
 */

const MINIMAP_DEFAULTS = {
  enabled: false,

  // ── Size ──
  width: 0,                  // Minimap width (px). 0 = auto from height + aspect ratio
  height: 100,               // Minimap height (px). 0 = auto from width + aspect ratio

  // ── Position ──
  position: 'bottom-left',   // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  offsetX: 10,               // Offset from container edge (px)
  offsetY: 10,

  // ── Wrapper appearance ──
  backgroundColor: '#0f1419',// Minimap background color (visible when image doesn't fill)
  opacity: 1,                // Overall minimap opacity
  borderColor: '#666',       // Wrapper border color
  borderWidth: 0,            // Wrapper border width (px). 0 = no border
  borderRadius: 0,           // Wrapper border radius (px)
  shadow: true,              // Show drop shadow on wrapper
  shadowColor: 'rgba(0,0,0,0.15)', // Drop shadow color
  zIndex: 9999,              // CSS z-index

  // ── Viewport display ──
  viewportStyle: 'dim',      // 'dim' = darken outside viewport | 'rect' = rectangle highlight
  viewportColor: 'rgba(255,255,255,0.6)', // Viewport border color
  viewportBorderWidth: 1,    // Viewport border width (px)
  viewportFillColor: 'rgba(0,0,0,0.4)',   // dim: overlay color outside viewport, rect: fill color inside viewport
  viewportShadow: false,     // Show shadow on viewport indicator (rect mode)
  viewportShadowColor: 'rgba(0,0,0,0.3)', // Viewport indicator shadow color
  viewportBorderRadius: 0,   // Viewport indicator border radius (px)

  // ── Auto-hide ──
  autoHide: false,           // Auto-hide minimap after inactivity
  autoHideDelay: 1000,       // Delay (ms) before hiding
  autoHideDuration: 300,     // Fade transition duration (ms)
};

export class Minimap {
  constructor(overlay, userOpts = {}) {
    this._overlay = overlay;
    this.opts = { ...MINIMAP_DEFAULTS, ...userOpts };
    this._el = null;
    this._imgDiv = null;
    this._viewportDiv = null;
    this._dragging = false;
    this._destroyed = false;
    this._hideTimer = null;
    this._visible = true;
    this._blobUrl = null;
    this._lastImgSrc = null;
    this._minimapW = 0;
    this._minimapH = 0;

    if (this.opts.enabled) {
      this._create();
    }
  }

  /* ─── Lifecycle ─── */

  _create() {
    const container = this._overlay.cy.container();
    if (!container || this._el) return;

    // Wrapper div
    this._el = document.createElement('div');
    this._el.style.cssText = this._buildWrapperStyle();

    // Image background div — CSS backgroundImage for crisp browser-native scaling
    this._imgDiv = document.createElement('div');
    this._imgDiv.style.cssText =
      'width: 100%; height: 100%; background-size: contain; background-repeat: no-repeat; background-position: center; pointer-events: none;';
    this._el.appendChild(this._imgDiv);

    // Viewport indicator
    this._viewportDiv = document.createElement('div');
    this._applyViewportStyle();
    this._el.appendChild(this._viewportDiv);

    container.appendChild(this._el);

    this._updateSize();
    this._updateImage();
    this._bindEvents();
    this.render();
  }

  _applyViewportStyle() {
    if (!this._viewportDiv) return;
    const o = this.opts;
    const base = [
      'position: absolute',
      'box-sizing: border-box',
      'pointer-events: none',
      `border: ${o.viewportBorderWidth}px solid ${o.viewportColor}`,
      `border-radius: ${o.viewportBorderRadius}px`,
    ];

    if (o.viewportStyle === 'dim') {
      // Dim mode: large box-shadow covers everything outside viewport
      base.push(`box-shadow: 0 0 0 9999px ${o.viewportFillColor}`);
    } else {
      // Rect mode: subtle fill inside viewport, optional shadow
      base.push(`background: ${o.viewportFillColor}`);
      if (o.viewportShadow) {
        base.push(`box-shadow: 0 0 4px ${o.viewportShadowColor}`);
      }
    }

    this._viewportDiv.style.cssText = base.join('; ') + ';';
  }

  _buildWrapperStyle() {
    const o = this.opts;
    const pos = o.position;
    const styles = [
      'position: absolute',
      `z-index: ${o.zIndex}`,
      o.borderWidth > 0
        ? `border: ${o.borderWidth}px solid ${o.borderColor}`
        : 'border: none',
      `border-radius: ${o.borderRadius}px`,
      `background: ${o.backgroundColor}`,
      `opacity: ${o.opacity}`,
      'overflow: hidden',
      'cursor: pointer',
      'user-select: none',
    ];

    if (o.shadow) {
      styles.push(`box-shadow: 0 2px 8px ${o.shadowColor}`);
    }
    if (o.autoHide) {
      styles.push(`transition: opacity ${o.autoHideDuration}ms`);
      styles.push('pointer-events: auto');
    }

    // Position
    if (pos.includes('top'))    styles.push(`top: ${o.offsetY}px`);
    if (pos.includes('bottom')) styles.push(`bottom: ${o.offsetY}px`);
    if (pos.includes('left'))   styles.push(`left: ${o.offsetX}px`);
    if (pos.includes('right'))  styles.push(`right: ${o.offsetX}px`);

    return styles.join('; ') + ';';
  }

  _updateSize() {
    if (!this._el) return;
    const main = this._overlay._main;
    let w = this.opts.width;
    let h = this.opts.height;

    // Auto-size from aspect ratio
    if (main.w > 0 && main.h > 0) {
      if (!w && h)       w = Math.round(h * (main.w / main.h));
      else if (w && !h)  h = Math.round(w * (main.h / main.w));
      else if (!w && !h) { h = 100; w = Math.round(100 * (main.w / main.h)); }
    } else {
      if (!w) w = 150;
      if (!h) h = 100;
    }

    this._el.style.width  = w + 'px';
    this._el.style.height = h + 'px';
    this._minimapW = w;
    this._minimapH = h;
  }

  _updateImage() {
    if (!this._imgDiv) return;
    const main = this._overlay._main;

    if (main.img && main.img.src) {
      if (this._lastImgSrc !== main.img.src) {
        this._imgDiv.style.backgroundImage = `url(${main.img.src})`;
        this._lastImgSrc = main.img.src;
        if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
      }
    } else if (main.pdfCanvas) {
      try {
        main.pdfCanvas.convertToBlob({ type: 'image/png' }).then(blob => {
          if (this._destroyed) return;
          const url = URL.createObjectURL(blob);
          if (this._imgDiv) this._imgDiv.style.backgroundImage = `url(${url})`;
          if (this._blobUrl) URL.revokeObjectURL(this._blobUrl);
          this._blobUrl = url;
          this._lastImgSrc = url;
        }).catch(() => {});
      } catch (_) { /* OffscreenCanvas.convertToBlob not available */ }
    }
  }

  _bindEvents() {
    this._onMouseDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._dragging = true;
      this._showMinimap();
      this._navigateTo(e);
    };
    this._onMouseMove = (e) => {
      if (!this._dragging) return;
      e.preventDefault();
      this._navigateTo(e);
    };
    this._onMouseUp = () => {
      this._dragging = false;
      if (this.opts.autoHide) this._scheduleHide();
    };

    this._el.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);

    // Update minimap image when source changes
    this._onSourceLoad = () => { this._updateSize(); this._updateImage(); this.render(); };
    this._overlay.on('sourceLoad', this._onSourceLoad);

    // Auto-hide: show on pan/zoom, hide after delay
    if (this.opts.autoHide) {
      this._onCyViewport = () => { this._showMinimap(); this._scheduleHide(); };
      this._overlay.cy.on('pan zoom', this._onCyViewport);
      this._setOpacity(0);
      this._visible = false;
    }
  }

  _setOpacity(v) {
    if (this._el) this._el.style.opacity = v;
  }

  _showMinimap() {
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    if (!this._visible) {
      this._visible = true;
      this._setOpacity(this.opts.opacity);
      this._updateImage();
      this.render();
    }
  }

  _scheduleHide() {
    if (this._dragging) return;
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => {
      this._visible = false;
      this._setOpacity(0);
      this._hideTimer = null;
    }, this.opts.autoHideDelay);
  }

  _navigateTo(e) {
    const rect = this._el.getBoundingClientRect();
    const main = this._overlay._main;
    if (!main.w || !main.h) return;

    const mw = this._minimapW || rect.width;
    const mh = this._minimapH || rect.height;
    const scale = Math.min(mw / main.w, mh / main.h);
    const imgW = main.w * scale;
    const imgH = main.h * scale;
    const imgX = (mw - imgW) / 2;
    const imgY = (mh - imgH) / 2;

    const worldX = (e.clientX - rect.left - imgX) / scale;
    const worldY = (e.clientY - rect.top - imgY) / scale;

    this._overlay.panTo(worldX, worldY);
  }

  destroy() {
    this._destroyed = true;
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    if (this._el) this._el.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    if (this._onCyViewport) {
      this._overlay.cy.off('pan zoom', this._onCyViewport);
      this._onCyViewport = null;
    }
    if (this._onSourceLoad) {
      this._overlay.off('sourceLoad', this._onSourceLoad);
      this._onSourceLoad = null;
    }
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
    this._el = null;
    this._imgDiv = null;
    this._viewportDiv = null;
  }

  /* ─── Public ─── */

  setEnabled(v) {
    this.opts.enabled = !!v;
    if (v && !this._el) this._create();
    else if (!v && this._el) this.destroy();
  }

  setOptions(patch) {
    Object.assign(this.opts, patch);
    if (this._el) {
      this._el.style.cssText = this._buildWrapperStyle();
      this._applyViewportStyle();
      this._updateSize();
      this._updateImage();
      this.render();
    }
  }

  /* ─── Rendering ─── */

  render() {
    if (this._destroyed || !this._el || !this._viewportDiv) return;
    if (this.opts.autoHide && !this._visible) return;

    const main = this._overlay._main;
    if (!main.w || !main.h) {
      this._viewportDiv.style.display = 'none';
      return;
    }

    this._updateSize();

    const mw = this._minimapW;
    const mh = this._minimapH;

    // Image area within minimap (contain fit)
    const scale = Math.min(mw / main.w, mh / main.h);
    const imgX = (mw - main.w * scale) / 2;
    const imgY = (mh - main.h * scale) / 2;

    // Visible area → minimap coordinates
    const visible = this._overlay.getVisibleArea();
    const vx1 = Math.max(0, visible.x);
    const vy1 = Math.max(0, visible.y);
    const vx2 = Math.min(main.w, visible.x + visible.w);
    const vy2 = Math.min(main.h, visible.y + visible.h);

    const vpLeft   = imgX + vx1 * scale;
    const vpTop    = imgY + vy1 * scale;
    const vpWidth  = Math.max(0, (vx2 - vx1) * scale);
    const vpHeight = Math.max(0, (vy2 - vy1) * scale);

    this._viewportDiv.style.display = '';
    this._viewportDiv.style.left   = vpLeft   + 'px';
    this._viewportDiv.style.top    = vpTop    + 'px';
    this._viewportDiv.style.width  = vpWidth  + 'px';
    this._viewportDiv.style.height = vpHeight + 'px';
  }
}

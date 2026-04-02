/**
 * cytoscape-canvas-underlay
 *
 * Cytoscape.js plugin for rendering image/PDF canvas underlay
 * behind graph nodes with synchronized zoom and pan.
 */

import { DrawingOverlay } from './DrawingOverlay.js';
export { setPdfjs, clearPdfCache } from './PdfRenderer.js';

function register(cytoscape) {
  if (!cytoscape) return;

  cytoscape('core', 'canvasUnderlay', function (opts = {}) {
    const cy = this;

    // Destroy previous instance if exists
    const prev = cy.scratch('canvasUnderlay');
    if (prev) prev.destroy();

    const overlay = new DrawingOverlay(cy, opts);

    // Public API
    const api = {
      // ── Source ──
      setSource(url, page) { return overlay.setSource(url, page); },
      setPage(page) { return overlay.setPage(page); },
      isLoading() { return overlay.isLoading(); },

      // ── Appearance ──
      setOpacity(v) { overlay.setOpacity(v); },
      setBrightness(v) { overlay.setBrightness(v); },
      setContrast(v) { overlay.setContrast(v); },
      setSaturate(v) { overlay.setSaturate(v); },
      setGrayscale(v) { overlay.setGrayscale(v); },
      setInvert(v) { overlay.setInvert(v); },
      setRotation(degrees) { overlay.setRotation(degrees); },
      getRotation() { return overlay.getRotation(); },

      // ── Navigation ──
      fit(opts) { overlay.fit(opts); },
      fitToDrawing(id, padding) { overlay.fitToDrawing(id, padding); },
      fitAll(padding) { overlay.fitAll(padding); },
      panTo(x, y, zoom) { overlay.panTo(x, y, zoom); },
      panToRegion(x, y, w, h, padding) { overlay.panToRegion(x, y, w, h, padding); },

      // ── Visibility ──
      setDrawingVisible(v) { overlay.setDrawingVisible(v); },
      setGraphVisible(v) { overlay.setGraphVisible(v); },

      // ── Additional Drawings ──
      addDrawing(id, opts) { return overlay.addDrawing(id, opts); },
      updateDrawing(id, patch) { overlay.updateDrawing(id, patch); },
      setAdditionalDrawingVisible(id, visible) { overlay.setAdditionalDrawingVisible(id, visible); },
      removeDrawing(id) { overlay.removeDrawing(id); },
      clearDrawings() { overlay.clearDrawings(); },
      getDrawingIds() { return overlay.getDrawingIds(); },
      getDrawing(id) { return overlay.getDrawing(id); },

      // ── Minimap ──
      setMinimapEnabled(v) { overlay.setMinimapEnabled(v); },
      setMinimapOptions(patch) { overlay.setMinimapOptions(patch); },

      // ── Utility ──
      refresh() { overlay.refresh(); },
      getDrawingSize() { return overlay.getDrawingSize(); },
      getZoom() { return overlay.getZoom(); },
      getPan() { return overlay.getPan(); },
      getVisibleArea() { return overlay.getVisibleArea(); },
      screenToWorld(sx, sy) { return overlay.screenToWorld(sx, sy); },
      worldToScreen(wx, wy) { return overlay.worldToScreen(wx, wy); },
      isPointInDrawing(x, y) { return overlay.isPointInDrawing(x, y); },
      setOptions(patch) { overlay.setOptions(patch); },

      // ── Events ──
      on(event, fn) { overlay.on(event, fn); return api; },
      off(event, fn) { overlay.off(event, fn); return api; },
      once(event, fn) { overlay.once(event, fn); return api; },

      // ── Lifecycle ──
      destroy() {
        overlay.destroy();
        cy.scratch('canvasUnderlay', null);
      },
    };

    cy.scratch('canvasUnderlay', api);
    return api;
  });
}

// Auto-register if cytoscape is available globally
if (typeof window !== 'undefined' && window.cytoscape) {
  register(window.cytoscape);
}

export default register;

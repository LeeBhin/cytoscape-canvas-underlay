# cytoscape-canvas-underlay

A [Cytoscape.js](https://js.cytoscape.org) plugin for rendering image/PDF backgrounds behind graph nodes with synchronized zoom and pan.

- **Image & PDF support** — load `.png`, `.jpg`, `.svg`, or `.pdf` as background
- **Multiple drawings** — overlay additional drawings at arbitrary world positions
- **Zoom/pan sync** — synchronous redraw on every viewport event for zero-lag rendering
- **Pan clamping** — hard boundary or iOS-style rubber-band with spring-back
- **Minimap** — DOM-based crisp image rendering, two viewport styles (`dim` / `rect`), auto-hide, full customization
- **Adaptive PDF quality** — low-quality render during interaction, high-quality on idle
- **Rich navigation** — `fit`, `fitAll`, `panToRegion`, coordinate conversion
- **Layer visibility** — independently show/hide drawing background and graph layer
- **CSS filters** — invert, brightness, contrast, saturate, grayscale (invert applied first so brightness/contrast work correctly on inverted images)
- **Rotation** — rotate main or additional drawings (0, 90, 180, 270 degrees)
- **Event emitter** — `on`/`off`/`once` event system with legacy callback support
- **Zero required dependencies** — only Cytoscape.js as peer dependency (`pdfjs-dist` optional for PDF)

## Installation

```bash
npm install cytoscape-canvas-underlay
```

For PDF support:

```bash
npm install pdfjs-dist
```

## Quick Start

```js
import cytoscape from 'cytoscape';
import canvasUnderlay from 'cytoscape-canvas-underlay';

cytoscape.use(canvasUnderlay);

const cy = cytoscape({ container: document.getElementById('cy') });

const api = cy.canvasUnderlay({
  source: '/drawings/pid-diagram.png',
  opacity: 1,
  fitOnLoad: true,
  panClamp: true,
  panClampMode: 'soft',
  minimap: {
    position: 'bottom-left',
    height: 100,
    viewportStyle: 'dim',
    autoHide: true,
  },
});
```

### With PDF

```js
import * as pdfjsLib from 'pdfjs-dist';
import { setPdfjs } from 'cytoscape-canvas-underlay';

setPdfjs(pdfjsLib);

const api = cy.canvasUnderlay({
  source: '/drawings/schematic.pdf',
  page: 1,
  qualityDelay: 150,
});

api.setPage(2);
```

### Multiple drawings

```js
await api.addDrawing('trace-1', {
  source: '/drawings/trace-detail.pdf',
  page: 1,
  x: 500, y: 300,
  width: 800, height: 600,
  opacity: 0.7,
  rotation: 90,
});

api.setAdditionalDrawingVisible('trace-1', false);
api.updateDrawing('trace-1', { x: 600, opacity: 1, rotation: 180 });
api.removeDrawing('trace-1');
api.clearDrawings();
```

### Rotation

```js
// Main drawing rotation
api.setRotation(90);          // 0, 90, 180, 270 — auto-normalized
api.getRotation();            // 90

// Additional drawing rotation
await api.addDrawing('sub-1', {
  source: '/drawings/detail.png',
  x: 100, y: 200,
  rotation: 270,
});

// Update rotation at runtime
api.updateDrawing('sub-1', { rotation: 180 });
```

### Events

```js
// Subscribe (chainable)
api
  .on('sourceLoad', (url, { width, height }) => {
    console.log(`Loaded ${url}: ${width}x${height}`);
  })
  .on('rotate', (degrees) => {
    console.log(`Rotated to ${degrees}°`);
  })
  .on('drawingAdd', (id, { x, y, width, height }) => {
    console.log(`Drawing "${id}" added`);
  });

// One-time listener
api.once('sourceLoad', (url, size) => {
  api.fit();
});

// Unsubscribe
api.off('zoom', handler);     // remove specific handler
api.off('zoom');               // remove all zoom handlers
```

**Available events:**

| Event | Parameters | Description |
|-------|-----------|-------------|
| `sourceLoad` | `(url, {width, height})` | Main source loaded successfully |
| `sourceError` | `(url, error)` | Main source failed to load |
| `zoom` | `(zoomLevel)` | Zoom level changed |
| `pan` | `({x, y})` | Pan position changed |
| `drawingVisibilityChange` | `(visible)` | Drawing visibility toggled |
| `drawingAdd` | `(id, {x, y, width, height})` | Additional drawing added |
| `drawingRemove` | `(id)` | Additional drawing removed |
| `rotate` | `(degrees)` | Main drawing rotation changed |
| `resize` | `({width, height})` | Container resized |

### Navigation

```js
api.fit();                              // fit main drawing (instant)
api.fit({ animate: true });            // fit with animation (300ms)
api.fit({ padding: 50 });             // fit with 50px padding
api.fit({ animate: true, duration: 500, easing: 'ease-out' });
api.fitToDrawing('trace-1');            // fit specific drawing
api.fitAll();                           // fit all drawings
api.panTo(500, 300);                    // center on world coordinate
api.panTo(500, 300, 2.0);              // center + set zoom
api.panToRegion(100, 100, 400, 300);   // fit a world-coordinate region
```

### Visibility

```js
api.setDrawingVisible(false);   // hide background drawing
api.setGraphVisible(false);     // hide cytoscape graph layer
api.setDrawingVisible(true);    // show again
api.setGraphVisible(true);
```

### Minimap

The minimap uses DOM-based rendering with CSS `backgroundImage` for crisp image quality (no canvas blurring). Two viewport display styles are available:

- **`'dim'`** — darkens everything outside the viewport (boxShadow technique)
- **`'rect'`** — shows original image clearly with a rectangle highlight on the viewport area

```js
// Dim style (default) — darkens area outside viewport
const api = cy.canvasUnderlay({
  source: '/drawing.png',
  minimap: {
    height: 100,
    position: 'bottom-left',
    viewportStyle: 'dim',
    backgroundColor: '#0f1419',
    viewportColor: 'rgba(255,255,255,0.6)',
    viewportFillColor: 'rgba(0,0,0,0.4)',
    autoHide: true,
    autoHideDelay: 1000,
  },
});

// Rect style — clean image with viewport rectangle
const api = cy.canvasUnderlay({
  source: '/drawing.png',
  minimap: {
    height: 120,
    position: 'bottom-right',
    viewportStyle: 'rect',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ccc',
    viewportColor: '#4a90e2',
    viewportBorderWidth: 2,
    viewportFillColor: 'rgba(74, 144, 226, 0.1)',
    viewportShadow: true,
  },
});

// Toggle at runtime
api.setMinimapEnabled(false);
api.setMinimapEnabled(true);

// Update minimap options
api.setMinimapOptions({
  viewportStyle: 'rect',
  position: 'top-left',
  height: 150,
});
```

### Coordinate conversion

```js
const world = api.screenToWorld(event.clientX, event.clientY);
const screen = api.worldToScreen(500, 300);
const area = api.getVisibleArea();  // { x, y, w, h } in world coords
const inside = api.isPointInDrawing(world.x, world.y);
```

## Options

### Source

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `source` | `string\|null` | `null` | Image or PDF URL |
| `page` | `number` | `1` | PDF page number (1-based) |

### Appearance

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `opacity` | `number` | `1` | Background opacity (0–1) |
| `brightness` | `number` | `1` | CSS brightness filter (0–2) |
| `contrast` | `number` | `1` | CSS contrast filter (0–2) |
| `saturate` | `number` | `1` | CSS saturate filter (0–2) |
| `grayscale` | `number` | `0` | CSS grayscale filter (0–1) |
| `invert` | `number` | `0` | CSS invert filter (0–1) |
| `rotation` | `number` | `0` | Drawing rotation in degrees (0, 90, 180, 270) |
| `backgroundColor` | `string\|null` | `null` | Canvas background color (`null` = transparent) |
| `zIndex` | `number` | `0` | Canvas z-index within container |

### Layout

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `fitOnLoad` | `boolean` | `true` | Auto-fit drawing to viewport on load |
| `fitPadding` | `number` | `0` | Default padding for fit operations (px) |

### Pan Clamping

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `panClamp` | `boolean` | `false` | Prevent panning beyond drawing bounds |
| `panClampPadding` | `number` | `200` | Extra padding (px) beyond drawing bounds |
| `panClampMode` | `string` | `'soft'` | `'hard'` = strict boundary, `'soft'` = iOS-style rubber-band (resistance during drag, spring-back on release) |

### Visibility

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `drawingVisible` | `boolean` | `true` | Initial drawing visibility |
| `graphVisible` | `boolean` | `true` | Initial graph layer visibility |

### PDF Quality

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `qualityDelay` | `number` | `100` | Delay (ms) before high-quality PDF re-render |
| `pdfMinRenderSize` | `number` | `2048` | Minimum PDF render dimension (px) |
| `pdfMaxRenderSize` | `number` | `8192` | Maximum PDF render dimension (px) |

### Minimap

Pass a `minimap` options object to enable the minimap. Pass `null` or omit to disable.

#### Size & Position

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `minimap.width` | `number` | `0` | Minimap width (px). `0` = auto from height + aspect ratio |
| `minimap.height` | `number` | `100` | Minimap height (px). `0` = auto from width + aspect ratio |
| `minimap.position` | `string` | `'bottom-left'` | `'top-left'` \| `'top-right'` \| `'bottom-left'` \| `'bottom-right'` |
| `minimap.offsetX` | `number` | `10` | Offset from container edge (px) |
| `minimap.offsetY` | `number` | `10` | Offset from container edge (px) |

#### Wrapper Appearance

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `minimap.backgroundColor` | `string` | `'#0f1419'` | Background color |
| `minimap.opacity` | `number` | `1` | Overall minimap opacity |
| `minimap.borderColor` | `string` | `'#666'` | Border color |
| `minimap.borderWidth` | `number` | `0` | Border width (px). `0` = no border |
| `minimap.borderRadius` | `number` | `0` | Border radius (px) |
| `minimap.shadow` | `boolean` | `true` | Show drop shadow |
| `minimap.shadowColor` | `string` | `'rgba(0,0,0,0.15)'` | Drop shadow color |
| `minimap.zIndex` | `number` | `9999` | CSS z-index |

#### Viewport Display

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `minimap.viewportStyle` | `string` | `'dim'` | `'dim'` = darken outside viewport, `'rect'` = rectangle highlight |
| `minimap.viewportColor` | `string` | `'rgba(255,255,255,0.6)'` | Viewport border color |
| `minimap.viewportBorderWidth` | `number` | `1` | Viewport border width (px) |
| `minimap.viewportFillColor` | `string` | `'rgba(0,0,0,0.4)'` | `dim`: overlay color outside viewport. `rect`: fill color inside viewport |
| `minimap.viewportBorderRadius` | `number` | `0` | Viewport indicator border radius (px) |
| `minimap.viewportShadow` | `boolean` | `false` | Show shadow on viewport indicator (`rect` mode) |
| `minimap.viewportShadowColor` | `string` | `'rgba(0,0,0,0.3)'` | Viewport indicator shadow color |

#### Auto-hide

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `minimap.autoHide` | `boolean` | `false` | Auto-hide minimap after inactivity |
| `minimap.autoHideDelay` | `number` | `1000` | Delay (ms) before hiding |
| `minimap.autoHideDuration` | `number` | `300` | Fade transition duration (ms) |

### Legacy Callbacks

These still work but the `on()`/`off()` event emitter is preferred.

| Option | Type | Description |
|--------|------|-------------|
| `onSourceLoad` | `(url, {width, height}) => void` | Fired when source loads successfully |
| `onSourceError` | `(url, error) => void` | Fired when source fails to load |
| `onZoom` | `(zoomLevel) => void` | Fired on zoom change |
| `onPan` | `({x, y}) => void` | Fired on pan change |
| `onDrawingVisibilityChange` | `(visible) => void` | Fired when drawing visibility changes |

## API

`cy.canvasUnderlay(options)` returns an API object. Also accessible via `cy.scratch('canvasUnderlay')`.

### Source

| Method | Description |
|--------|-------------|
| `setSource(url, page?)` | Load a new image or PDF background |
| `setPage(page)` | Change PDF page without reloading document |
| `isLoading()` | Returns `true` if source is currently loading |

### Appearance

| Method | Description |
|--------|-------------|
| `setOpacity(value)` | Set background opacity (0–1) |
| `setBrightness(value)` | Set brightness filter (0–2) |
| `setContrast(value)` | Set contrast filter (0–2) |
| `setSaturate(value)` | Set saturate filter (0–2) |
| `setGrayscale(value)` | Set grayscale filter (0–1) |
| `setInvert(value)` | Set invert filter (0–1) |
| `setRotation(degrees)` | Set main drawing rotation (0, 90, 180, 270) — auto-normalized |
| `getRotation()` | Get current main drawing rotation in degrees |

### Navigation

| Method | Description |
|--------|-------------|
| `fit(opts?)` | Fit main drawing to viewport. Options: `{ animate, padding, duration, easing }` |
| `fitToDrawing(id, padding?)` | Fit a specific additional drawing to viewport |
| `fitAll(padding?)` | Fit all drawings (main + additional) to viewport |
| `panTo(x, y, zoom?)` | Center viewport on world coordinate, optionally set zoom |
| `panToRegion(x, y, w, h, padding?)` | Fit a world-coordinate region in viewport |

### Visibility

| Method | Description |
|--------|-------------|
| `setDrawingVisible(bool)` | Show/hide the background drawing canvas |
| `setGraphVisible(bool)` | Show/hide the cytoscape graph layer |

### Minimap

| Method | Description |
|--------|-------------|
| `setMinimapEnabled(bool)` | Show/hide the minimap |
| `setMinimapOptions(patch)` | Update minimap options at runtime |

### Additional Drawings

| Method | Description |
|--------|-------------|
| `addDrawing(id, opts)` | Add an additional drawing layer |
| `updateDrawing(id, patch)` | Update position, size, opacity, rotation, or visibility |
| `setAdditionalDrawingVisible(id, bool)` | Show/hide an additional drawing |
| `removeDrawing(id)` | Remove an additional drawing |
| `clearDrawings()` | Remove all additional drawings |
| `getDrawingIds()` | Get array of all additional drawing IDs |
| `getDrawing(id)` | Get drawing state `{ x, y, width, height, opacity, visible, rotation, sourceWidth, sourceHeight }` |

### Events

| Method | Description |
|--------|-------------|
| `on(event, fn)` | Subscribe to an event (chainable) |
| `off(event, fn?)` | Unsubscribe; omit `fn` to remove all listeners for that event |
| `once(event, fn)` | Subscribe, but fire only once |

### Utility

| Method | Description |
|--------|-------------|
| `refresh()` | Force canvas resize and redraw |
| `getDrawingSize()` | Returns `{ width, height }` of main drawing |
| `getZoom()` | Get current zoom level |
| `getPan()` | Get current pan position `{ x, y }` |
| `getVisibleArea()` | Get visible area in world coords `{ x, y, w, h }` |
| `screenToWorld(sx, sy)` | Convert screen pixel to world coordinate |
| `worldToScreen(wx, wy)` | Convert world coordinate to screen pixel |
| `isPointInDrawing(x, y)` | Check if world point is inside main drawing bounds |
| `setOptions(patch)` | Merge partial options at runtime |
| `destroy()` | Remove overlay and clean up all resources |

### addDrawing options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `source` | `string` | — | Image or PDF URL |
| `page` | `number` | `1` | PDF page (1-based) |
| `x` | `number` | `0` | X position in world coordinates |
| `y` | `number` | `0` | Y position in world coordinates |
| `width` | `number` | source width | Display width |
| `height` | `number` | source height | Display height |
| `opacity` | `number` | `1` | Opacity (0–1) |
| `visible` | `boolean` | `true` | Visibility |
| `rotation` | `number` | `0` | Rotation in degrees (0, 90, 180, 270) |

## Changelog

### 1.3.0

- **Breaking**: `fit()` now accepts an options object instead of a padding number: `fit({ animate, padding, duration, easing })`. Calling `fit()` with no arguments still works (uses defaults).
- **Breaking**: Removed `panToElement()` — use application-level implementation for element navigation with custom zoom/animation logic.
- **Changed**: Default `fitPadding` changed from `50` to `0`.
- **Added**: `fit()` now supports `animate` option with configurable `duration` (default 300ms) and `easing` (default `ease-in-out-cubic`).
- **Added**: `fit()` now calls `cy.resize()` before calculating dimensions.

### 1.2.3

- **Fix**: `_springBackIfNeeded` now respects `panClamp: false`. Previously, setting `panClamp: false` at runtime disabled hard clamping but the soft spring-back animation on mouse release still fired, snapping the viewport back to drawing bounds. This made it impossible to programmatically disable pan clamping (e.g., during `panToElement` animations).

## How it works

1. A `<canvas>` element is inserted behind Cytoscape's graph canvas
2. On every zoom/pan event, the canvas applies the same transform matrix as Cytoscape
3. Drawing coordinates map 1:1 to Cytoscape world coordinates — place nodes at drawing positions directly
4. Pan clamping: `'hard'` strictly prevents crossing the boundary. `'soft'` uses iOS-style rubber-band — drag freely to the boundary, then movement meets heavy logarithmic resistance; on release, spring-back animation returns to boundary (280ms cubic ease-out)
5. CSS filters are applied in the order: `invert → brightness → contrast → saturate → grayscale`. Invert is applied first so that brightness/contrast adjustments affect the inverted result correctly
6. For PDFs, a low-quality render is shown immediately, then a high-quality render follows after interaction stops
6. Rotation is applied per-drawing around its center via canvas `translate`/`rotate` transforms
7. Events fire through both the `on()`/`off()` emitter and legacy `onXxx` callbacks for backward compatibility
8. Minimap uses DOM-based rendering (CSS `backgroundImage`) for crisp image quality. Two viewport styles: `'dim'` darkens outside viewport via `boxShadow`, `'rect'` highlights viewport with a bordered rectangle

## License

MIT

# ol-webgpu

[![CI](https://github.com/jeroenvheel/ol-webgpu/actions/workflows/ci.yml/badge.svg)](https://github.com/jeroenvheel/ol-webgpu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ol-webgpu/next?label=npm)](https://www.npmjs.com/package/ol-webgpu)

WebGL2 and WebGPU vector layers for [OpenLayers](https://openlayers.org), with
a Rust/WebAssembly geometry core.

```js
import {GpuVectorLayer} from 'ol-webgpu';

const layer = new GpuVectorLayer({
  source: vectorSource, // any ol/source/Vector
  style: {
    'circle-radius': ['get', 'size'],
    'circle-fill-color': ['match', ['get', 'kind'], 0, '#1b9e77', '#d95f02'],
    'stroke-color': '#333',
    'stroke-width': 1.5,
    'fill-color': '#4a90d955',
  },
  variables: {minSize: 2},
});
map.addLayer(layer);
```

- `GpuVectorLayer` uses WebGPU where available and falls back to WebGL2 (also
  at runtime, if no WebGPU device can be created).
- `WebGL2VectorLayer` and `WebGPUVectorLayer` force one backend.
- Options and methods mirror `ol/layer/WebGLVector`: `style` (flat style,
  rules with `filter`/`else`, expressions), `variables`,
  `updateStyleVariables()`, `setStyle()`, `disableHitDetection`.
  Extra options: `antialias` (default `false`), `smoothFill` (default
  `false`: fills without a stroke fade out over one pixel outside the
  polygon instead of ending in stairs, at about the cost of a stroke; see
  [bench/fixes-2026-11-24.md](bench/fixes-2026-11-24.md)), `preserveDrawingBuffer`
  (default `true`, needed for map export), `wasmUrl`, `shaderWasmUrl`, and on
  `GpuVectorLayer` `backend` (`'auto'` (default), `'webgpu'` or `'webgl2'`).
- `text-*` styles are drawn on the GPU from a glyph atlas (`text: 'gpu'`, the
  default): with the page's web fonts, at the device pixel ratio, in every
  world copy, hit-detectable, and with `declutter: true` (or a group name)
  without overlapping. `text: 'canvas'` draws them with ol's text worker
  instead, exactly as `ol/layer/WebGLVector` does. See [Labels](#labels).
- Like `WebGLVector`, dispose layers you no longer use.

## Installation

The package is on npm as [ol-webgpu](https://www.npmjs.com/package/ol-webgpu).

```sh
npm install ol-webgpu@next ol@10.11
```

This is a beta (`next` tag). `ol` is a peer dependency pinned to 10.11.x,
because the package uses non-API ol modules (see Limitations).

### Bundlers

The package is an ES module that loads three files next to itself with
`new URL('assets/…', import.meta.url)`: the geometry worker
(`assets/worker-*.js`), `assets/ol_gpu_core-*.wasm` and, for WebGPU only,
`assets/ol_gpu_shader-*.wasm`. Bundlers that understand this pattern copy
the files for you; for the others, copy `node_modules/ol-webgpu/dist/assets`
to an `assets/` folder next to the app's JavaScript.

- **Vite**: production builds work as is (`npm run test:dist` checks this).
  If the dev server's dependency pre-bundling breaks the URLs, add
  `optimizeDeps: {exclude: ['ol-webgpu']}`.
- **Angular** (application builder, esbuild): the files are not bundled, so
  copy them and keep the package out of the dev server's pre-bundling. In
  `angular.json` / `project.json`:

  ```json
  "build": {"options": {"assets": [
    {"glob": "*.{wasm,js}", "input": "node_modules/ol-webgpu/dist/assets", "output": "assets"}
  ]}},
  "serve": {"options": {"prebundle": {"exclude": ["ol-webgpu"]}}}
  ```

- **webpack 5** handles `new URL(…, import.meta.url)` and
  `new Worker(new URL(…))` itself (asset modules); not tested here.
- **Other setups**: if the wasm files are served elsewhere, pass their URLs
  with the `wasmUrl` and `shaderWasmUrl` layer options. The worker is always
  loaded from `assets/` next to the module.

**Content Security Policy.** Compiling WebAssembly needs `'wasm-unsafe-eval'`
in `script-src`. With `text: 'canvas'`, labels use ol's text worker, which
starts from a `blob:` URL (as with ol's own `WebGLVector`):

```
script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:
```

A worker gets the CSP of its own script response, not the page's: if your
server sends the CSP as an HTTP header for the worker file too, it needs
`'wasm-unsafe-eval'` there as well.

**Jest** (CommonJS) cannot load ES modules that use `import.meta.url`. Map
the package to a stub in unit tests, for example one that exports ol's
`WebGLVectorLayer` under the same names:

```js
// jest config
moduleNameMapper: {'^ol-webgpu$': '<rootDir>/test/ol-webgpu.stub.ts'},
```

```ts
// test/ol-webgpu.stub.ts
import WebGLVectorLayer from 'ol/layer/WebGLVector';
export const GpuVectorLayer = WebGLVectorLayer;
export const WebGL2VectorLayer = WebGLVectorLayer;
export const WebGPUVectorLayer = WebGLVectorLayer;
export const isWebGPUAvailable = () => false;
```

## How it works

```
ol/source/Vector ──► MixedGeometryBatch ──► render instructions      (main thread)
                                              │
                                              ▼  transferred
                              worker: Rust/WASM (crates/core)
                              ├─ point / line / polygon buffers (earcut)
                              └─ packed Hilbert R-tree for hit detection
                                              │
              ┌───────────────────────────────┴─────────────────────────┐
              ▼                                                         ▼
   WebGL2VectorRenderer                                     WebGPUVectorRenderer
   ol's GLSL shaders as-is                     ol's GLSL ─► naga (Rust/WASM, crates/shader) ─► WGSL
   VAOs, instancing, u32 indices                          one pipeline per pass, MSAA optional
```

- **Same shaders as ol.** Styles are compiled by ol's own `ShaderBuilder`
  (`convertStyleToShaders`). WebGL2 runs the GLSL ES 1.00 output directly;
  WebGPU gets it translated to WGSL by [naga](https://github.com/gfx-rs/wgpu/tree/trunk/naga)
  (after a small pre-pass in `src/style/glsl.ts`: uniform block, split
  samplers, explicit locations, `gl_FragCoord` origin, clip-space z). Every
  style feature ol supports therefore renders the same on both backends, and
  follows ol when it is upgraded.
- **Same buffers as ol.** `crates/core/src/tessellate.rs` is a port of
  `ol/worker/webgl.js` + `bufferUtil.js`; golden tests check it against ol's
  JS for synthetic data and for `countries.json`.
- **Buffers are built for the features, not for the view.** ol's layer
  builds all buffers again each time the view comes to rest on another
  extent. The buffers hold every feature of the source and are drawn through
  the inverse of the transform they were built with, so here they are only
  built again when the features changed, or when the view is so far from
  where they were built (2^19 pixels of the current view) that 32 bit floats
  would no longer place them exactly. Features are still loaded for each new
  extent, as ol does. One build runs at a time per layer: features that
  arrive in parts are drawn as they come, without builds whose result is
  thrown away. Features that are added, changed or removed while the view
  moves are built right away, so a map that follows what it shows keeps
  showing it; a build for another place waits until the view rests. The
  render instructions have ol's layout and values
  (`src/render/instructions.ts`), but the style attributes of a feature are
  computed once and kept until the feature changes, where ol's generators
  call every attribute callback for every geometry on each build: 300 000
  points with 7 attributes take about 30 ms instead of 150 ms. With
  `text: 'canvas'` the buffers follow the extent as in ol, because ol's text
  worker draws the text for the view of the build.
- **Adding features.** The batch is ol's `MixedGeometryBatch` with the refs
  kept another way (`src/render/batch.ts`): ol looks every added feature up
  in a Map from uid to ref, which took half the time of adding features to
  a big source. Here the ref comes from the entries and the features are in
  an array at their ref: 200 000 points are added in about 70 ms instead of
  230–430 ms. `test/unit/batch.test.ts` checks that it holds what ol's batch
  holds.
- **CPU hit detection.** WebGPU readback is asynchronous, but OpenLayers asks
  for hits synchronously, so picking uses a spatial index (built in Rust in the
  worker, queried by a main-thread wasm instance) plus the style's filter,
  symbol size and place (displacement, `icon-anchor`, rotation), stroke width
  and `stroke-offset`, and fill, evaluated with ol's CPU expression
  evaluator. Unlike ol's GPU picking it honours `hitTolerance`, respects
  `filter`, and can return all features under the cursor.
- **Text on the GPU.** See [Labels](#labels). With `text: 'canvas'`,
  `text-*` styles are drawn by ol's own text overlay worker instead
  (`ol/worker/textOverlay.js`, loaded on demand): it turns the render
  instructions into Canvas 2D label batches and, after each frame, draws them
  into an image for that frame. The layer composites the image with ol's
  post-process maths (`src/render/textOverlay.ts`), reprojected to the
  current view until the next image arrives, so labels follow the map while
  panning. Unlike ol's layer, `rendercomplete` waits for the labels, so map
  export includes them.
- **Shared canvases, like ol.** Consecutive layers of one backend with the
  same `className` draw into one canvas (one WebGL context, or for WebGPU
  one canvas texture and render pass per frame). Layers with an opacity
  below 1, or with labels from the text worker, are drawn into an offscreen
  image first and composited with the layer opacity. WebGPU layers record into one command
  encoder that is submitted once per map frame.
- **Workers.** One worker builds the buffers of all layers of the page. When
  it has a lot to do (4 MB of instructions or more are waiting) a second one
  starts, so a big layer does not hold up the others; it stops again after
  10 seconds without builds.
- **Fallbacks.** If WebAssembly cannot load, the worker uses ol's JS buffer
  code; if WebGPU is unavailable, `GpuVectorLayer` uses WebGL2. If the
  worker cannot start (its file is missing, or a Content Security Policy
  blocks it) or fails, a warning is logged and the buffers are built on the
  main thread from then on: the layers stay complete, but big builds block
  the page while they run. A `WebGPUVectorLayer` that gets no device (or no
  shader translator) tries again after 1, 2, 4, ... up to 30 seconds, as long
  as the browser has WebGPU; `GpuVectorLayer` goes to WebGL2 at once.
- **Images of the style.** While an icon or a pattern image loads, the layer
  is drawn without it and is not ready: `rendercomplete` (and so a map
  export) waits for the image, and the layer is drawn again when it is there.
- **Another source.** After `layer.setSource()` the layer shows the features
  of the new source and nothing of the one before; without a source it
  shows nothing.
- **Background.** The `background` option of a layer (a colour, or a function
  of the resolution) is the background colour of its canvas element, with
  the layer's opacity and only while the layer is visible, as with ol's
  Canvas layers. It is behind everything on that canvas, so a layer with a
  background starts a canvas of its own unless the layers below it on the
  shared canvas have the same one. Like ol's, it is CSS: a map export that
  draws the canvases has to fill it in itself.
- **A build that fails.** When the buffers of a layer cannot be built (out of
  memory, mostly), the layer keeps what it shows, the worker gets a new wasm
  instance, and the build is made again after 1, 2 and 4 seconds. After that
  it waits until the features change.

## Labels

```js
new GpuVectorLayer({
  source,
  style: {
    'circle-radius': 4,
    'circle-fill-color': '#b03a2e',
    'text-value': ['get', 'name'],
    'text-font': 'bold 13px "Open Sans", sans-serif', // fonts of the page work
    'text-fill-color': '#1c2833',
    'text-stroke-color': '#ffffff',
    'text-stroke-width': 3,
    'text-offset-y': -12,
  },
  declutter: true, // or a group name shared by several layers
});
```

With `text: 'gpu'` (the default) the layer draws its labels itself
(`src/text`). The approach follows the `webgpu-renderer` branch of
OpenLayers (font atlas with separate halo and fill coverage, instanced glyph
quads, greedy decluttering); the code here is written for this package's
two backends and GPU-evaluated styles.

- **Style.** Only the `text-*` properties (and `filter`, `else`, `z-index`)
  are evaluated per feature on the CPU, with ol's flat style compiler
  (`ol/render/canvas/style.js`). Fills, strokes and symbols stay on the GPU.
- **Atlas.** Each grapheme is drawn once with Canvas 2D on the main thread,
  so the page's `@font-face` fonts work, at the device pixel ratio, with the
  halo in one colour channel and the fill in another. One atlas (2048 px
  wide, growing to 4096 px high) is shared by all layers of the page. Text
  in scripts that need shaping (Arabic, Hebrew, Indic, combining marks) is
  drawn as a whole line. Along a line with bends such text is cut per
  stretch of the line; an Arabic or Syriac word that is cut keeps its joined
  letter forms and its length (ol spreads it out, see `src/text/textpath.ts`). When a web font of the labels finishes loading, or
  the atlas is full, it starts over on a new page and the labels are laid
  out again; until then they are drawn as they were, from the page before.
  Other fonts of the page (an icon font, the fonts of the interface) change
  nothing. A full atlas only starts over when that helps: when the labels of
  the last layout of every layer fit together, so it is full of glyphs of
  labels that are gone (and at most every 5 seconds). Labels that need more
  glyphs than the atlas holds keep the ones they have, and a warning is
  logged. Font sizes with a fraction are taken in half pixels and halo
  widths in quarter pixels, so a size that is computed (from a property or
  the zoom) does not get cells of its own for every value.
- **Layout.** Positions follow ol's Canvas text renderer: alignment,
  justification, baseline, offsets, rotation, scale, padding, background,
  several lines, polygon labels at the interior point (hidden when wider
  than the polygon unless `text-overflow`), and text along lines
  (`text-placement: 'line'`, with `text-max-angle`, `text-repeat`,
  `text-keep-upright`). Only the features in view (plus a margin) are laid
  out, a slice per frame (10 ms, 4 ms while the view moves); the labels on
  screen stay until the new ones are ready. A new layout is made when the
  view leaves that area, and when the resolution (or, for text along lines
  and with decluttering, the rotation) has changed and the view has settled.
  Text along a line that is kept upright has its glyphs for both directions,
  so it is upright in every frame of a view that turns; a label that is
  loaded again as another feature object, with the same text at the same
  place, stays as it is instead of fading in.
- **Drawing.** A glyph is an instanced quad, drawn after the layer's
  geometries in the same pass, in every world copy. Labels are drawn one
  after the other, by `z-index` and then feature age, each as its
  background, the halos of all its glyphs and then their fills. So a halo
  never covers a letter of its own label, and a label that overlaps another
  covers it, background and halo included, as on a Canvas. Upright labels
  are placed on whole device pixels with glyphs at quarter-pixel positions,
  like Canvas text.
- **Decluttering.** `declutter: true` hides labels that would overlap a
  label with a higher priority: higher `z-index` first, then older features.
  Layers with the same `declutter` value share the space, higher layers
  first. `text-declutter-mode` (`'declutter'`, `'obstacle'`, `'none'`) works
  as in ol. Labels that are shown keep their place while the view moves, and
  labels fade in and out (150 ms). All labels are measured, but only those
  that can win a place get glyphs.
- **Hit detection.** A shown label is hit within its box (with
  `hitTolerance`), before the geometries below it.

Compared with ol's Canvas vector layer (`ol/layer/Vector`), upright text is
the same pixel for pixel, also with decluttering; see [Tests](#tests).
`examples/labels-compare.html` shows the Canvas layer, ol's `WebGLVector`
and both ol-webgpu layers side by side with one source and style.

## Development

Requirements: Node 20+, Rust (stable, `rustup target add wasm32-unknown-unknown`).
On Windows without Visual Studio, the GNU host toolchain works
(`rustup-init --default-host x86_64-pc-windows-gnu`).

```sh
npm install
npx playwright install chromium   # for the browser tests and the benchmark
npm run build:wasm            # crates/* → src/wasm/*.wasm
npm run fetch-upstream        # ol's rendering tests + data for the installed ol version → .upstream/
npm run sync-upstream-tests   # copy ol's WebGLVector rendering cases + data into test/rendering
npm run dev                   # examples on http://localhost:5180 (compare.html, bench.html)
npm test                      # unit tests (vitest): golden buffers, shader translation
npm run test:rust             # cargo tests of both crates
npm run test:rendering        # screenshots, hit detection, text, labels, export, shared canvas and RenderFeature checks in Chromium
npm run test:memory           # leak checks: repeats what a layer does and counts what stays alive
npm run test:memory -- --big  # one big layer step by step, from ol/Feature and from RenderFeatures
npm run bench                 # benchmark, see bench/run.js for options
npm run build                 # dist/ (ES module + worker + wasm + .d.ts)
npm run test:dist             # production app build against dist/, checked in Chromium
```

`.upstream/openlayers` is a shallow, sparse clone of the ol tag matching the
installed version, made by `npm run fetch-upstream`.

Browser flags per platform are in `test/browser.js`. On Windows the tests use
the real GPU via D3D11. Playwright's bundled Chromium there lacks
`dxcompiler.dll`, so the runners pass `--disable-dawn-features=use_dxc`; use
`--channel=msedge` to test with an installed browser instead. On Linux in CI
they use SwiftShader, which provides both WebGL2 and WebGPU without a GPU.
Without a WebGPU adapter, `test:rendering` skips the WebGPU layer with a
warning; `--require-webgpu` makes that an error.

**Releasing.** Set the version, commit, and push a matching tag:

```sh
npm version 0.1.0-beta.1 --no-git-tag-version   # or edit package.json
git commit -am "Release 0.1.0-beta.1"
git tag v0.1.0-beta.1 && git push origin main v0.1.0-beta.1
```

The `Release` workflow (`.github/workflows/release.yml`) then publishes to
npm with trusted publishing: no npm token, the job identifies itself to npm
with GitHub's OIDC token, and npm adds a provenance statement. Versions
with a `-` (beta, rc) are published under the `next` tag, others under
`latest`. `npm publish` runs `prepublishOnly` first (`npm run build`,
including the wasm, then `npm run test:dist`), so the package is always
built from the tagged sources. Check the contents with `npm pack --dry-run`.

**CI.** GitHub Actions (`.github/workflows/ci.yml`) runs on every push to
`main` and on pull requests (Ubuntu, SwiftShader): wasm build, typecheck,
unit and Rust tests, a check that the synced upstream cases are current, all
rendering, hit detection, text, export, shared canvas and RenderFeature tests with WebGPU
required, the package
build and the dist smoke test. On failure, the screenshots and diffs are
uploaded as the `rendering-report` artifact.

## Tests

**Rendering.** All 19 upstream `WebGLVector` rendering cases from ol 10.11 are
synced (`main.js` with the layer class swapped, and ol's own `expected.png`),
and each is rendered with ol's `WebGLVector`, `WebGL2VectorLayer` and
`WebGPUVectorLayer`:

Results on Chromium / Intel Iris Xe (D3D11), share of pixels differing from
upstream's `expected.png`:

| Case | ol WebGLVector | WebGL2 | WebGPU | WebGL2 ↔ WebGPU |
|---|---|---|---|---|
| webgl-circles | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-fill-pattern | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-fill-pattern-zoomed-in | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-holes | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-icons | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-layer-canvas-group-changes-for-points | 0.18% | 0.18% | 0.18% | 0.00% |
| webgl-line | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-line-metric | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-line-pattern | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-line-zoomed-in | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-multiple-layers | 0.32% | 0.32% | 0.32% | 0.00% |
| webgl-points | 0.19% | 0.19% | 0.19% | 0.00% |
| webgl-points-geographic | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-points-rotation | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-shapes | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-vector | 0.02% | 0.02% | 0.02% | 0.00% |
| webgl-vector-geographic | 0.00% | 0.00% | 0.00% | 0.00% |
| webgl-text-style | 1.58% | 0.00% vs ol | 0.00% vs ol | 0.00% |
| webgl-text-style-linestring | 2.10% | 0.00% vs ol | 0.00% vs ol | 0.00% |

All 19 cases pass on both backends, and WebGL2 and WebGPU produce identical
pixels. The two text cases run with `text: 'canvas'`, ol's text worker. The 17 geometry cases deviate from the reference exactly as much as
ol's own layer does on this machine (driver differences against the CI
machine that made `expected.png`).

The two text cases are compared with ol's `WebGLVector` rendered on the same
machine instead, and match it pixel for pixel. Their `expected.png` cannot
be reproduced elsewhere. ol's text worker only sees fonts registered inside
the worker, so upstream's `@font-face` "Ubuntu" never reaches it, and the
glyphs come from the machine's fallback font. That is why ol itself is off by
1.6–2.1% here.

**Labels on the GPU.** `test/rendering/gputext.ts` renders ten scenarios
with ol's Canvas vector layer and with both backends, at pixel ratios 1 and
2, and compares the screenshots (share of differing pixels, Chromium on
Windows):

| Scenario | 1x | 2x |
|---|---|---|
| several lines, justified, with a halo and a second style | 0.00% | 0.00% |
| overlapping labels with backgrounds, halos and `z-index` | 0.00% | 0.00% |
| polygon labels, with and without `text-overflow` | 0.01% | 0.00% |
| 400 labels on a grid, decluttered | 0.00% | 0.00% |
| labels in several world copies | 0.00% | 0.00% |
| a web font from the page's `@font-face` | 0.00% | 0.00% |
| Arabic, Hebrew and Devanagari | 0.00% | 0.00% |
| text along lines, also reversed and repeated | 1.43% | 0.39% |
| the same in a rotated view | 1.46% | 0.34% |
| alignment, rotation, scale and background in a rotated view | 2.0% | 0.76% |

WebGL2 and WebGPU give the same pixels. Rotated text is resampled a little differently than Canvas
does it. In a rotated view Canvas also resamples upright labels, where GPU
text keeps them on whole pixels; that is most of the last row.

`test/rendering/labels.ts` checks 16 situations on both backends: hit
detection of labels (also with `hitTolerance`, and not for a label hidden by
decluttering), a new layout after panning and zooming, style variables, a
new style, added and removed features, the layer opacity, and web fonts
that load: one no label uses leaves the atlas as it is, one of the labels
makes it start over, and the labels of a layer with 40 000 features stay on
screen for the frames it takes to lay them out again.
`test/unit/atlas.test.ts` covers when a full atlas starts over.
`test/unit/declutter.test.ts` covers the collision grid and the choice of
the labels that get glyphs.

**Text while panning.** With `text: 'canvas'`, `test/rendering/text.ts` pans by whole pixels and
reads the frame in the same task, so it shows the previous text image
reprojected with the overlay matrix. It must equal the previous frame shifted
by the same amount. It does, with 0 differing pixels on both backends, with
and without view rotation.

**Map export.** `test/rendering/export.ts` reads the layer canvases with
`drawImage` in a `rendercomplete` listener: the drawn layer must read back
complete (14 400 px), an empty layer must read back empty, and after its
features are removed the layer must disappear from the screen. With an icon
that the server sends after 700 ms, the first `rendercomplete` of the map
must come with the icon drawn. Both backends pass.

**Shared canvases.** `test/rendering/shared.ts` renders two layers, an ol
canvas layer and a third layer, one of them with opacity 0.5 and overlapping
features. It checks that the first two share a canvas (3 canvases in map
order) and compares the screenshot with ol's `WebGLVector` layers: 0.00%
differing pixels on both backends, with and without `antialias`.

**Hit detection.** `test/rendering/picking.ts` checks 31 situations (symbol
radius, stroke width, polygon fill and holes, `hitTolerance`, filtered-out
features, rotation, panning, and symbols and strokes that are not drawn on
their geometry: a displaced circle, a stroke with an offset, an icon
anchored at its bottom, a symbol of 150 px; and a view that shows the world
more than once, where a feature and its label are reported once). WebGL2
and WebGPU pass all 31. ol's
`WebGLVector` fails two by design (it ignores `hitTolerance` and returns
features hidden by a style `filter`), and is flaky right after a rebuild
because its GPU hit buffer is rendered asynchronously.

**When buffers are built.** `test/rendering/rebuild.ts` checks on both
backends that panning and zooming build nothing, that the moved view picks
the right features and is drawn exactly (0 differing pixels) like the same
view with buffers built for it, that an added feature and a changed property
each take one build, that a feature added during an animation is built
before the view rests, and that a view 2^20 pixels away builds again. All of
it runs a second time with a worker that fails while it has the first
build: the build is then made again on the main thread, and so are the
following ones. `test/unit/worker.test.ts` covers the worker client. The
WebGPU layer runs a third time with no adapter at the first request: it
tries again and then passes the same checks, and the WebGL2 layer once more
with a first build that fails. The page also checks that another source
replaces the features (and no source shows nothing), and that backgrounds
end up on the canvases: shared, with the opacity, split when they differ.
`test/unit/instructions.test.ts` checks that the render instructions equal
those of ol's generators float for float, also after features changed, were
removed and added, and that attribute callbacks run once per feature.

**RenderFeatures.** Vector tile formats read features as `ol/render/Feature`
(RenderFeature), which a vector source can hold as well. `test/rendering/renderfeature.ts`
builds one scene twice, from `ol/Feature` and from RenderFeatures as
`ol/format/MVT` makes them (a polygon with several outer rings is one
`'Polygon'`, split by ring orientation): points, multipoints, lines,
multilines, a polygon with a hole and a multipolygon, with labels at a point
and along a line. On both backends, with GPU and with canvas text, the two
screenshots are identical, `forEachFeatureAtPixel` picks the same ids at 11
pixels (fills, holes, lines, points, a label), and returns the RenderFeatures
themselves. `test/unit/renderfeature.test.ts` checks that RenderFeatures give
the same render instructions, Rust/WASM buffers and text styles as Features.
`npm run test:memory` runs each of its leak checks with both kinds of
feature, and `--big` compares what a big layer costs with each.

**Package.** `npm run test:dist` builds a small app against `dist/` for
production and checks in Chromium that WebGPU, WebGL2 and the runtime
WebGPU → WebGL2 fallback of `GpuVectorLayer` render (including a label),
pick, and can be exported with `drawImage` in a `rendercomplete` listener.

## Benchmark

`npm run bench -- --layers=ol,webgl2,webgpu` (examples/bench.html in
Playwright Chromium, Intel Iris Xe laptop GPU, D3D11, 1100×900 map, all
features in view, one layer). Milliseconds, lower is better. A frame is
`renderSync()` plus a 1-pixel readback of the canvas, so it includes the
GPU work. Runs on a laptop vary by 10–30%; compare columns of one run.

**End to end per layer**

| Data set | | ol WebGLVector | WebGL2 | WebGPU |
|---|---|---|---|---|
| 1M points | ready (add layer → rendercomplete) | **920** | 1045 | 1015 |
| | frame (pan, no rebuild) | 139 | 85 | **24** |
| | pick (`forEachFeatureAtPixel`) | 0.01 | 0.09 | 0.11 |
| 200k lines | ready | 2256 | 868 | **850** |
| | frame | 389 | **32** | 37 |
| | pick | 0.52 | 0.05 | 0.04 |
| 100k polygons | ready | 1799 | 797 | **702** |
| | frame | 307 | 39 | **21** |
| | pick | 0.00 | 0.03 | 0.02 |

**Buffer generation (worker), ol's JS vs Rust/WASM**

| | ol JS | Rust/WASM |
|---|---|---|
| 1M points | 5 | 9 |
| 200k lines | 1385 | **243** (5.7×) |
| 100k polygons (earcut) | 372 | **40** (9×) |
| hit index build, 1M points / 200k lines / 100k polygons | – | 150 / 95 / 26 |

What this shows:

- **Frames** are 8–15× faster than ol's layer for lines and polygons, and
  about 6× faster for points on WebGPU (1.6× on WebGL2), with the same
  shaders and buffers. The gap is in how frames are drawn (ol renders into
  an offscreen framebuffer and copies it, among other things); it has not
  been profiled further.
- **Time to first render** is about 2.5× shorter for lines and polygons,
  where the tessellation is Rust's. For points it is on par: there the time
  goes into ol's main-thread steps (`MixedGeometryBatch` ≈ 0.4 s and render
  instructions ≈ 0.12 s for 1M points), which this package reuses and which
  cannot move to WASM while the input is `ol/Feature` objects.
- **Picking** costs about 0.1 ms or less, like ol's GPU readback, but works
  on WebGPU and is correct in the two cases where ol's is not. The first
  pick after a rebuild is slower (a few ms, up to about 50 ms for 1M
  points) while feature-dependent sizes are still being measured.
- Point buffers are a plain copy, so WASM gains nothing there.
- This benchmark has one layer. On maps with many layers, the shared
  canvases matter more: on a real map with 24 vector layers (660k
  features, Intel Iris Xe, 60 Hz), zooming with the whole map in view ran
  at 16 fps with ol's layers, 18 fps with WebGL2 and 29 fps with WebGPU.

**Labels** (`examples/labels.html`: country names and random place names,
1100×900 map, decluttered, AMD Radeon R9 200, Chromium). A frame is
`renderSync()` while panning:

| Places | | ol Canvas layer | GPU text |
|---|---|---|---|
| 20 000 (5 900 in view) | frame while panning | 20 | **0.9** |
| | label layout after a zoom | (in the frame) | 34, over 3 frames |
| 200 000 (59 000 in view) | frame while panning | 168 | **4.8** |
| | label layout after a zoom | (in the frame) | 208, over 12 frames |
| | worst frame while panning | 330 | 121 |

The Canvas layer lays out and declutters all labels in every frame; GPU
text measures them once per layout, gives glyphs to the 1 700 to 2 300 that
can win a place, and declutters those per frame (0.4 ms). The worst frame
is the one that starts a new layout (collecting and sorting the features in
view), which is not sliced yet.

## Limitations

- **Labels on the GPU** (`text: 'gpu'`):
  - Text styles are evaluated on the main thread, per feature in view, at
    each layout. With very many labels in view this is the cost to watch
    (about 4 µs to measure a label, 10 µs to lay one out with glyphs).
    Without `declutter` every label in view gets glyphs.
  - Labels are laid out for one resolution. While zooming they keep their
    size and anchor, but text along a line does not follow the line more
    closely, and labels that would newly fit only appear after the view
    has settled.
  - `['zoom']` cannot be used in `text-*` expressions (ol's CPU expression
    evaluator has no zoom; use `['resolution']`). Gradient and pattern
    fills for text are not supported.
  - Labels are drawn after the geometries of their own layer, so a higher
    layer's geometries cover them (ol's Canvas layers draw decluttered
    labels above all layers of the canvas). Decluttering is not shared with
    ol's Canvas layers.
  - Only labels are decluttered. ol's Canvas layer also declutters point
    symbols, together with their labels; here every symbol is drawn and
    does not take space (`examples/labels-compare.html` shows the
    difference).
  - Hit detection uses the label's box, not its glyphs.
  - Compared with ol's text worker (`WebGLVector`, `text: 'canvas'`) the
    pixels differ: translucent halos and backgrounds are blended as Canvas
    does, where ol's text post-process applies the alpha twice.
- **Labels from ol's text worker** (`text: 'canvas'`) have ol's own
  limitations:
  - Only fonts available inside a worker can be used: system fonts, or fonts
    the worker loads itself. Web fonts from the page's `@font-face` are not
    seen (with ol's `WebGLVector` neither).
  - Labels are drawn at CSS-pixel resolution, ignoring `pixelRatio`, and for
    the central world copy only.
  - Labels are not hit-detectable.
  - Labels appear one worker round-trip after the geometries.
  - `declutter` has no effect.
- Depends on non-API ol modules (`ol/render/webgl/*`, `ol/expr/*`), so the
  peer dependency is pinned to ol 10.11.x; the golden and rendering tests
  catch breaking changes when upgrading.
- `antialias: true` gives smoother edges than ol (which draws into a
  non-multisampled framebuffer); the default `false` matches ol exactly.
- Map export (`drawImage` of the layer canvas in `rendercomplete`, as in
  ol's export examples) needs `preserveDrawingBuffer` (default `true`). On
  WebGPU this draws the last frame once more on `rendercomplete`; set it to
  `false` to skip that if you never export. Not while the view is being
  dragged or animated (ol fires `rendercomplete` after each such frame), so
  WebGPU layers read back empty in a `rendercomplete` listener during an
  interaction; the frame after it ends is readable again.
- Like ol's WebGL layers, consecutive layers of the same backend with the
  same `className` (and the same `antialias` and `preserveDrawingBuffer`)
  share one canvas; any other layer in between starts a new one. Give a layer
  its own `className` if it needs its own canvas (e.g. for CSS). Browsers
  keep only about 16 WebGL contexts per page, so a canvas per layer would
  lose layers on maps with many of them. Layers with an opacity below 1, or
  with labels from the text worker, are drawn into an offscreen image first
  and composited with the layer opacity, as ol does.
- WebGPU layers record their frames into one shared command encoder that is
  submitted once per map frame (on the map's `postcompose`), so reading a
  layer canvas in the same task after `renderSync()` works as with WebGL.
- Hit detection is geometric: dash gaps and transparent icon pixels still
  count as hits; an icon is hit within its rectangle, a circle or shape
  within its radius. A stroke with an offset is hit beside the nearest
  segment of its line, so at a sharp bend the hit area is not exactly the
  drawn join. When symbol or stroke sizes (or displacements) depend on
  feature properties, how far they reach is measured in idle time after
  each rebuild; until then (and for sizes that change with `time`) picks
  search 128 px around the cursor, which is slower on dense data and misses
  what is drawn further than that from its geometry.
- The naga shader translator is ~1.3 MB of wasm (loaded once, only by the
  WebGPU layer).

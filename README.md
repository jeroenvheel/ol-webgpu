# ol-webgpu

[![CI](https://github.com/jeroenvheel/ol-webgpu/actions/workflows/ci.yml/badge.svg)](https://github.com/jeroenvheel/ol-webgpu/actions/workflows/ci.yml)

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
  Extra options: `antialias` (default `false`), `wasmUrl`, `shaderWasmUrl`.
- Like `WebGLVector`, dispose layers you no longer use.

## How it works

```
ol/source/Vector ──► MixedGeometryBatch ──► render instructions      (main thread, ol code)
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
- **CPU hit detection.** WebGPU readback is asynchronous, but OpenLayers asks
  for hits synchronously, so picking uses a spatial index (built in Rust in the
  worker, queried by a main-thread wasm instance) plus the style's filter,
  symbol radius, stroke width and fill evaluated with ol's CPU expression
  evaluator. Unlike ol's GPU picking it honours `hitTolerance`, respects
  `filter`, and can return all features under the cursor.
- **Same text as ol.** `text-*` styles are drawn by ol's own text overlay
  worker (`ol/worker/textOverlay.js`, loaded on demand): it turns the render
  instructions into Canvas 2D label batches and, after each frame, draws them
  into an image for that frame. The layer composites the image with ol's
  post-process maths (`src/render/textOverlay.ts`), reprojected to the
  current view until the next image arrives, so labels follow the map while
  panning. Unlike ol's layer, `rendercomplete` waits for the labels, so map
  export includes them.
- **Fallbacks.** If WebAssembly cannot load, the worker uses ol's JS buffer
  code; if WebGPU is unavailable, `GpuVectorLayer` uses WebGL2.

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
npm run test:rendering        # screenshots, hit detection and text checks in Chromium
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

**CI.** GitHub Actions (`.github/workflows/ci.yml`) runs on every push to
`main` and on pull requests (Ubuntu, SwiftShader): wasm build, typecheck,
unit and Rust tests, a check that the synced upstream cases are current, all
rendering, hit detection and text tests with WebGPU required, the package
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
pixels. The 17 geometry cases deviate from the reference exactly as much as
ol's own layer does on this machine (driver differences against the CI
machine that made `expected.png`).

The two text cases are compared with ol's `WebGLVector` rendered on the same
machine instead, and match it pixel for pixel. Their `expected.png` cannot
be reproduced elsewhere. ol's text worker only sees fonts registered inside
the worker, so upstream's `@font-face` "Ubuntu" never reaches it, and the
glyphs come from the machine's fallback font. That is why ol itself is off by
1.6–2.1% here.

**Text while panning.** `test/rendering/text.ts` pans by whole pixels and
reads the frame in the same task, so it shows the previous text image
reprojected with the overlay matrix. It must equal the previous frame shifted
by the same amount. It does, with 0 differing pixels on both backends, with
and without view rotation.

**Hit detection.** `test/rendering/picking.ts` checks 14 situations (symbol
radius, stroke width, polygon fill and holes, `hitTolerance`, filtered-out
features, rotation, panning). WebGL2 and WebGPU pass all 14. ol's
`WebGLVector` fails two by design (it ignores `hitTolerance` and returns
features hidden by a style `filter`), and is flaky right after a rebuild
because its GPU hit buffer is rendered asynchronously.

**Package.** `npm run test:dist` builds a small app against `dist/` for
production and checks in Chromium that WebGPU, WebGL2 and the runtime
WebGPU → WebGL2 fallback of `GpuVectorLayer` render (including a label),
pick, and can be exported with `drawImage` in a `rendercomplete` listener.

## Benchmark

`npm run bench` (examples/bench.html in Playwright Chromium, Intel Iris Xe
laptop GPU, D3D11, 1100×900 map, all features in view). Milliseconds, lower
is better.

**End to end per layer**

| Data set | | ol WebGLVector | WebGL2 | WebGPU |
|---|---|---|---|---|
| 1M points | ready (add layer → rendercomplete) | 982 | 1132 | 1029 |
| | frame (pan, no rebuild) | 137 | 89 | **25** |
| | pick (`forEachFeatureAtPixel`) | 0.00 | 0.09 | 0.06 |
| 200k lines | ready | 1922 | **793** | 862 |
| | frame | 424 | 46 | **37** |
| | pick | 0.00 | 0.03 | 0.04 |
| 100k polygons | ready | 1588 | 738 | **625** |
| | frame | 290 | 36 | **22** |
| | pick | 0.00 | 0.02 | 0.02 |

**Buffer generation (worker), ol's JS vs Rust/WASM**

| | ol JS | Rust/WASM |
|---|---|---|
| 1M points | 7 | 11 |
| 200k lines | 860 | **246** (3.5×) |
| 100k polygons (earcut) | 385 | **42** (9×) |
| hit index build, 1M points / 200k lines / 100k polygons | – | 167 / 52 / 26 |

What this shows:

- **Frames** are 4–13× faster than ol's layer for lines and polygons and
  5× faster for points on WebGPU, with the same shaders and buffers. The
  gap is in how frames are drawn (ol renders into an offscreen framebuffer
  and copies it, among other things); it has not been profiled further.
- **Time to first render** halves for lines and polygons, where the
  tessellation is Rust's. For points it is on par: there the time goes into
  ol's main-thread steps (`MixedGeometryBatch` ≈ 0.4 s and render
  instructions ≈ 0.12 s for 1M points), which this package reuses and which
  cannot move to WASM while the input is `ol/Feature` objects.
- **Picking** costs well under 0.1 ms, like ol's GPU readback, but works on
  WebGPU and is correct in the two cases where ol's is not. The first pick
  after a rebuild can take 1–3 ms while feature-dependent sizes are still
  being measured.
- Point buffers are a plain copy, so WASM gains nothing there.

## Limitations

- **Text** has ol's own limitations, because it is drawn by ol's text
  worker:
  - Only fonts available inside a worker can be used: system fonts, or fonts
    the worker loads itself. Web fonts from the page's `@font-face` are not
    seen (with ol's `WebGLVector` neither).
  - Labels are drawn at CSS-pixel resolution, ignoring `pixelRatio`, and for
    the central world copy only.
  - Labels are not hit-detectable.
  - Labels appear one worker round-trip after the geometries.
- Depends on non-API ol modules (`ol/render/webgl/*`, `ol/expr/*`), so the
  peer dependency is pinned to ol 10.11.x; the golden and rendering tests
  catch breaking changes when upgrading.
- `antialias: true` gives smoother edges than ol (which draws into a
  non-multisampled framebuffer); the default `false` matches ol exactly.
- Map export (`drawImage` of the layer canvas in `rendercomplete`, as in
  ol's export examples) needs `preserveDrawingBuffer` (default `true`). On
  WebGPU this draws the last frame once more on `rendercomplete`; set it to
  `false` to skip that if you never export.
- Like ol's WebGL layers, consecutive layers of the same backend with the
  same `className` (and the same `antialias` and `preserveDrawingBuffer`)
  share one canvas; any other layer in between starts a new one. Give a layer
  its own `className` if it needs its own canvas (e.g. for CSS). Browsers
  keep only about 16 WebGL contexts per page, so a canvas per layer would
  lose layers on maps with many of them. Layers with an opacity below 1 or
  with labels are drawn into an offscreen image first and composited with
  the layer opacity, as ol does.
- WebGPU layers record their frames into one shared command encoder that is
  submitted once per map frame (on the map's `postcompose`), so reading a
  layer canvas in the same task after `renderSync()` works as with WebGL.
- Hit detection is geometric: dash gaps and transparent icon pixels still
  count as hits. When symbol or stroke sizes depend on feature properties,
  the largest size is measured in idle time after each rebuild; until then
  (and for sizes that change with `time`) picks search a 128 px radius,
  which is correct but slower on dense data.
- Vite apps: if the dev server's dependency pre-bundling breaks the wasm
  URLs, add `optimizeDeps: {exclude: ['ol-webgpu']}`.
- The naga shader translator is ~1.3 MB of wasm (loaded once, only by the
  WebGPU layer).

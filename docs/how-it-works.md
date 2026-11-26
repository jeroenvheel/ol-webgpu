# How it works

```
ol/source/Vector ──► FeatureBatch ──────► render instructions      (main thread)
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
- **Adding features.** ol's `MixedGeometryBatch` keeps an entry per feature
  and geometry kind, with a copy of the coordinates of every line and ring.
  The layer's own batch (`src/render/batch.ts`) keeps a few numbers per
  feature in typed arrays and reads the coordinates from the geometries when
  instructions are made: for 300 000 points, 200 000 lines and 50 000
  polygons it holds about 40 MB where ol's entries were 160 MB. What ol's
  batch holds is only made for ol's own instruction generators, which are
  used with `text: 'canvas'`. `test/unit/batch.test.ts` checks that it gives
  what ol's batch holds.
- **Drawn before it can be picked.** The worker sends the buffers of a build
  first and the hit index after them, and a WebGPU layer builds while its
  device is being requested. The first frame of a big layer comes that much
  sooner (the index of a million points takes about 0.15 s); until the index
  is in, hits come from the index of the build before, or there are none
  after the first build. `renderer.isPickingReady(frameState)` tells.
- **The first WebGPU layer of a page.** The first device of a page takes the
  browser 150 to 200 ms, and compiling the shaders of a style over 100 ms. A
  layer asks for the device when it is made and has its shaders compiled as
  soon as the device is there, so both run while the features are loaded and
  the buffers are built. A page that makes its layers late can call
  `prepareWebGPU()` when it starts.
- **Text properties are not shader attributes.** ol compiles `text-*`
  properties into attributes for its text worker, and gives every text a
  number in a table that is never emptied. With labels on the GPU (the
  default) the layer leaves them out: less in the buffers, and texts that
  change do not add up. With `text: 'canvas'` they are there, as in ol.
- **CPU hit detection.** WebGPU readback is asynchronous, but OpenLayers asks
  for hits synchronously, so picking uses a spatial index (built in Rust in the
  worker, queried by a main-thread wasm instance) plus the style's filter,
  symbol size and place (displacement, `icon-anchor`, rotation), stroke width
  and `stroke-offset`, and fill, evaluated with ol's CPU expression
  evaluator. Unlike ol's GPU picking it honours `hitTolerance`, respects
  `filter`, and can return all features under the cursor.
- **Text on the GPU.** See [Labels](labels.md). With `text: 'canvas'`,
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
- **Instructions in slices.** The render instructions of a build are made
  on the main thread, 6 ms at a time with a turn for the page in between, so
  a change in a layer of a million features costs no frame.
- **Workers.** One worker builds the buffers of all layers of the page. When
  it has a lot to do (4 MB of instructions or more are waiting) a second one
  starts, so a big layer does not hold up the others; it stops again after
  10 seconds without builds. With five layers of 120 000 lines in a
  production build, the second worker makes the first load 14% shorter on
  WebGL2 (690 against 593 ms) and changes nothing on WebGPU (580 against
  571 ms); building all five again is 30% shorter on both (335 against
  235 ms).
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

[Back to the README](../README.md)

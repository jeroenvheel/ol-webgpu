# Tests

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

[Back to the README](../README.md)

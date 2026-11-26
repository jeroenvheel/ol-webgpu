# Limitations

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
  - Symbols are only decluttered when their style says so (`circle-`,
    `shape-` or `icon-declutter-mode`, see [Labels](labels.md)). ol's Canvas
    layer declutters point symbols by default, together with their labels;
    here a symbol without such a mode is always drawn and does not take
    space (`examples/labels-compare.html` shows the difference).
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

[Back to the README](../README.md)

# Labels

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
  Text along a line that is kept upright has its glyphs for both directions
  once the view has turned, so it is upright in every frame of a view that
  turns. Until the view turns for the first time the second direction is
  left out (it is half as much again to lay out: 475 against 840 ms for
  20 000 labels); the layout that adds it takes a few frames, in which a
  label that has to turn around is still as it was. A label that is
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
  labels fade in and out (150 ms; the shader makes the fade from one number
  per glyph, written when the label changes sides). All labels are measured, but only those
  that can win a place get glyphs.
  A symbol (circle, shape or icon) of a point takes part when its style has
  `circle-`, `shape-` or `icon-declutter-mode` set to `'declutter'` or
  `'obstacle'`: it takes space, a symbol that has no place is not drawn
  and not hit, and a symbol and its label are drawn together or not at all.
  A symbol that loses or wins its place fades out or in, as a label does.
  An icon takes the space of its box as it is turned (by its rotation, and
  by the view when it turns with it), a circle or a shape that of its
  radius.
  Without such a mode symbols are always drawn (in ol's Canvas layers
  `'declutter'` is the default).
- **Long labels.** `'text-max-width'` in a text style (CSS pixels, a number or
  an expression; not a property of ol) breaks a label at spaces so that no
  line is wider, also in a text in parts with fonts of their own (parts
  that touch without a space stay together). Not for text along a line.
- **Hit detection.** A shown label is hit within its box (with
  `hitTolerance`), before the geometries below it.

Compared with ol's Canvas vector layer (`ol/layer/Vector`), upright text is
the same pixel for pixel, also with decluttering; see [Tests](tests.md).
`examples/labels-compare.html` shows the Canvas layer, ol's `WebGLVector`
and both ol-webgpu layers side by side with one source and style.

[Back to the README](../README.md)

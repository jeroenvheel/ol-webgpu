/**
 * Loads one synced upstream case (`?case=name&layer=...`) and exposes
 * `window.__olgpuSettled()` so the runner can wait until ol-webgpu renderers
 * have built their buffers and drawn them.
 */
import 'ol/ol.css';
import {liveRenderers} from '../../src/renderer/BaseGpuVectorRenderer.js';

const params = new URLSearchParams(location.search);
const name = params.get('case');

(window as any).__olgpuSettled = () => [...liveRenderers].every((r) => r.ready && r.framesSinceReady >= 1);

if (!(window as any).render) {
  // opened manually in a browser: no runner
  (window as any).render = (opts: unknown) => console.log('render()', opts);
}

const cases = import.meta.glob('./cases/*/main.js');
const load = cases[`./cases/${name}/main.js`];
if (!load) {
  document.body.textContent = `unknown case ${name}`;
} else {
  load().catch((e) => {
    console.error(e);
    (window as any).render({error: String(e?.stack ?? e)});
  });
}

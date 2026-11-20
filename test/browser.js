// Chromium launch flags shared by the browser runners (rendering tests,
// dist smoke test, benchmark), per platform.
//
// - Windows: the real GPU through ANGLE/D3D11. Playwright's bundled Chromium
//   lacks dxcompiler.dll, so Dawn must fall back to FXC (`use_dxc` off)
//   unless an installed browser is used (`channel`).
// - Linux CI (no GPU): SwiftShader for WebGL, and for WebGPU through Vulkan.
// - Elsewhere: the defaults.
//
// Set OLWEBGPU_SOFTWARE=1 to force the software setup on Linux outside CI.
import {chromium} from 'playwright';

export function chromiumArgs({channel} = {}) {
  const args = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  if (process.platform === 'win32') {
    args.push('--enable-gpu', '--use-angle=d3d11');
    if (!channel) {
      args.push('--disable-dawn-features=use_dxc');
    }
  } else if (process.platform === 'linux' && (process.env.CI || process.env.OLWEBGPU_SOFTWARE)) {
    args.push(
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader',
      '--disable-vulkan-surface',
    );
  }
  return args;
}

export function launchChromium({channel, headed, extraArgs = []} = {}) {
  return chromium.launch({
    headless: !headed,
    channel,
    args: [...chromiumArgs({channel}), ...extraArgs],
  });
}

/** Describes the GPU setup of a page: WebGL renderer and whether a WebGPU adapter exists. */
export async function gpuInfo(page) {
  return page.evaluate(async () => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const webgl = gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null;
    let webgpu = null;
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter) {
        const info = adapter.info ?? {};
        webgpu = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'available';
      }
    } catch {
      // no adapter
    }
    return {webgl, webgpu};
  });
}

import type { OfficeImageHost } from '@formfeed/engine';

/** The part of `@resvg/resvg-js` the host uses. */
interface ResvgModule {
  Resvg: new (
    svg: Buffer,
    options: { fitTo: { mode: 'width'; value: number } | { mode: 'original' }; font: { loadSystemFonts: boolean }; background: string },
  ) => { render(): { asPng(): Buffer } };
}

/** Loads the optional rasteriser once; `null` when it is not installed next to the CLI. */
let resvg: Promise<ResvgModule | null> | null = null;
const loadResvg = (): Promise<ResvgModule | null> =>
  (resvg ??= import('@resvg/resvg-js').then(
    (m) => ((m as { default?: ResvgModule }).default ?? m) as ResvgModule,
    () => null,
  ));

export const RESVG_MISSING = 'codes and SVG pictures are drawn by the optional package @resvg/resvg-js, which is not installed (npm install -g @resvg/resvg-js)';

/**
 * Pictures and codes of Word and PowerPoint templates filled on this machine (spec 22 §4.4): images
 * are fetched with `fetch`, SVG (every code) is drawn by resvg as on the render-worker, with the same
 * options. The worker draws WebP, GIF and AVIF with Chromium, which the CLI does not have; those, and
 * codes without resvg, become the engine's warnings.
 */
export function cliImageHost(fetchImpl: typeof fetch = globalThis.fetch): OfficeImageHost {
  return {
    async fetch(url) {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
    },
    async toPng(input, size) {
      if (!input.contentType.includes('svg')) throw new Error(`${input.contentType} pictures are drawn only by the API; use PNG, JPEG or SVG`);
      const module = await loadResvg();
      if (!module) throw new Error(RESVG_MISSING);
      const png = new module.Resvg(Buffer.from(input.bytes), {
        fitTo: size ? { mode: 'width', value: size.width } : { mode: 'original' },
        font: { loadSystemFonts: false },
        background: 'rgba(0, 0, 0, 0)',
      })
        .render()
        .asPng();
      return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
    },
  };
}

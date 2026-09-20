import { create as createQr } from 'qrcode';
import { render as renderQrSvg } from 'qrcode/lib/renderer/svg-tag.js';

/** QR rendering, without the barcode symbologies `helpers/codes.ts` also registers. */
export interface QrOptions {
  size?: number;
  ecc?: 'L' | 'M' | 'Q' | 'H';
  margin?: number;
  color?: string;
  background?: string;
}

export function qrSvg(value: string, options: QrOptions = {}): string {
  const qr = createQr(value, { errorCorrectionLevel: options.ecc ?? 'M' });
  return renderQrSvg(qr, {
    width: options.size ?? 160,
    margin: options.margin ?? 1,
    color: {
      dark: (options.color ?? '#000000').replace(/^(#?)/, '#').slice(0, 9),
      light: (options.background ?? '#ffffff').replace(/^(#?)/, '#'),
    },
  });
}

/** An SVG as the `src` of an `<img>`, which is how the helpers put a code into a document. */
export const svgDataUri = (svg: string): string => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

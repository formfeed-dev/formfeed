import {
  DESIGN_VERSION,
  type CanvasSize,
  type DesignDocument,
  type DesignLayer,
  type ImageSource,
  type LayerType,
  type TextLayer,
} from './types';

/**
 * An image layer whose image is not chosen yet: an empty file name, URL or data path. A new layer
 * starts that way; the emitter writes an empty box for it and the editor asks for an image.
 */
export function imageIsEmpty(source: ImageSource): boolean {
  if ('url' in source) return source.url === '';
  if ('asset' in source) return source.asset === '';
  if ('path' in source) return source.path === '';
  return false;
}

/** A design with nothing on it but a white canvas. */
export function emptyDesign(): DesignDocument {
  return {
    version: DESIGN_VERSION,
    output: '',
    background: { color: '#ffffff' },
    layers: [],
  };
}

/** The next free id for a layer of `type`: `text-1`, `text-2`, … */
export function nextLayerId(design: DesignDocument, type: LayerType): string {
  const taken = new Set(design.layers.map((layer) => layer.id));
  for (let n = 1; ; n++) {
    const id = `${type}-${n}`;
    if (!taken.has(id)) return id;
  }
}

const baseText: Omit<
  TextLayer,
  'id' | 'name' | 'x' | 'y' | 'width' | 'height'
> = {
  type: 'text',
  rotation: 0,
  opacity: 1,
  visible: true,
  content: [{ text: 'Text' }],
  style: {
    font: { family: 'Inter', source: 'google' },
    // regular: the editor's Bold is a toggle, and a new text that was already bold confused it
    weight: 400,
    size: 48,
    lineHeight: 1.2,
    letterSpacing: 0,
    color: { color: '#111827' },
    align: 'left',
  },
  sizing: 'fixed',
  valign: 'top',
};

/** A new layer of `type` in the middle of the canvas, sized for it. */
export function defaultLayer(
  type: LayerType,
  id: string,
  name: string,
  canvas: CanvasSize,
): DesignLayer {
  const centred = (width: number, height: number) => ({
    x: Math.round((canvas.width - width) / 2),
    y: Math.round((canvas.height - height) / 2),
    width,
    height,
  });
  const common = { id, name, rotation: 0, opacity: 1, visible: true };
  switch (type) {
    case 'text':
      return {
        ...baseText,
        ...common,
        ...centred(Math.min(canvas.width - 80, 600), 80),
      };
    case 'image':
      return {
        ...common,
        type: 'image',
        ...centred(Math.min(canvas.width, 400), Math.min(canvas.height, 300)),
        // not chosen yet (`imageIsEmpty`), and the file library first: that is where an upload goes
        source: { asset: '' },
        fit: 'cover',
      };
    case 'shape':
      return {
        ...common,
        type: 'shape',
        ...centred(240, 160),
        shape: 'rectangle',
        fill: { color: '#e5e7eb' },
      };
    case 'qr':
      return {
        ...common,
        type: 'qr',
        ...centred(240, 240),
        value: { text: 'https://example.test' },
        ecc: 'M',
        color: { color: '#000000' },
        background: { color: '#ffffff' },
      };
    case 'barcode':
      return {
        ...common,
        type: 'barcode',
        ...centred(400, 140),
        value: { text: '4006381333931' },
        symbology: 'ean13',
        showText: true,
      };
  }
}

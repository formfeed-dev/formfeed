import {
  DESIGN_VERSION,
  type BarcodeSymbology,
  type Binding,
  type DesignDocument,
  type DesignLayer,
  type FontChoice,
  type ImageSource,
  type LayerBase,
  type Paint,
  type Shadow,
  type Stroke,
  type TextFormat,
  type TextItem,
  type TextStyle,
} from './types';

/**
 * Reads a design as it arrives from `settings.design`: from the editor, but also from the API or a
 * pushed `design.json`, so nothing is trusted. Every value is checked, numbers are clamped to sane
 * ranges, and a problem names where it is; a design with problems is not half loaded (the editor opens
 * the template as code and says so).
 */

export const DESIGN_LIMITS = {
  layers: 200,
  textPerLayer: 5000,
  bytes: 256 * 1024,
} as const;

export type ParsedDesign =
  | { design: DesignDocument; problems: [] }
  | { design: null; problems: string[] };

export const layerIdPattern = /^[a-z][a-z0-9-]{0,31}$/;
/** A data path the emitter writes as is in every engine: dotted identifiers. */
export const dataPathPattern = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const colourPattern = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const tokenPattern = /^[a-z][a-z0-9-]{0,31}$/;
const symbologies: BarcodeSymbology[] = [
  'code128',
  'ean13',
  'ean8',
  'upca',
  'itf14',
  'code39',
];

type Record_ = Record<string, unknown>;

class Reader {
  readonly problems: string[] = [];

  constructor(private readonly at: string) {}

  problem(message: string): void {
    this.problems.push(`${this.at}: ${message}`);
  }

  number(
    value: unknown,
    name: string,
    min: number,
    max: number,
    fallback?: number,
  ): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      if (fallback !== undefined && value === undefined) return fallback;
      this.problem(`${name} must be a number`);
      return fallback ?? min;
    }
    return Math.min(max, Math.max(min, value));
  }

  string(value: unknown, name: string, max: number, pattern?: RegExp): string {
    if (
      typeof value !== 'string' ||
      value.length > max ||
      (pattern && !pattern.test(value))
    ) {
      this.problem(`${name} is not valid`);
      return '';
    }
    return value;
  }

  oneOf<T extends string>(
    value: unknown,
    name: string,
    options: readonly T[],
    fallback?: T,
  ): T {
    if (value === undefined && fallback !== undefined) return fallback;
    if (
      typeof value === 'string' &&
      (options as readonly string[]).includes(value)
    )
      return value as T;
    this.problem(`${name} must be one of ${options.join(', ')}`);
    return options[0] as T;
  }

  bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
  }

  paint(value: unknown, name: string): Paint {
    const v = value as Record_ | null;
    if (v && typeof v['color'] === 'string' && colourPattern.test(v['color']))
      return { color: v['color'] };
    if (
      v &&
      typeof v['brand'] === 'string' &&
      tokenPattern.test(v['brand']) &&
      typeof v['fallback'] === 'string' &&
      colourPattern.test(v['fallback'])
    )
      return { brand: v['brand'], fallback: v['fallback'] };
    this.problem(`${name} is not a colour`);
    return { color: '#000000' };
  }

  paintOrNull(value: unknown, name: string): Paint | null {
    return value === null || value === undefined
      ? null
      : this.paint(value, name);
  }

  path(value: unknown, name: string): string {
    return this.string(value, name, 200, dataPathPattern);
  }
}

/** A design's size as the gateway bounds it: the UTF-8 bytes of its JSON. */
export function designBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

export function parseDesign(value: unknown): ParsedDesign {
  const root = new Reader('design');
  const v = value as Record_ | null;
  if (!v || typeof v !== 'object' || Array.isArray(v))
    return { design: null, problems: ['design: not an object'] };
  if (designBytes(v) > DESIGN_LIMITS.bytes)
    return {
      design: null,
      problems: [`design: larger than ${DESIGN_LIMITS.bytes / 1024} kB`],
    };
  if (v['version'] !== DESIGN_VERSION)
    root.problem(`version must be ${DESIGN_VERSION}`);
  const output =
    typeof v['output'] === 'string' ? v['output'].slice(0, 64) : '';
  const background = root.paintOrNull(v['background'], 'background');
  const rawLayers = Array.isArray(v['layers'])
    ? (v['layers'] as unknown[])
    : null;
  if (!rawLayers) root.problem('layers must be a list');
  if (rawLayers && rawLayers.length > DESIGN_LIMITS.layers)
    root.problem(`at most ${DESIGN_LIMITS.layers} layers`);
  const problems = [...root.problems];
  const layers: DesignLayer[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of (rawLayers ?? [])
    .slice(0, DESIGN_LIMITS.layers)
    .entries()) {
    const id = (raw as Record_ | null)?.['id'];
    const reader = new Reader(
      `layer ${typeof id === 'string' ? id : index + 1}`,
    );
    const layer = readLayer(reader, raw);
    if (layer && ids.has(layer.id)) reader.problem('id is used twice');
    if (layer) ids.add(layer.id);
    problems.push(...reader.problems);
    if (layer) layers.push(layer);
  }
  let guides: DesignDocument['guides'];
  const g = v['guides'] as Record_ | null | undefined;
  if (g && typeof g === 'object') {
    const list = (x: unknown) =>
      (Array.isArray(x) ? x : [])
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        .slice(0, 100);
    guides = { x: list(g['x']), y: list(g['y']) };
  }
  if (problems.length) return { design: null, problems };
  return {
    design: {
      version: DESIGN_VERSION,
      output,
      background,
      layers,
      ...(guides ? { guides } : {}),
    },
    problems: [],
  };
}

function readLayer(r: Reader, raw: unknown): DesignLayer | null {
  const v = raw as Record_ | null;
  if (!v || typeof v !== 'object') {
    r.problem('not an object');
    return null;
  }
  const base: LayerBase = {
    id: r.string(v['id'], 'id', 32, layerIdPattern),
    name:
      typeof v['name'] === 'string' && v['name'].trim()
        ? v['name'].slice(0, 100)
        : String(v['id'] ?? ''),
    x: r.number(v['x'], 'x', -10000, 10000),
    y: r.number(v['y'], 'y', -10000, 10000),
    width: r.number(v['width'], 'width', 1, 10000),
    height: r.number(v['height'], 'height', 1, 10000),
    rotation: r.number(v['rotation'], 'rotation', -360, 360, 0),
    opacity: r.number(v['opacity'], 'opacity', 0, 1, 1),
    visible: r.bool(v['visible'], true),
    ...(v['locked'] === true ? { locked: true } : {}),
  };
  const showWhen = v['showWhen'] as Record_ | null | undefined;
  if (showWhen) base.showWhen = { path: r.path(showWhen['path'], 'showWhen') };
  if (v['radius'] !== undefined)
    base.radius = r.number(v['radius'], 'radius', 0, 5000);
  if (v['shadow']) base.shadow = readShadow(r, v['shadow']);
  if (v['stroke']) base.stroke = readStroke(r, v['stroke']);

  switch (v['type']) {
    case 'text': {
      const style = readStyle(r, v['style']);
      const layer: DesignLayer = {
        ...base,
        type: 'text',
        content: readContent(r, v['content']),
        style,
        sizing: r.oneOf(
          v['sizing'],
          'sizing',
          ['fixed', 'shrink', 'grow'] as const,
          'fixed',
        ),
        valign: r.oneOf(
          v['valign'],
          'valign',
          ['top', 'middle', 'bottom'] as const,
          'top',
        ),
      };
      if (v['minFontSize'] !== undefined)
        layer.minFontSize = r.number(
          v['minFontSize'],
          'minFontSize',
          1,
          style.size,
        );
      if (v['maxLines'] !== undefined)
        layer.maxLines = Math.round(
          r.number(v['maxLines'], 'maxLines', 1, 100),
        );
      if (v['fill'] !== undefined)
        layer.fill = r.paintOrNull(v['fill'], 'fill');
      if (v['padding'] !== undefined)
        layer.padding = r.number(v['padding'], 'padding', 0, 1000);
      return layer;
    }
    case 'image': {
      const layer: DesignLayer = {
        ...base,
        type: 'image',
        source: readImageSource(r, v['source']),
        fit: r.oneOf(
          v['fit'],
          'fit',
          ['cover', 'contain', 'fill'] as const,
          'cover',
        ),
      };
      const focus = v['focus'] as Record_ | undefined;
      if (focus)
        layer.focus = {
          x: r.number(focus['x'], 'focus', 0, 100),
          y: r.number(focus['y'], 'focus', 0, 100),
        };
      return layer;
    }
    case 'shape':
      return {
        ...base,
        type: 'shape',
        shape: r.oneOf(v['shape'], 'shape', [
          'rectangle',
          'ellipse',
          'line',
        ] as const),
        fill: r.paintOrNull(v['fill'], 'fill'),
      };
    case 'qr':
      return {
        ...base,
        type: 'qr',
        value: readBinding(r, v['value']),
        ecc: r.oneOf(v['ecc'], 'ecc', ['L', 'M', 'Q', 'H'] as const, 'M'),
        color: r.paint(v['color'] ?? { color: '#000000' }, 'color'),
        background: r.paintOrNull(v['background'], 'background'),
      };
    case 'barcode':
      return {
        ...base,
        type: 'barcode',
        value: readBinding(r, v['value']),
        symbology: r.oneOf(v['symbology'], 'symbology', symbologies, 'code128'),
        showText: r.bool(v['showText'], true),
      };
    default:
      r.problem('unknown layer type');
      return null;
  }
}

function readShadow(r: Reader, raw: unknown): Shadow {
  const v = (raw ?? {}) as Record_;
  const color =
    r.string(v['color'], 'shadow colour', 9, colourPattern) || '#00000040';
  return {
    x: r.number(v['x'], 'shadow x', -500, 500, 0),
    y: r.number(v['y'], 'shadow y', -500, 500, 0),
    blur: r.number(v['blur'], 'shadow blur', 0, 500, 0),
    color,
  };
}

function readStroke(r: Reader, raw: unknown): Stroke {
  const v = (raw ?? {}) as Record_;
  return {
    width: r.number(v['width'], 'stroke width', 0, 200),
    paint: r.paint(v['paint'], 'stroke colour'),
  };
}

function readStyle(r: Reader, raw: unknown): TextStyle {
  const v = (raw ?? {}) as Record_;
  const style: TextStyle = {
    font: readFont(r, v['font']),
    weight:
      Math.round(r.number(v['weight'], 'weight', 100, 900, 400) / 100) * 100,
    size: r.number(v['size'], 'size', 1, 2000),
    lineHeight: r.number(v['lineHeight'], 'lineHeight', 0.5, 5, 1.2),
    letterSpacing: r.number(v['letterSpacing'], 'letterSpacing', -50, 200, 0),
    color: r.paint(v['color'], 'colour'),
    align: r.oneOf(
      v['align'],
      'align',
      ['left', 'center', 'right', 'justify'] as const,
      'left',
    ),
  };
  if (v['italic'] === true) style.italic = true;
  if (v['uppercase'] === true) style.uppercase = true;
  if (v['underline'] === true) style.underline = true;
  return style;
}

function readFont(r: Reader, raw: unknown): FontChoice {
  const v = (raw ?? {}) as Record_;
  if (v['brand'] === 'heading' || v['brand'] === 'body')
    return { brand: v['brand'] };
  const family = r.string(v['family'], 'font', 100, /^[^"'\\<>\n\r;{}]+$/);
  return {
    family,
    source: r.oneOf(
      v['source'],
      'font source',
      ['google', 'organisation', 'system'] as const,
      'system',
    ),
  };
}

function readContent(r: Reader, raw: unknown): TextItem[] {
  if (!Array.isArray(raw)) {
    r.problem('content must be a list');
    return [];
  }
  let length = 0;
  const items: TextItem[] = [];
  for (const item of raw as Record_[]) {
    if (item && typeof item['text'] === 'string') {
      length += item['text'].length;
      items.push({ text: item['text'] });
    } else if (item && item['break'] === true) items.push({ break: true });
    else if (item && typeof item['path'] === 'string') {
      const path = r.path(item['path'], 'content path');
      const format =
        item['format'] === undefined
          ? undefined
          : readFormat(r, item['format']);
      items.push(format ? { path, format } : { path });
    } else
      r.problem('content holds something that is not text, a path or a break');
  }
  if (length > 5000) r.problem('at most 5000 characters of text');
  return items;
}

function readFormat(r: Reader, raw: unknown): TextFormat | undefined {
  const v = (raw ?? {}) as Record_;
  switch (v['helper']) {
    case 'upper':
    case 'lower':
    case 'title':
    case 'money':
      return { helper: v['helper'] };
    case 'number':
      return {
        helper: 'number',
        decimals: Math.round(r.number(v['decimals'], 'decimals', 0, 10, 2)),
      };
    case 'date':
      return {
        helper: 'date',
        pattern: r.string(v['pattern'], 'date pattern', 64, /^[^{}\n\r]+$/),
      };
    case 'truncate':
      return {
        helper: 'truncate',
        length: Math.round(r.number(v['length'], 'length', 1, 5000)),
      };
    case 'default':
      return {
        helper: 'default',
        value: r.string(v['value'], 'default value', 500, /^[^{}\n\r]*$/),
      };
    default:
      r.problem('unknown format');
      return undefined;
  }
}

function readImageSource(r: Reader, raw: unknown): ImageSource {
  const v = (raw ?? {}) as Record_;
  if (typeof v['url'] === 'string')
    return {
      url: r.string(v['url'], 'image url', 2000, /^https?:\/\/[^\s"'<>]+$/),
    };
  // an apostrophe is fine (`stringLiteral` quotes around it); a double quote would leave Liquid no quote
  if (typeof v['asset'] === 'string')
    return {
      asset: r.string(v['asset'], 'file name', 200, /^[^"\\<>\n\r{}]+$/),
    };
  if (typeof v['path'] === 'string')
    return { path: r.path(v['path'], 'image path') };
  if (v['brandLogo'] !== undefined)
    return {
      brandLogo: r.oneOf(v['brandLogo'], 'brand logo', [
        'primary',
        'inverse',
        'mark',
      ] as const),
    };
  r.problem('the image has no source');
  return { url: '' };
}

function readBinding(r: Reader, raw: unknown): Binding {
  const v = (raw ?? {}) as Record_;
  if (typeof v['path'] === 'string')
    return { path: r.path(v['path'], 'value path') };
  // no braces: LiquidJS may end an output tag at a `}}` inside a string literal
  if (typeof v['text'] === 'string')
    return { text: r.string(v['text'], 'value', 2000, /^[^\n\r{}]*$/) };
  r.problem('the code has no value');
  return { text: '' };
}

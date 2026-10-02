import { filterCall, helperCall, ifBlock, stringLiteral } from '../dialect';
import { encodeTemplateText } from '../source-edit';
import type { EngineId } from '../types';
import {
  genericFamily,
  googleFont,
  googleFontsUrl,
  nearestWeight,
} from './fonts';
import { designOutputHash } from './hash';
import { imageIsEmpty } from './layers';
import type {
  Binding,
  CanvasSize,
  DesignDocument,
  DesignLayer,
  FontChoice,
  ImageSource,
  Paint,
  TextFormat,
  TextItem,
  TextLayer,
} from './types';

/**
 * A design as the template it stands for (plan 16 §4.2): the body and the CSS in the template's
 * engine, deterministic, so the output hashes and diffs stably. Structure goes into the HTML (one
 * line per layer) and presentation into the CSS, so moving or restyling a layer changes only the
 * stylesheet. Values that reach CSS were checked by `parseDesign` and are checked again here.
 */
export interface EmittedDesign {
  html: string;
  css: string;
  /** Each layer's line range (1-based, inclusive) in `html`, to show a diagnostic on its layer. */
  map: Record<string, { start: number; end: number }>;
  /** `designOutputHash(html, css)`: what the design records as `output`. */
  output: string;
}

const colourPattern = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const tokenPattern = /^[a-z][a-z0-9-]{0,31}$/;

export function emitDesign(
  design: DesignDocument,
  engine: EngineId,
  size: CanvasSize,
): EmittedDesign {
  const lines = ['<div class="ff-design">'];
  const map: EmittedDesign['map'] = {};
  const rules: string[] = [];
  for (const layer of design.layers) {
    if (!layer.visible) continue;
    const markup = layerHtml(layer, engine);
    lines.push(
      `  ${layer.showWhen?.path ? ifBlock(engine, layer.showWhen.path, markup) : markup}`,
    );
    map[layer.id] = { start: lines.length, end: lines.length };
    rules.push(...layerCss(layer));
  }
  lines.push('</div>');
  const html = `${lines.join('\n')}\n`;

  const fonts = googleFontsUrl(
    design.layers
      .filter(
        (l): l is TextLayer =>
          l.visible &&
          l.type === 'text' &&
          'family' in l.style.font &&
          l.style.font.source === 'google',
      )
      .map((l) => ({
        family: (l.style.font as { family: string }).family,
        weight: l.style.weight,
        italic: l.style.italic === true,
      })),
  );
  const head = [
    ...(fonts ? [`@import url("${fonts}");`] : []),
    `.ff-design { ${decl({
      position: 'relative',
      width: px(size.width),
      height: px(size.height),
      overflow: 'hidden',
      background: design.background ? paint(design.background) : undefined,
    })} }`,
    '.ff-layer { position: absolute; box-sizing: border-box; margin: 0; }',
  ];
  const css = `${[...head, ...rules].join('\n')}\n`;
  return { html, css, map, output: designOutputHash(html, css) };
}

// --- markup -------------------------------------------------------------------------------------

function open(layer: DesignLayer, tag: string, extra = ''): string {
  return `<${tag} class="ff-layer l-${layer.id}" data-ff-layer="${layer.id}"${extra}`;
}

function layerHtml(layer: DesignLayer, engine: EngineId): string {
  switch (layer.type) {
    case 'text': {
      const fit =
        layer.sizing === 'shrink'
          ? ` data-ff-fit="shrink" data-ff-fit-min="${num(layer.minFontSize ?? Math.max(8, Math.round(layer.style.size / 3)))}"`
          : '';
      return `${open(layer, 'div', fit)}><p class="ff-text">${textHtml(layer.content, engine)}</p></div>`;
    }
    case 'image':
      // not chosen yet: an empty box, so nothing is requested and no engine meets an empty expression
      if (imageIsEmpty(layer.source)) return `${open(layer, 'div')}></div>`;
      return `${open(layer, 'img', ` src="${imageSource(layer.source, engine)}" alt=""`)}>`;
    case 'shape':
      return `${open(layer, 'div')}></div>`;
    case 'qr':
      return `${open(
        layer,
        'img',
        ` src="${helperCall(engine, 'qrcode', binding(layer.value, engine), {
          ecc: stringLiteral(engine, layer.ecc),
          margin: '0',
          color: stringLiteral(engine, literalColour(layer.color)),
          background: stringLiteral(
            engine,
            layer.background ? literalColour(layer.background) : '#ffffff00',
          ),
        })}" alt=""`,
      )}>`;
    case 'barcode':
      return `${open(
        layer,
        'img',
        ` src="${helperCall(engine, 'barcode', binding(layer.value, engine), {
          type: stringLiteral(engine, layer.symbology),
          text: layer.showText ? 'true' : 'false',
        })}" alt=""`,
      )}>`;
  }
}

function textHtml(items: TextItem[], engine: EngineId): string {
  return items
    .map((item) => {
      if ('break' in item) return '<br>';
      if ('text' in item)
        return encodeTemplateText(item.text.replace(/[\r\n]+/g, ' '));
      return valueHtml(item.path, item.format, engine);
    })
    .join('');
}

function valueHtml(
  path: string,
  format: TextFormat | undefined,
  engine: EngineId,
): string {
  if (!format) return `{{ ${path} }}`;
  switch (format.helper) {
    case 'upper':
    case 'lower':
    case 'title':
    case 'money':
      return filterCall(engine, path, format.helper);
    case 'number':
      return filterCall(engine, path, 'number', [String(format.decimals)]);
    case 'date':
      return filterCall(engine, path, 'date', [
        stringLiteral(engine, format.pattern),
      ]);
    case 'truncate':
      return filterCall(engine, path, 'truncate', [String(format.length)]);
    case 'default':
      return filterCall(engine, path, 'default', [
        stringLiteral(engine, format.value),
      ]);
  }
}

function binding(value: Binding, engine: EngineId): string {
  return 'path' in value ? value.path : stringLiteral(engine, value.text);
}

function imageSource(source: ImageSource, engine: EngineId): string {
  if ('url' in source) return escapeAttribute(source.url);
  if ('asset' in source)
    return helperCall(engine, 'asset', stringLiteral(engine, source.asset));
  if ('path' in source) return `{{ ${source.path} }}`;
  return `{{ brand.logo.${source.brandLogo} }}`;
}

// --- styles -------------------------------------------------------------------------------------

function layerCss(layer: DesignLayer): string[] {
  const text = layer.type === 'text' ? layer : null;
  const box: Record<string, string | undefined> = {
    left: px(layer.x),
    top: px(layer.y),
    width: px(layer.width),
    height: text?.sizing === 'grow' ? undefined : px(layer.height),
    opacity: layer.opacity < 1 ? num(layer.opacity) : undefined,
    transform: layer.rotation ? `rotate(${num(layer.rotation)}deg)` : undefined,
    'border-radius':
      layer.type === 'shape' && layer.shape === 'ellipse'
        ? '50%'
        : layer.radius
          ? px(layer.radius)
          : undefined,
    border:
      layer.stroke && layer.stroke.width > 0
        ? `${px(layer.stroke.width)} solid ${paint(layer.stroke.paint)}`
        : undefined,
    'box-shadow': layer.shadow && !text ? shadow(layer.shadow) : undefined,
  };
  if (text) {
    Object.assign(box, {
      display: 'flex',
      'flex-direction': 'column',
      'justify-content':
        text.valign === 'middle'
          ? 'center'
          : text.valign === 'bottom'
            ? 'flex-end'
            : 'flex-start',
      overflow: text.sizing === 'grow' ? undefined : 'hidden',
      padding: text.padding ? px(text.padding) : undefined,
      background: text.fill ? paint(text.fill) : undefined,
    });
    const s = text.style;
    const clamp = text.maxLines
      ? {
          display: '-webkit-box',
          '-webkit-box-orient': 'vertical',
          '-webkit-line-clamp': String(text.maxLines),
          overflow: 'hidden',
        }
      : {};
    const inner = decl({
      margin: '0',
      width: '100%',
      'font-family': fontFamily(s.font),
      'font-weight': String(servedWeight(s.font, s.weight)),
      'font-size': px(s.size),
      'line-height': num(s.lineHeight),
      'letter-spacing': s.letterSpacing ? px(s.letterSpacing) : undefined,
      color: paint(s.color),
      'text-align': s.align,
      'font-style': s.italic ? 'italic' : undefined,
      'text-transform': s.uppercase ? 'uppercase' : undefined,
      'text-decoration':
        [s.underline && 'underline', s.strike && 'line-through']
          .filter(Boolean)
          .join(' ') || undefined,
      'text-shadow': text.shadow ? shadow(text.shadow) : undefined,
      'overflow-wrap': 'break-word',
      ...clamp,
    });
    return [
      `.l-${layer.id} { ${decl(box)} }`,
      `.l-${layer.id} .ff-text { ${inner} }`,
    ];
  }
  if (layer.type === 'image')
    Object.assign(box, {
      display: 'block',
      'object-fit': layer.fit,
      'object-position': layer.focus
        ? `${num(layer.focus.x)}% ${num(layer.focus.y)}%`
        : undefined,
    });
  if (layer.type === 'qr' || layer.type === 'barcode')
    Object.assign(box, { display: 'block', 'object-fit': 'contain' });
  if (layer.type === 'shape')
    box['background'] = layer.fill ? paint(layer.fill) : undefined;
  return [`.l-${layer.id} { ${decl(box)} }`];
}

function decl(properties: Record<string, string | undefined>): string {
  return Object.entries(properties)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function px(n: number): string {
  const value = num(n);
  return value === '0' ? '0' : `${value}px`;
}

function safeColour(value: string): string {
  return colourPattern.test(value) ? value : '#000000';
}

function paint(p: Paint): string {
  if ('brand' in p)
    return tokenPattern.test(p.brand)
      ? `var(--brand-color-${p.brand}, ${safeColour(p.fallback)})`
      : safeColour(p.fallback);
  return safeColour(p.color);
}

/** Codes are drawn as images, so a brand colour becomes its fallback there. */
function literalColour(p: Paint): string {
  return safeColour('brand' in p ? p.fallback : p.color);
}

function shadow(s: {
  x: number;
  y: number;
  blur: number;
  color: string;
}): string {
  return `${px(s.x)} ${px(s.y)} ${px(s.blur)} ${safeColour(s.color)}`;
}

/** A Google family's weight as the stylesheet serves it, so the CSS asks for the face that is loaded. */
function servedWeight(font: FontChoice, weight: number): number {
  const google =
    'family' in font && font.source === 'google'
      ? googleFont(font.family)
      : undefined;
  return google ? nearestWeight(google, weight) : weight;
}

/** A family as CSS: quotes and anything that could leave the declaration removed, a generic fallback after it. */
function fontFamily(font: FontChoice): string {
  if ('brand' in font) return `var(--brand-font-${font.brand}, sans-serif)`;
  const family = font.family.replace(/["'\\<>\n\r;{}]/g, '');
  const generic =
    font.source === 'google' ? genericFamily(googleFont(family)) : 'sans-serif';
  return `"${family}", ${generic}`;
}

/** A URL in an attribute: escaped for HTML, braces percent-encoded so no engine reads them as syntax. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '%7B')
    .replace(/\}/g, '%7D');
}

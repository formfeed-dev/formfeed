import type { HelperDefinition } from '../types';
import { escapeHtml, toNumber } from './format';

/**
 * Document helpers that emit markup the assembler completes (spec 05 §2): `chart` places a canvas
 * that Chart.js draws inside Chromium (browser preview and render-worker alike, so both paths
 * produce the same pixels), `image` places a sized, cropped picture.
 */

export interface ChartSpec {
  type?: string;
  data?: unknown;
  options?: Record<string, unknown>;
  width?: number | string;
  height?: number | string;
}

export interface ImageOptions {
  width?: number | string;
  height?: number | string;
  fit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  alt?: string;
  class?: string;
}

const css = (value: number | string | undefined): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = toNumber(value);
  return Number.isFinite(n) && String(value).trim() === String(n)
    ? `${n}px`
    : String(value);
};

/** The chart payload the assembler's init script reads from `data-ff-chart`. */
export function chartPayload(spec: ChartSpec): {
  type: string;
  data: unknown;
  options: Record<string, unknown>;
} {
  const options = { ...(spec.options ?? {}) } as Record<string, unknown>;
  // deterministic output: no animation, no responsive resizing after layout
  options['animation'] = false;
  options['responsive'] = false;
  return { type: spec.type ?? 'bar', data: spec.data ?? {}, options };
}

export function chartMarkup(spec: ChartSpec, id?: string): string {
  const width = toNumber(spec.width ?? 480) || 480;
  const height = toNumber(spec.height ?? 240) || 240;
  const payload = escapeHtml(JSON.stringify(chartPayload(spec)));
  const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
  return `<canvas class="ff-chart"${idAttr} width="${width}" height="${height}" style="width:${width}px;height:${height}px" data-ff-chart="${payload}"></canvas>`;
}

export function imageMarkup(url: string, options: ImageOptions = {}): string {
  const styles = [
    css(options.width) ? `width:${css(options.width)}` : '',
    css(options.height) ? `height:${css(options.height)}` : '',
    options.fit ? `object-fit:${options.fit}` : '',
  ]
    .filter(Boolean)
    .join(';');
  const cls = options.class ? ` class="${escapeHtml(options.class)}"` : '';
  const style = styles ? ` style="${styles}"` : '';
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(options.alt ?? '')}"${cls}${style}>`;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const documentHelpers: HelperDefinition[] = [
  {
    name: 'chart',
    html: true,
    doc: {
      signature: 'chart({ type, data, options, width, height })',
      description:
        'Draws a Chart.js chart (bar, line, pie, doughnut, radar, …) from a chart configuration; animations are disabled so PDF and preview match.',
      example:
        "{{ chart({ type: 'bar', data: sales, width: 480, height: 240 }) }}",
      category: 'document',
    },
    fn: (_ctx, spec, extra?) =>
      chartMarkup({ ...asObject(spec), ...asObject(extra) } as ChartSpec),
  },
  {
    name: 'image',
    html: true,
    doc: {
      signature: 'image(url, { width, height, fit, alt })',
      description:
        'Places an image with fixed size and crop mode (`cover`, `contain`, `fill`); the render-worker fetches it through its cache and blocks private hosts.',
      example: "{{ image(product.photo, { width: 120, height: 80, fit: 'cover' }) }}",
      category: 'document',
    },
    fn: (_ctx, url, options?) =>
      imageMarkup(String(url ?? ''), asObject(options) as ImageOptions),
  },
];

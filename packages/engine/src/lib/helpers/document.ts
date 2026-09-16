import type { HelperDefinition } from '../types';
import { escapeHtml, toNumber } from './format';
import { officeUnsupported } from './office';

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
  /** Plain data instead of `data`: one label per point, with `values` or several `series`. */
  labels?: unknown[];
  values?: unknown[];
  /** Name of the single `values` series; without one the legend is hidden. */
  label?: string;
  /** Colour of the single series; a list colours pie and doughnut slices one by one. */
  color?: string | string[];
  series?: ChartSeries[];
}

export interface ChartSeries {
  label?: string;
  values?: unknown[];
  color?: string | string[];
}

/** Colours for series and slices that name none. */
export const CHART_PALETTE = ['#3E63DD', '#12A594', '#E5484D', '#F76B15', '#8E4EC6', '#FFC53D', '#0090FF', '#978365'];

const SLICED = new Set(['pie', 'doughnut', 'polarArea']);

const colour = (value: unknown): string | string[] | undefined =>
  typeof value === 'string' && value
    ? value
    : Array.isArray(value) && value.length
      ? value.map(String)
      : undefined;

/**
 * Chart.js `data` from plain data, so a template can chart `{ labels, values }` from a request
 * without the caller knowing Chart.js. Values become numbers (anything else a gap); a series
 * without a colour takes the next palette colour, and each slice of a pie or doughnut its own.
 */
export function chartDataFromPlain(spec: ChartSpec): { datasets: Record<string, unknown>[]; labels: unknown[] } {
  const type = spec.type ?? 'bar';
  const series: ChartSeries[] = Array.isArray(spec.series)
    ? spec.series.map((s) => asObject(s) as ChartSeries)
    : [{ label: spec.label, values: spec.values, color: spec.color }];
  const labels = Array.isArray(spec.labels) ? spec.labels : [];
  const datasets = series.map((s, index) => {
    const data = (Array.isArray(s.values) ? s.values : []).map((v) => {
      const n = toNumber(v);
      return Number.isFinite(n) ? n : null;
    });
    const own = colour(s.color);
    const fill = SLICED.has(type)
      ? (own ?? labels.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length]))
      : (own ?? CHART_PALETTE[index % CHART_PALETTE.length]);
    const dataset: Record<string, unknown> = { data, backgroundColor: fill, borderColor: fill };
    if (s.label !== undefined && s.label !== null && s.label !== '') dataset['label'] = String(s.label);
    if (type === 'line') dataset['fill'] = false;
    return dataset;
  });
  return { labels, datasets };
}

const isPlain = (spec: ChartSpec) =>
  spec.data === undefined && (Array.isArray(spec.values) || Array.isArray(spec.series));

export interface ImageOptions {
  width?: number | string;
  height?: number | string;
  fit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  alt?: string;
  class?: string;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

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
  if (!isPlain(spec)) return { type: spec.type ?? 'bar', data: spec.data ?? {}, options };
  const data = chartDataFromPlain(spec);
  // one unnamed series needs no legend, unless the options say otherwise
  const unnamed = data.datasets.length === 1 && data.datasets[0]?.['label'] === undefined;
  const plugins = asObject(options['plugins']);
  if (unnamed && !SLICED.has(spec.type ?? 'bar') && plugins['legend'] === undefined)
    options['plugins'] = { ...plugins, legend: { display: false } };
  return { type: spec.type ?? 'bar', data, options };
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

/** A relative `image()` path resolves against the workspace's file library, as `asset()` does. */
function resolveAsset(base: string | undefined, url: string): string {
  if (!base || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

export const documentHelpers: HelperDefinition[] = [
  {
    name: 'chart',
    html: true,
    doc: {
      signature:
        'chart({ type, labels, values, label, color } | { type, labels, series } | { type, data, options }, { width, height })',
      description:
        'Draws a Chart.js chart (bar, line, pie, doughnut, radar, …) from plain data, `labels` with `values` or several `series` of `{ label, values, color }`, or from a full Chart.js `data` and `options`; animations are disabled so PDF and preview match.',
      example:
        "{{ chart({ type: 'line', labels: ['Q1', 'Q2', 'Q3'], values: sales.quarters, width: 480 }) }}",
      category: 'document',
    },
    fn: (ctx, spec, extra?) => {
      if (ctx.mode === 'office') throw new Error(officeUnsupported('chart'));
      return chartMarkup({ ...asObject(spec), ...asObject(extra) } as ChartSpec);
    },
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
    fn: (ctx, url, options?) => {
      const o = asObject(options) as ImageOptions;
      if (ctx.drawing)
        return ctx.drawing({ kind: 'url', url: resolveAsset(ctx.assetBaseUrl, String(url ?? '')), width: o.width, height: o.height, alt: o.alt });
      return imageMarkup(String(url ?? ''), o);
    },
  },
];

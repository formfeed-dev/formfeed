/**
 * apitemplate.io compatibility (spec 04 §2.5, spec 10 §4): their `settings` object, as sent to
 * `create-pdf-from-html` and as stored on their templates, mapped to Formfeed template settings.
 * Shared by the gateway shim (Worker) and the importer in the engine, so it must stay free of
 * heavy imports. Unknown keys are reported so the importer can list them.
 */
export interface ApitemplateSettings {
  [key: string]: unknown;
}

export interface MappedSettings {
  settings: Record<string, unknown>;
  /** Keys of the input that have no Formfeed equivalent. */
  ignored: string[];
  /** Human-readable notes about conversions that changed semantics. */
  notes: string[];
}

const paperFormats: Record<string, string> = {
  a3: 'A3',
  a4: 'A4',
  a5: 'A5',
  letter: 'Letter',
  legal: 'Legal',
  tabloid: 'Tabloid',
  ledger: 'Ledger',
};

function pick(input: ApitemplateSettings, ...keys: string[]): unknown {
  for (const key of keys) if (input[key] !== undefined && input[key] !== null && input[key] !== '') return input[key];
  return undefined;
}

/** `10`, `10mm`, `0.5in`, `20px` → CSS length; bare numbers are millimetres (apitemplate.io's unit). */
export function toLength(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return `${value}mm`;
  const text = String(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return `${text}mm`;
  if (/^-?\d+(\.\d+)?(mm|cm|in|px|pt)$/i.test(text)) return text.toLowerCase();
  return undefined;
}

const truthy = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';

/**
 * apitemplate.io's header placeholders as Chromium's header classes. Formfeed renders header and
 * footer through the template engine first, where `{{pageNumber}}` would be an empty variable.
 */
const chromePlaceholders: Array<[RegExp, string]> = [
  [/\{\{\s*(?:page_number|pageNumber)\s*\}\}/gi, '<span class="pageNumber"></span>'],
  [/\{\{\s*(?:total_pages|totalPages)\s*\}\}/gi, '<span class="totalPages"></span>'],
  [/\{\{\s*date\s*\}\}/g, '<span class="date"></span>'],
  [/\{\{\s*title\s*\}\}/g, '<span class="title"></span>'],
  [/\{\{\s*url\s*\}\}/g, '<span class="url"></span>'],
];

/** Chromium header templates carry `pageNumber`/`totalPages` spans; apitemplate.io templates use placeholders. */
export function convertHeaderFooter(html: unknown): string | undefined {
  if (typeof html !== 'string' || !html.trim()) return undefined;
  return chromePlaceholders.reduce((out, [pattern, span]) => out.replace(pattern, span), html);
}

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Markup left once `<style>` blocks are removed: a custom header of styles only shows nothing. */
const visibleMarkup = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, '').trim();

/**
 * One header or footer from apitemplate.io's template settings: `custom_header` markup when it
 * shows something, otherwise the three text slots (`header_left|center|right`) in a row, in
 * `header_font_size`. Styles of a custom header that shows nothing are kept for the slots.
 */
function apitemplateChrome(
  take: (...keys: string[]) => unknown,
  kind: 'header' | 'footer',
): { html?: string; fromSlots: boolean } {
  const custom = take(`custom_${kind}`);
  const customHtml = typeof custom === 'string' ? custom : '';
  // read before deciding, so slots a custom header replaces do not count as dropped settings
  const slots = (['left', 'center', 'right'] as const).map((side) => {
    const value = take(`${kind}_${side}`);
    return typeof value === 'string' ? value.trim() : '';
  });
  const size = take(`${kind}_font_size`);
  if (visibleMarkup(customHtml)) return { html: convertHeaderFooter(customHtml), fromSlots: false };
  if (!slots.some(Boolean)) return { fromSlots: false };
  const sizeText = size === undefined ? '' : String(size).trim();
  const fontSize = /^\d+(\.\d+)?$/.test(sizeText) ? `${sizeText}px` : /^\d+(\.\d+)?(px|pt|mm)$/.test(sizeText) ? sizeText : '9px';
  const cells = slots
    .map((text, i) => `<span style="flex:1;text-align:${['left', 'center', 'right'][i]}">${escapeText(text)}</span>`)
    .join('');
  const styles = customHtml.match(/<style[\s\S]*?<\/style>/gi)?.join('') ?? '';
  return {
    html: convertHeaderFooter(`${styles}<div style="display:flex;gap:4mm;font-size:${fontSize}">${cells}</div>`),
    fromSlots: true,
  };
}

export function mapApitemplateSettings(input: ApitemplateSettings | null | undefined): MappedSettings {
  const settings: Record<string, unknown> = {};
  const notes: string[] = [];
  const used = new Set<string>();
  const take = (...keys: string[]) => {
    const value = pick(input ?? {}, ...keys);
    for (const key of keys) if ((input ?? {})[key] !== undefined) used.add(key);
    return value;
  };
  if (!input) return { settings, ignored: [], notes };

  const paperSize = take('paper_size', 'paperSize', 'page_size', 'format');
  const orientation = take('orientation');
  const width = toLength(take('custom_width', 'customWidth', 'width'));
  const height = toLength(take('custom_height', 'customHeight', 'height'));
  const paper: Record<string, unknown> = {};
  if (typeof paperSize === 'string') {
    const format = paperFormats[paperSize.toLowerCase()];
    if (format) paper['format'] = format;
    else notes.push(`paper size "${paperSize}" is not a known format; A4 is used`);
  }
  if (width && height) {
    paper['width'] = width;
    paper['height'] = height;
    notes.push('custom page size kept as explicit width and height');
  }
  if (orientation !== undefined) {
    const landscape =
      orientation === 'landscape' || orientation === 2 || orientation === '2' || orientation === 'Landscape';
    paper['landscape'] = landscape;
  }
  if (Object.keys(paper).length) settings['paper'] = paper;

  const margin: Record<string, string> = {};
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const value = toLength(take(`margin_${side}`, `margin${side[0]!.toUpperCase()}${side.slice(1)}`));
    if (value) margin[side] = value;
  }
  if (Object.keys(margin).length) settings['margin'] = margin;

  // create-pdf-from-html takes header_template; stored templates carry custom_header or the text slots
  let header = convertHeaderFooter(take('header_template', 'headerTemplate', 'header_html', 'header'));
  let footer = convertHeaderFooter(take('footer_template', 'footerTemplate', 'footer_html', 'footer'));
  const storedHeader = apitemplateChrome(take, 'header');
  const storedFooter = apitemplateChrome(take, 'footer');
  header ??= storedHeader.html;
  footer ??= storedFooter.html;
  if (storedHeader.fromSlots || storedFooter.fromSlots)
    notes.push('header and footer text (left, center, right) rebuilt as HTML; {{pageNumber}}, {{totalPages}} and {{date}} are kept');
  const displayHeaderFooter = take('displayHeaderFooter', 'display_header_footer', 'print_header_footer');
  if (header && (displayHeaderFooter === undefined || truthy(displayHeaderFooter))) settings['header'] = { html: header };
  if (footer && (displayHeaderFooter === undefined || truthy(displayHeaderFooter))) settings['footer'] = { html: footer };

  const printBackground = take('print_background', 'printBackground');
  if (printBackground !== undefined) settings['printBackground'] = truthy(printBackground);
  const scale = take('scale');
  if (scale !== undefined && Number.isFinite(Number(scale))) settings['scale'] = Number(scale);
  const pageRanges = take('page_ranges', 'pageRanges');
  if (typeof pageRanges === 'string' && pageRanges.trim()) settings['pageRanges'] = pageRanges.trim();
  const preferCss = take('prefer_css_page_size', 'preferCSSPageSize', 'preferCssPageSize');
  if (preferCss !== undefined) settings['preferCssPageSize'] = truthy(preferCss);

  // images (create-image and JPEG/PNG templates)
  const imageType = take('output_image_type', 'outputImageType', 'image_type');
  const viewportWidth = take('viewport_width', 'viewportWidth', 'image_width');
  const viewportHeight = take('viewport_height', 'viewportHeight', 'image_height');
  const deviceScale = take('device_scale', 'deviceScaleFactor', 'image_resample_scale');
  const image: Record<string, unknown> = {};
  if (imageType !== undefined) {
    const t = String(imageType).toLowerCase();
    image['format'] = t === '1' || t === 'jpeg' || t === 'jpg' ? 'jpeg' : 'png';
  }
  if (viewportWidth !== undefined && Number.isFinite(Number(viewportWidth))) image['width'] = Number(viewportWidth);
  if (viewportHeight !== undefined && Number.isFinite(Number(viewportHeight))) image['height'] = Number(viewportHeight);
  if (deviceScale !== undefined && Number.isFinite(Number(deviceScale))) image['deviceScaleFactor'] = Number(deviceScale);
  if (Object.keys(image).length) settings['image'] = image;

  const ignored = Object.keys(input).filter((k) => !used.has(k));
  return { settings, ignored, notes };
}

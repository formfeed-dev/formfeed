/**
 * Output formats of a render and the one rule for the format a request gets when it names none.
 * Imported without the renderers as `@formfeed/engine/output` (the gateway), so it depends on
 * nothing.
 */

/** The API's `output` values. JPEG is `jpg` here; settings spell it `jpeg`. */
export const outputFormats = ['pdf', 'png', 'jpg', 'webp'] as const;
export type OutputFormat = (typeof outputFormats)[number];

export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === 'string' && (outputFormats as readonly string[]).includes(value);
}

/** `settings.image.format` as an output; `jpg` is accepted too, anything else is PNG. */
export function imageOutput(settings: unknown): Exclude<OutputFormat, 'pdf'> {
  const image = settings && typeof settings === 'object' ? (settings as { image?: unknown }).image : undefined;
  const format = image && typeof image === 'object' ? (image as { format?: unknown }).format : undefined;
  if (format === 'jpeg' || format === 'jpg') return 'jpg';
  if (format === 'webp') return 'webp';
  return 'png';
}

/**
 * The output of a render that names none: a PDF template renders a PDF, an image template the format
 * of its `settings.image.format` (PNG without one). Settings are the template's with the request's
 * merged over them, so a request can pick the image format without naming `output`. Sources without
 * a kind (ad-hoc HTML, URLs) render PDFs.
 */
export function defaultOutput(kind: string | null | undefined, ...settings: unknown[]): OutputFormat {
  if (kind !== 'image') return 'pdf';
  let chosen: OutputFormat = 'png';
  for (const layer of settings) {
    const image = layer && typeof layer === 'object' ? (layer as { image?: { format?: unknown } }).image : undefined;
    if (image && typeof image === 'object' && image.format !== undefined) chosen = imageOutput(layer);
  }
  return chosen;
}

/**
 * Output formats of a render and the one rule for the format a request gets when it names none.
 * Imported without the renderers as `@formfeed/engine/output` (the gateway), so it depends on
 * nothing.
 */

/** The API's `output` values. JPEG is `jpg` here; settings spell it `jpeg`. */
export const outputFormats = ['pdf', 'png', 'jpg', 'webp', 'docx', 'pptx'] as const;
export type OutputFormat = (typeof outputFormats)[number];
export type ImageOutput = 'png' | 'jpg' | 'webp';

/** Template kinds whose template is a Word or PowerPoint file (spec 22 §4.1). */
export const officeKinds = ['docx', 'pptx'] as const;
export type OfficeKind = (typeof officeKinds)[number];

export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === 'string' && (outputFormats as readonly string[]).includes(value);
}

export function isOfficeKind(value: unknown): value is OfficeKind {
  return typeof value === 'string' && (officeKinds as readonly string[]).includes(value);
}

/**
 * The outputs a source may request (spec 22 §4.1): an office template its own format or a PDF;
 * everything else (PDF and image templates, ad-hoc HTML, URLs) PDF or an image.
 */
export function outputsForKind(kind: string | null | undefined): readonly OutputFormat[] {
  if (kind === 'docx') return ['docx', 'pdf'];
  if (kind === 'pptx') return ['pptx', 'pdf'];
  return ['pdf', 'png', 'jpg', 'webp'];
}

/** `settings.image.format` as an output; `jpg` is accepted too, anything else is PNG. */
export function imageOutput(settings: unknown): ImageOutput {
  const image = settings && typeof settings === 'object' ? (settings as { image?: unknown }).image : undefined;
  const format = image && typeof image === 'object' ? (image as { format?: unknown }).format : undefined;
  if (format === 'jpeg' || format === 'jpg') return 'jpg';
  if (format === 'webp') return 'webp';
  return 'png';
}

/**
 * The output of a render that names none: a PDF template renders a PDF, an image template the format
 * of its `settings.image.format` (PNG without one), an office template `settings.office.output` (its
 * own format without one). Settings are the template's with the request's merged over them, so a
 * request can pick the format without naming `output`. Sources without a kind (ad-hoc HTML, URLs)
 * render PDFs.
 */
export function defaultOutput(kind: string | null | undefined, ...settings: unknown[]): OutputFormat {
  if (isOfficeKind(kind)) {
    let chosen: OutputFormat = kind;
    for (const layer of settings) {
      const office = layer && typeof layer === 'object' ? (layer as { office?: { output?: unknown } }).office : undefined;
      const output = office && typeof office === 'object' ? office.output : undefined;
      if (output === 'pdf') chosen = 'pdf';
      else if (output === kind) chosen = kind;
    }
    return chosen;
  }
  if (kind !== 'image') return 'pdf';
  let chosen: OutputFormat = 'png';
  for (const layer of settings) {
    const image = layer && typeof layer === 'object' ? (layer as { image?: { format?: unknown } }).image : undefined;
    if (image && typeof image === 'object' && image.format !== undefined) chosen = imageOutput(layer);
  }
  return chosen;
}

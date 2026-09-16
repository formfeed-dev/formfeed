import type { OfficeDiagnostic } from './tags';
import { decodeText } from './xml';
import { readText, type ZipArchive } from './zip';

/**
 * Fonts an office document uses and whether the converter has them (spec 22 §4.6). A converted
 * document renders only with fonts the sidecar has or the document embeds; the list of installed
 * families is passed in (`OFFICE_FONT_FAMILIES` in `@formfeed/api-types`, generated from the image),
 * so the engine stays free of that dependency.
 */
export interface DocumentFont {
  name: string;
  embedded: boolean;
}

/** Office fonts LibreOffice replaces with a family of the same metrics, so lines break the same. */
export const METRIC_COMPATIBLE: Readonly<Record<string, string>> = {
  calibri: 'Carlito',
  cambria: 'Caladea',
  arial: 'Liberation Sans',
  helvetica: 'Liberation Sans',
  'times new roman': 'Liberation Serif',
  'courier new': 'Liberation Mono',
};

/** Theme placeholders, not font names. */
const THEME_REFERENCES = /^\+(mj|mn)-/;

export function documentFonts(archive: ZipArchive): DocumentFont[] {
  const fonts = new Map<string, DocumentFont>();
  const add = (name: string, embedded = false) => {
    const clean = decodeText(name).trim();
    if (!clean || THEME_REFERENCES.test(clean)) return;
    const key = clean.toLowerCase();
    const known = fonts.get(key);
    fonts.set(key, { name: known?.name ?? clean, embedded: embedded || (known?.embedded ?? false) });
  };

  // Word: every font the document uses is in the font table; embedded ones carry w:embed* children.
  const table = archive.get('word/fontTable.xml');
  if (table)
    for (const m of readText(table).matchAll(/<w:font\b[^>]*\bw:name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/w:font>)/g))
      add(m[1] ?? '', /<w:embed(?:Regular|Bold|Italic|BoldItalic)\b/.test(m[2] ?? ''));

  // Theme fonts (headings and body), in Word and PowerPoint.
  for (const entry of archive.entries)
    if (/^(word|ppt)\/theme\/theme\d*\.xml$/.test(entry.name))
      for (const m of readText(entry).matchAll(/<a:(?:major|minor)Font>\s*<a:latin\s+typeface="([^"]*)"/g)) add(m[1] ?? '');

  // PowerPoint: embedded fonts are listed in the presentation part.
  const presentation = archive.get('ppt/presentation.xml');
  if (presentation)
    for (const m of readText(presentation).matchAll(/<p:embeddedFont>\s*<p:font\s+typeface="([^"]*)"/g)) add(m[1] ?? '', true);

  return [...fonts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One diagnostic per font the converter will replace: info when a metric-compatible family stands
 * in, a warning otherwise, because the layout will differ (Aptos, Office's default since 2024, has no
 * free substitute).
 */
export function fontDiagnostics(fonts: readonly DocumentFont[], installed: readonly string[], part = 'word/fontTable.xml'): OfficeDiagnostic[] {
  const have = new Set(installed.map((f) => f.toLowerCase()));
  const out: OfficeDiagnostic[] = [];
  for (const font of fonts) {
    const key = font.name.toLowerCase();
    if (font.embedded || have.has(key)) continue;
    const substitute = METRIC_COMPATIBLE[key];
    out.push(
      substitute && have.has(substitute.toLowerCase())
        ? {
            severity: 'info',
            code: 'office-font-substituted',
            message: `${font.name} is replaced by ${substitute}, which has the same metrics; lines and pages break the same.`,
            part,
            paragraph: 1,
            text: font.name,
          }
        : {
            severity: 'warning',
            code: 'office-font-substituted',
            message: `${font.name} is not available to the converter and is replaced, so the PDF can look different. Embed the font in Word (File > Options > Save > Embed fonts in the file).`,
            part,
            paragraph: 1,
            text: font.name,
          },
    );
  }
  return out;
}

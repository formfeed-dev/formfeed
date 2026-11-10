import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  MARKDOWN_REFUSALS,
  MARKDOWN_THEMES,
  MarkdownPictureError,
  inlineMarkdownPictures,
  markdownSettingsProblem,
  markdownTextWithinLimit,
} from '@formfeed/engine';
import { CliError } from './errors';

/**
 * `formfeed pdf convert notes.md` (plan 29, decision 10): a Markdown file becomes the request of a
 * Markdown render, on every plan. The options are folded into `settings` here, so the request says
 * once what the file asked for, and the API refuses nothing the CLI could have refused first.
 */

/** Whether a file is read as Markdown rather than uploaded to the office converter. */
export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export interface MarkdownConvertOptions {
  /** `--theme`: `document` or `none`. */
  theme?: string;
  /** `--css <file>`: a stylesheet after the theme. */
  css?: string;
  /** `--settings <file>`: a JSON object of render settings the other options go over. */
  settings?: string;
  /** `--raw-html`: raw HTML is written as it stands, as `settings.markdown.html: "allow"`. */
  rawHtml?: boolean;
  landscape?: boolean;
  pageRanges?: string;
}

export interface MarkdownConvertRequest {
  markdown: string;
  settings: Record<string, unknown>;
  /** The pictures sent along from the file's folder, and the names left for the file library. */
  inlined: string[];
  library: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The text of a file, without the byte order mark an editor on Windows may write. */
function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}

/** The request for one Markdown file, its local pictures as data URIs. */
export async function markdownConvertRequest(
  path: string,
  options: MarkdownConvertOptions,
  cwd: string,
): Promise<MarkdownConvertRequest> {
  const text = readText(path);
  if (!markdownTextWithinLimit(text))
    throw new CliError(`${path}: ${MARKDOWN_REFUSALS.textTooLarge}`);

  let settings: Record<string, unknown> = {};
  if (options.settings) {
    const file = resolve(cwd, options.settings);
    if (!existsSync(file)) throw new CliError(`No settings file ${file}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readText(file));
    } catch (e) {
      throw new CliError(
        `${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!isObject(parsed))
      throw new CliError(`${file} must hold a JSON object of render settings`);
    settings = parsed;
  }
  const given = settings['markdown'];
  if (given !== undefined && given !== null && !isObject(given))
    throw new CliError(MARKDOWN_REFUSALS.notObject);
  const block: Record<string, unknown> = isObject(given) ? { ...given } : {};
  if (options.theme !== undefined) {
    if (!(MARKDOWN_THEMES as readonly string[]).includes(options.theme))
      throw new CliError(
        `--theme is one of ${MARKDOWN_THEMES.join(', ')}, not ${options.theme}`,
      );
    block['theme'] = options.theme;
  }
  if (options.css !== undefined) {
    const file = resolve(cwd, options.css);
    if (!existsSync(file)) throw new CliError(`No stylesheet ${file}`);
    block['css'] = readText(file);
  }
  if (options.rawHtml) block['html'] = 'allow';
  if (Object.keys(block).length) settings['markdown'] = block;
  const problem = markdownSettingsProblem(settings['markdown']);
  if (problem) throw new CliError(problem.message);
  if (options.landscape) {
    const paper = isObject(settings['paper']) ? settings['paper'] : {};
    settings['paper'] = { ...paper, landscape: true };
  }
  if (options.pageRanges) settings['pageRanges'] = options.pageRanges;

  // a picture by a relative path inside the file's folder goes along; one outside is refused
  const folder = dirname(path);
  try {
    const pictures = await inlineMarkdownPictures(text, {
      locate(picture) {
        const file = resolve(folder, picture);
        const inside = relative(folder, file);
        return inside && !inside.startsWith('..') && !isAbsolute(inside)
          ? file
          : null;
      },
      async read(file) {
        if (!existsSync(file) || !statSync(file).isFile()) return null;
        return new Uint8Array(readFileSync(file));
      },
    });
    return { ...pictures, settings };
  } catch (e) {
    if (e instanceof MarkdownPictureError)
      throw new CliError(`${path}: ${e.message}`);
    throw e;
  }
}

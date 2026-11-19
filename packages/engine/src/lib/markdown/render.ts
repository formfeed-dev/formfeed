import {
  assembleDocument,
  fontFaceCss,
  mergeSettings,
  type AssembleExtras,
  type RenderedDocument,
  type TemplateKind,
  type TemplateSettings,
} from '../assemble';
import { brandCss, brandFontFamilies } from '../brand';
import { getEngine } from '../engines';
import { RenderLimitError } from '../errors';
import { enforceOutputBytes } from '../limits';
import type { EngineId, RenderContext } from '../types';
import {
  decodeEntities,
  markdownToHtml,
  type ConvertedMarkdown,
  type MarkdownConvertOptions,
} from './convert';
import { KeptHtmlCollector, type KeptHtml } from './kept';
import { resolveMarkdown } from './settings';
import { markdownThemeCss } from './themes';

/** A Markdown source (plan 29 §4): the text and, where it is a template over data, its engine. */
export interface MarkdownSource {
  /** Markdown; with `engine`, a template that renders to Markdown. */
  markdown: string;
  engine?: EngineId | null;
  settings?: TemplateSettings;
  kind?: TemplateKind;
}

/**
 * What converts the text. `markdownToHtml` by default; the render-worker passes one that runs it in
 * a thread of its own, which it can stop at the time limit (plan 29, decision 13). A converter
 * passed in answers for its own time.
 */
export type MarkdownConverter = (
  text: string,
  options: MarkdownConvertOptions,
) => Promise<ConvertedMarkdown>;

/** `</style` cannot close the element a stylesheet stands in. */
const inStyle = (css: string) => css.replace(/<\/style/gi, '<\\/style');

/**
 * Renders a Markdown source end to end (plan 29 §5), as `renderVersion` renders a template version.
 * With an engine, the text, the header, the footer and the metadata are rendered over the data first,
 * the text with the helpers' HTML kept behind placeholders; without one they are taken as written.
 * Then the text is converted, and the document assembled with the theme after the brand variables
 * and the print reset, and `settings.markdown.css` after the theme.
 *
 * The title is `pdf.metadata.title`, else the front matter's, else the first heading's text, and the
 * front matter fills the rest of the metadata where the settings leave it empty.
 */
export async function renderMarkdown(
  source: MarkdownSource,
  data: unknown,
  ctx: RenderContext,
  mode: 'preview' | 'print' = 'print',
  extras: AssembleExtras = {},
  convert: MarkdownConverter = markdownToHtml,
): Promise<RenderedDocument> {
  const startedAt = Date.now();
  const parts = await renderMarkdownParts(source, data, ctx);
  return finishMarkdown(source, parts, ctx, mode, extras, convert, startedAt);
}

/**
 * What a Markdown source's template code produced (plan 27 §5.1): the text, the header, the footer
 * and the metadata, and the HTML the helpers kept. Without an engine they are the source as written,
 * and nothing ran.
 */
export interface MarkdownParts {
  text: string;
  headerHtml?: string;
  footerHtml?: string;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  kept?: KeptHtml;
}

/**
 * The parts of a Markdown source as written: what a source without an engine renders to, without
 * running anything, so a host needs no sandbox for it.
 */
export function writtenMarkdownParts(source: MarkdownSource): MarkdownParts {
  const settings = mergeSettings(source.settings);
  const meta = settings.pdf?.metadata;
  const written = (value: string | null | undefined) => value || undefined;
  return {
    text: source.markdown,
    headerHtml: written(settings.header?.html),
    footerHtml: written(settings.footer?.html),
    title: written(meta?.title),
    author: written(meta?.author),
    subject: written(meta?.subject),
    keywords: written(meta?.keywords),
  };
}

/**
 * Renders the parts of a Markdown source over the data, the text with the helpers' HTML kept behind
 * placeholders of `nonce` (a fresh one without). The only step of a Markdown render that runs
 * template code.
 */
export async function renderMarkdownParts(
  source: MarkdownSource,
  data: unknown,
  ctx: RenderContext,
  nonce?: string,
): Promise<MarkdownParts> {
  const written = writtenMarkdownParts(source);
  if (!source.engine) return written;
  const { headerHtml, footerHtml } = written;
  const parts = [
    written.title,
    written.author,
    written.subject,
    written.keywords,
  ];
  const settings = mergeSettings(source.settings);
  const options = resolveMarkdown(settings.markdown);
  const renderCtx: RenderContext = {
    ...ctx,
    locale: settings.locale ?? ctx.locale,
    timezone: settings.timezone ?? ctx.timezone,
    currency: settings.currency ?? ctx.currency,
  };
  const engine = getEngine(source.engine);
  const collector = new KeptHtmlCollector(nonce);
  const renderPart = async (part: string | undefined, name: string) =>
    part
      ? engine.render(engine.compile(part, { name }), data, renderCtx)
      : undefined;
  const [text, header, footer, title, author, subject, keywords] =
    await Promise.all([
      engine.render(
        engine.compile(source.markdown, { name: 'markdown' }),
        data,
        {
          ...renderCtx,
          markdown: {
            html: options.html,
            keep: collector.keep,
            kept: collector,
          },
        },
      ),
      renderPart(headerHtml, 'header'),
      renderPart(footerHtml, 'footer'),
      ...(['title', 'author', 'subject', 'keywords'] as const).map((name, i) =>
        renderPart(parts[i], name),
      ),
    ]);
  return {
    text,
    headerHtml: header,
    footerHtml: footer,
    title,
    author,
    subject,
    keywords,
    kept: { nonce: collector.nonce, html: [...collector.html] },
  };
}

/**
 * Converts a Markdown source's rendered parts and assembles the document; runs no template code.
 * `startedAt` is when the render began, against which the default converter's time is held.
 */
export async function finishMarkdown(
  source: MarkdownSource,
  rendered: MarkdownParts,
  ctx: Pick<RenderContext, 'assetBaseUrl' | 'brand' | 'limits'>,
  mode: 'preview' | 'print' = 'print',
  extras: AssembleExtras = {},
  convert: MarkdownConverter = markdownToHtml,
  startedAt: number = Date.now(),
): Promise<RenderedDocument> {
  const settings = mergeSettings(source.settings);
  const options = resolveMarkdown(settings.markdown);
  const { text, headerHtml, footerHtml, kept } = rendered;
  const parts = [
    rendered.title,
    rendered.author,
    rendered.subject,
    rendered.keywords,
  ];

  // `highlight` is what the document asks for; the converter colours code only where its host
  // handed it the highlighter (the render-worker's thread), and prints it plain otherwise
  const converted = await convert(text, {
    html: options.html,
    breaks: options.breaks,
    highlight: options.highlight,
    kept,
  });
  // The default converter ran in this thread, where nothing could stop it, so its time is checked
  // once it is done. A converter passed in keeps the time itself: the render-worker's thread is
  // stopped at the limit, and the start of a thread is no part of a conversion's time.
  const elapsed = Date.now() - startedAt;
  if (convert === markdownToHtml && elapsed > ctx.limits.ms)
    throw new RenderLimitError(
      'ms',
      `The Markdown document took ${elapsed} ms to render; the limit is ${ctx.limits.ms} ms`,
    );
  // the size of what it wrote is the render's limit either way
  enforceOutputBytes(converted.html, ctx.limits);

  // what an engine rendered is escaped HTML; the PDF's metadata is text, as the front matter's is
  const fromSettings = parts.map(
    (part) =>
      (source.engine && part ? decodeEntities(part) : part)?.trim() ||
      undefined,
  );
  const front = converted.frontMatter;
  const title = fromSettings[0] || front.title || converted.heading;
  const metadata = Object.fromEntries(
    Object.entries({
      author: fromSettings[1] || front.author,
      subject: fromSettings[2] || front.subject,
      keywords: fromSettings[3] || front.keywords,
    }).filter(([, value]) => value),
  ) as RenderedDocument['metadata'];
  const css = inStyle(options.css);
  const inlineCss = [
    fontFaceCss(
      extras.fonts,
      `${css}\n${converted.html}\n${headerHtml ?? ''}\n${footerHtml ?? ''}\n${brandFontFamilies(ctx.brand)}`,
    ),
    brandCss(ctx.brand),
    extras.extraCss ?? '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    document: assembleDocument({
      html: converted.html,
      css,
      theme: markdownThemeCss(options.theme),
      settings,
      kind: source.kind,
      assetBaseUrl: ctx.assetBaseUrl,
      brand: ctx.brand,
      mode,
      title,
      ...extras,
    }),
    headerHtml,
    footerHtml,
    title,
    metadata,
    settings,
    inlineCss,
  };
}

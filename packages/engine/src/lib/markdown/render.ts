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
  const settings = mergeSettings(source.settings);
  const options = resolveMarkdown(settings.markdown);
  const renderCtx: RenderContext = {
    ...ctx,
    locale: settings.locale ?? ctx.locale,
    timezone: settings.timezone ?? ctx.timezone,
    currency: settings.currency ?? ctx.currency,
  };
  const meta = settings.pdf?.metadata;
  const written = (value: string | null | undefined) => value || undefined;
  let text = source.markdown;
  let headerHtml = written(settings.header?.html);
  let footerHtml = written(settings.footer?.html);
  let parts = [meta?.title, meta?.author, meta?.subject, meta?.keywords].map(
    written,
  );
  let kept: KeptHtml | undefined;
  if (source.engine) {
    const engine = getEngine(source.engine);
    const collector = new KeptHtmlCollector();
    const renderPart = async (part: string | undefined, name: string) =>
      part
        ? engine.render(engine.compile(part, { name }), data, renderCtx)
        : undefined;
    const [body, header, footer, ...metadata] = await Promise.all([
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
    text = body;
    headerHtml = header;
    footerHtml = footer;
    parts = metadata;
    kept = collector;
  }

  const converted = await convert(text, {
    html: options.html,
    breaks: options.breaks,
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

/**
 * The `document` theme (plan 29, decision 4): a document without a line of CSS from the caller. It
 * styles the wrapper the converter writes, `.ff-markdown`, and nothing outside it, so a template can
 * take it later (§13).
 *
 * - Text in Noto Sans and code in a monospace face the render-worker's image has, so a render
 *   downloads no font; the brand kit's fonts, size and primary colour where the organisation has one.
 * - Nothing is wider than the page, because Chromium shrinks every page of a PDF to fit an element
 *   that is: code blocks, inline code, links and table cells wrap anywhere.
 * - A heading takes its size from the level written (`ff-h1` to `ff-h6`), never from its tag, whose
 *   level the converter closes up, and stays with what follows it.
 * - Three lines at least at a page's foot and head.
 *
 * Any change here bumps `MARKDOWN_THEME_REVISIONS.document` (`themes.spec.ts` holds it to the hash).
 */
export const documentTheme = `.ff-markdown {
  font-family: var(--brand-font-body, "Noto Sans", "DejaVu Sans", sans-serif);
  font-size: var(--brand-font-size, 10.5pt);
  line-height: 1.5;
  color: #1f2328;
  overflow-wrap: break-word;
  orphans: 3;
  widows: 3;
}
.ff-markdown > :first-child { margin-top: 0; }
.ff-markdown h1, .ff-markdown h2, .ff-markdown h3, .ff-markdown h4, .ff-markdown h5, .ff-markdown h6 {
  font-family: var(--brand-font-heading, var(--brand-font-body, "Noto Sans", "DejaVu Sans", sans-serif));
  font-weight: 600;
  line-height: 1.25;
  margin: 1.4em 0 0.5em;
  break-after: avoid;
  break-inside: avoid;
}
.ff-markdown .ff-h1 { font-size: 1.9em; }
.ff-markdown .ff-h2 { font-size: 1.45em; padding-bottom: 0.2em; border-bottom: 1px solid #d0d7de; }
.ff-markdown .ff-h3 { font-size: 1.2em; }
.ff-markdown .ff-h4 { font-size: 1em; }
.ff-markdown .ff-h5 { font-size: 0.9em; }
.ff-markdown .ff-h6 { font-size: 0.85em; color: #59636e; }
.ff-markdown p, .ff-markdown ul, .ff-markdown ol, .ff-markdown dl, .ff-markdown blockquote, .ff-markdown pre, .ff-markdown table { margin: 0 0 0.9em; }
.ff-markdown ul, .ff-markdown ol { padding-left: 1.8em; }
.ff-markdown li + li { margin-top: 0.2em; }
.ff-markdown li > p { margin: 0.3em 0; }
.ff-markdown li > ul, .ff-markdown li > ol { margin: 0.2em 0 0; }
.ff-markdown .task-list-item { list-style: none; }
.ff-markdown .task-list-item > input[type="checkbox"] { margin: 0 0.45em 0 -1.4em; vertical-align: -0.1em; }
.ff-markdown a { color: var(--brand-color-primary, #0b57d0); overflow-wrap: anywhere; }
.ff-markdown strong { font-weight: 600; }
.ff-markdown code, .ff-markdown kbd, .ff-markdown pre {
  font-family: "Noto Sans Mono", "DejaVu Sans Mono", "Liberation Mono", monospace;
}
.ff-markdown code { font-size: 0.88em; background: #f3f4f6; padding: 0.1em 0.3em; border-radius: 3px; overflow-wrap: anywhere; }
.ff-markdown kbd { font-size: 0.85em; border: 1px solid #d0d7de; border-bottom-width: 2px; border-radius: 3px; padding: 0 0.3em; }
.ff-markdown pre { font-size: 0.85em; line-height: 1.45; background: #f6f8fa; padding: 0.7em 0.9em; border-radius: 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
.ff-markdown pre code { font-size: 1em; background: none; padding: 0; border-radius: 0; }
.ff-markdown blockquote { border-left: 3px solid var(--brand-color-primary, #d0d7de); padding: 0 1em; color: #424a53; }
.ff-markdown blockquote > :last-child { margin-bottom: 0; }
.ff-markdown table { width: 100%; }
.ff-markdown th, .ff-markdown td { border: 1px solid #d0d7de; padding: 0.3em 0.6em; text-align: start; vertical-align: top; overflow-wrap: anywhere; }
.ff-markdown th { background: #f6f8fa; font-weight: 600; }
.ff-markdown img { max-width: 100%; height: auto; }
.ff-markdown hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.5em 0; }
.ff-markdown mark { background: #fff3b0; color: inherit; }
.ff-markdown .footnotes { font-size: 0.85em; color: #424a53; }
.ff-markdown .footnotes-sep { margin: 2em 0 1em; }
.ff-markdown .ff-raw { font-family: "Noto Sans Mono", "DejaVu Sans Mono", "Liberation Mono", monospace; font-size: 0.85em; color: #59636e; overflow-wrap: anywhere; }
`;

# @formfeed/engine

The template engine behind [Formfeed](https://formfeed.dev): Jinja2, Liquid and Handlebars templates
with one set of helpers, compiled and rendered to a complete HTML document. The same package runs
the web editor's preview, the `formfeed` CLI and Formfeed's render servers, so what it produces
locally is what the API renders. It works in browsers and Node 22+ and uses no Node-only APIs.

Most projects need the [CLI](https://www.npmjs.com/package/formfeed) and
[`@formfeed/testing`](https://www.npmjs.com/package/@formfeed/testing) rather than this package. Use
it to embed template compilation in your own tools, such as a custom preview.

```bash
npm install @formfeed/engine
```

```ts
import { getEngine, defaultHelpers, defaultLimits, assembleDocument } from '@formfeed/engine';

const engine = getEngine('liquid');
const compiled = engine.compile('<h1>{{ title | upper }}</h1>', {});
const analysis = engine.analyze('<h1>{{ title | upper }}</h1>');
// analysis.variables → [{ path: ['title'], ... }], analysis.diagnostics → []

const html = await engine.render(compiled, { title: 'Hello' }, {
  locale: 'de-DE', timezone: 'Europe/Berlin', currency: 'EUR',
  partials: async () => null, helpers: defaultHelpers(), limits: defaultLimits,
});

const document = assembleDocument({ html, css: '', head: '', settings: { paper: { format: 'A4' } }, kind: 'pdf' });
```

The supported surface is the `Engine` interface (`compile`, `analyze`, `render`) returned by
`getEngine`, the `defaultHelpers()` registry and `defaultLimits`, plus `assembleDocument`,
`renderVersion` and `inferSchema`. `compile` throws `EngineSyntaxError` with `line` and `column`.

## What is inside

| Module | Contents |
|---|---|
| `engines/` | `jinja2` (Nunjucks with a Python compatibility layer), `liquid` (LiquidJS), `handlebars`, each implementing `Engine` |
| `helpers/` | One helper registry for all three dialects: formatting (`money`, `date`, `number`, `numToWords`, `t`), text, collections, codes (`qrcode`, `barcode`, `epcQr`), document (`asset`, `pageBreak`, `image`, `chart`) |
| `analysis/` | Block pairing and sample-data checks behind every `analyze()` |
| `schema.ts` | `inferSchema(sample)` to JSON Schema 2020-12 |
| `assemble.ts` | Template settings, print reset, `assembleDocument()` and `renderVersion()` (body, header, footer, title) |
| `import/` | `importApitemplate()` and `importApitemplateFromApi()`, `importPdfmonkey()` and `importJsreport()`: convert templates of apitemplate.io, PDFMonkey and jsreport into Formfeed drafts |
| `office/` | Word and PowerPoint templates: `renderOffice()` fills a `.docx` or `.pptx` file, `analyzeOffice()` lists its tags, variables and findings per part and paragraph, `OfficeTemplateError` carries the findings of a document that cannot be filled, and `starterDocument()` and `starterPresentation()` return example files with their sample data |

## Documentation

- [Engine package](https://docs.formfeed.dev/devkit/engine-package)
- [Template languages](https://docs.formfeed.dev/templates/languages) and [helpers](https://docs.formfeed.dev/templates/helpers)

## Licence

MIT

# @formfeed/devkit

The local half of the [Formfeed](https://formfeed.dev) development kit: template folders, project
configuration (`formfeed.json`) and offline rendering with the same engine the API uses. The
[`formfeed` CLI](https://www.npmjs.com/package/formfeed) and
[`@formfeed/testing`](https://www.npmjs.com/package/@formfeed/testing) are built on it; use it
directly when you write your own tooling around a template repository.

```bash
npm install @formfeed/devkit
```

```ts
import { defaultData, diagnose, projectAround, readTemplate, renderLocal } from '@formfeed/devkit';

// a folder with template.html, template.json, style.css, data/*.json (see the project layout docs)
const project = projectAround('templates/invoice-de');
const tpl = readTemplate(project, 'invoice-de');
const { data } = defaultData(tpl); // data/default.json, or the first data set

console.log(diagnose(tpl, data)); // the editor's diagnostics: syntax errors, unknown variables
const { document } = await renderLocal(project, tpl, data, { mode: 'print' }); // complete HTML, no browser
```

A folder can hold a Word or PowerPoint document (`template.docx` or `template.pptx`) instead of the
HTML files; `readTemplate` returns it as `tpl.file` and `templateFileName(kind)` names the file for
a kind. `diagnose` lists such a template's findings by part and paragraph, `renderOfficeLocal` fills
it (`bytes`, `warnings`) and `officeSnapshot(bytes)` turns the filled file into readable XML for
snapshot tests:

```ts
import { officeSnapshot, readTemplate, renderOfficeLocal } from '@formfeed/devkit';

const offer = readTemplate(project, 'offer');
const filled = await renderOfficeLocal(project, offer, { customer: { name: 'Olvarest GmbH' } });
console.log(filled.warnings, officeSnapshot(filled.bytes));
```

`renderLocal` works on HTML templates only. Errors are `DevkitError` instances with a `code`, which
the CLI maps to its exit codes.

## Documentation

- [Development kit overview](https://docs.formfeed.dev/devkit/overview)
- [Project layout](https://docs.formfeed.dev/devkit/project-layout)

## Licence

MIT

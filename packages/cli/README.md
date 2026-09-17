# formfeed

The Formfeed CLI: templates as files, offline validation and hot-reload preview with the same
engine the API uses, true renders through the API, push and pull against a workspace.

```bash
npx formfeed init my-templates && cd my-templates
npx formfeed dev hello                      # http://localhost:4400, no account needed
npx formfeed login --api-key ff_test_…      # a key from the API keys page (template:write for push)
npx formfeed templates pull                 # workspace templates into templates/<slug>/
npx formfeed validate                       # diagnostics; exit 1 on errors
npx formfeed templates push --publish --message "Add EPC QR code"
npx formfeed render invoice-de --data default --out invoice.pdf
```

Layout of a template folder (`template.json` carries name, kind and engine):

```text
templates/invoice-de/
  template.json  template.html  style.css  head.html  header.html  footer.html
  settings.json  schema.json  i18n.json  data/default.json  data/*.json

templates/offer/                            a Word template (template.pptx for PowerPoint)
  template.json  template.docx  settings.json  schema.json  i18n.json  data/*.json
```

Word and PowerPoint templates are filled on your machine: `render --output docx` writes the filled
document, `render --output pdf` converts it through the API (Starter plan and above). QR codes,
barcodes and SVG pictures in them are drawn by `@resvg/resvg-js`, an optional dependency; without it
they are left out with a warning.

More commands:

```bash
npx formfeed pdf convert report.xlsx        # any Word, Excel, PowerPoint, OpenDocument or RTF file to PDF
npx formfeed import apitemplate --all --key "$APITEMPLATE_API_KEY" --source-region de
npx formfeed files push                     # the files/ folder into the workspace file library
npx formfeed brand pull                     # the brand kit for local previews
npx formfeed partials pull                  # shared partials into partials/
npx formfeed workspaces delete <id> --yes   # needs the workspace:delete scope
```

Configuration precedence: flags, then `FORMFEED_API_KEY` / `FORMFEED_BASE_URL` /
`FORMFEED_WORKSPACE` / `FORMFEED_REGION`, then `formfeed.json`, then the user config
(`~/.config/formfeed/config.json`, `%APPDATA%\formfeed\config.json`). Exit codes: 0 ok,
1 validation, 2 usage, 3 auth, 4 network or API, 5 quota.

Documentation: <https://docs.formfeed.dev/cli>

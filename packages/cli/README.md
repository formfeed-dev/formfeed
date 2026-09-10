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
```

Configuration precedence: flags, then `FORMFEED_API_KEY` / `FORMFEED_BASE_URL` /
`FORMFEED_WORKSPACE`, then `formfeed.json`, then the user config
(`~/.config/formfeed/config.json`, `%APPDATA%\formfeed\config.json`). Exit codes: 0 ok,
1 validation, 2 usage, 3 auth, 4 network or API, 5 quota.

Documentation: <https://docs.formfeed.dev/cli>

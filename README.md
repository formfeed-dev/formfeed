# Formfeed packages

Client libraries, command line tools and integrations for [Formfeed](https://formfeed.dev/?utm_source=github), the API
for generating PDFs and images from templates. Documentation lives at
[docs.formfeed.dev](https://docs.formfeed.dev).

| Package | Registry | What it is |
|---|---|---|
| [`@formfeed/sdk`](packages/sdk-ts) | [npm](https://www.npmjs.com/package/@formfeed/sdk) | TypeScript client: renders, batches, templates, webhooks. No dependencies, Web APIs only |
| [`formfeed`](packages/sdk-python) | [PyPI](https://pypi.org/project/formfeed/) | Python client, sync and async |
| [`formfeed`](packages/cli) | [npm](https://www.npmjs.com/package/formfeed) | CLI: templates as files, offline preview and validation, renders through the API |
| [`@formfeed/engine`](packages/engine) | [npm](https://www.npmjs.com/package/@formfeed/engine) | The template engine (Jinja2, Liquid, Handlebars) the API and the editor use |
| [`@formfeed/devkit`](packages/devkit) | [npm](https://www.npmjs.com/package/@formfeed/devkit) | Template folders, project config and local rendering |
| [`@formfeed/testing`](packages/testing) | [npm](https://www.npmjs.com/package/@formfeed/testing) | Vitest and Jest matchers for templates |
| [`@formfeed/mcp`](packages/mcp) | [npm](https://www.npmjs.com/package/@formfeed/mcp) | Model Context Protocol server for AI agents |
| [`n8n-nodes-formfeed`](packages/n8n-nodes-formfeed) | [npm](https://www.npmjs.com/package/n8n-nodes-formfeed) | n8n community node |

Every npm package is built and published from this repository by
[GitHub Actions](.github/workflows/release.yml) with
[provenance](https://docs.npmjs.com/generating-provenance-statements), and the Python package with
[trusted publishing](https://docs.pypi.org/trusted-publishers/), so each release can be traced to
the commit and workflow run it came from.

## Development

Node 22 or newer and pnpm (the version in `package.json`, `corepack enable` picks it up):

```bash
pnpm install
pnpm nx run-many -t lint test --exclude sdk-python   # TypeScript packages
pnpm nx run-many -t bundle smoke                     # build, pack and try every npm package
cd packages/sdk-python && pip install pytest httpx pydantic && python -m pytest -q
```

This repository is generated from Formfeed's main repository, where the packages are developed
together with the API they talk to. See [CONTRIBUTING.md](CONTRIBUTING.md) for how issues and pull
requests are handled.

## Licence

MIT, see [LICENSE](LICENSE). Bundled third-party code keeps its own licence; the CLI and MCP packages
list it in `THIRD_PARTY_LICENSES.md`.

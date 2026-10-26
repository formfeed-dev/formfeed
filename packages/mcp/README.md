# @formfeed/mcp

[![formfeed MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/formfeed-dev/formfeed/badges/score.svg)](https://glama.ai/mcp/servers/formfeed-dev/formfeed)

Model Context Protocol server for [Formfeed](https://formfeed.dev/?utm_source=npm&utm_content=mcp).
Gives Claude, Cursor and other agents ten tools: `list_templates`, `get_template_schema`,
`validate_template` (free: the data against the template's schema, ad-hoc HTML offline), `check_invoice` (free and offline: the
`_invoice` block of a ZUGFeRD / Factur-X e-invoice against EN 16931), `render` (with `einvoice`, the PDF becomes that e-invoice; an
image comes back as a picture the agent can look at),
`convert_to_pdf` (Word, Excel, PowerPoint and OpenDocument to PDF), `get_render`, `get_workspace` (which workspace the
server works in, and the units left), `get_template_source` and `save_template` (a new template or a change as a draft,
which a person publishes in Formfeed; needs `template:write` on the key, or the person's permission for a signed-in agent).

## stdio (Claude Desktop, Cursor, Claude Code)

```json
{
  "mcpServers": {
    "formfeed": {
      "command": "npx",
      "args": ["-y", "@formfeed/mcp"],
      "env": { "FORMFEED_API_KEY": "ff_test_…" }
    }
  }
}
```

A test key renders for free (on the Free plan with a test mark); a live key consumes units.
Without `FORMFEED_API_KEY` the server starts too, with the offline checks only: `validate_template`
with `html` and `engine`, and `check_invoice`. `FORMFEED_REGION=us` or `FORMFEED_BASE_URL` select
another API host.

## Hosted (Streamable HTTP)

`https://mcp.formfeed.dev/mcp` takes `Authorization: Bearer ff_…`, or signs in with your Formfeed
account when no key is sent (OAuth; the client opens the browser, and you choose the workspace the
agent works in). `https://mcp.formfeed.dev/mcp/<workspace id>` pins another workspace for a signed-in
client. Self-host the same endpoint with `formfeed-mcp --http --port 8790`, plus `--auth-server <issuer>`
for OAuth sign-in against your own Supabase Auth.

Claude Code installs the hosted server together with two skills for writing and checking templates
as Formfeed's plugin, from [formfeed-dev/skills](https://github.com/formfeed-dev/skills):
<https://docs.formfeed.dev/devkit/coding-agents>

Documentation: <https://docs.formfeed.dev/integrations/mcp>

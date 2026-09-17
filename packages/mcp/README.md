# @formfeed/mcp

Model Context Protocol server for Formfeed. Gives Claude, Cursor and other agents six tools:
`list_templates`, `get_template_schema`, `validate_template` (offline, with the shared engine),
`render`, `convert_to_pdf` (Word, Excel, PowerPoint and OpenDocument to PDF) and `get_render`.

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

A test key renders free with a watermark; a live key consumes units. `FORMFEED_REGION=us` or
`FORMFEED_BASE_URL` select another API host.

## Hosted (Streamable HTTP)

`https://mcp.formfeed.dev/mcp/<workspace id>` signs in with your Formfeed account (OAuth; the client
opens the browser), `https://mcp.formfeed.dev/mcp` takes `Authorization: Bearer ff_…`. Self-host the
same endpoint with `formfeed-mcp --http --port 8790`, plus `--auth-server <issuer>` for OAuth sign-in
against your own Supabase Auth.

Documentation: <https://docs.formfeed.dev/integrations/mcp>

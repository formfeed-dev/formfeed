// Smoke test of the bundle: spawns dist/packages/mcp/bin/formfeed-mcp.mjs over stdio, completes the
// MCP handshake, lists the tools and runs the offline validator. No API is contacted (the base URL
// points at a closed port), so this runs in CI without a key.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/packages/mcp/bin/formfeed-mcp.mjs'],
  env: { ...process.env, FORMFEED_API_KEY: 'ff_test_smoke', FORMFEED_BASE_URL: 'http://127.0.0.1:9/v1' },
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const expected = ['convert_to_pdf', 'get_render', 'get_template_schema', 'list_templates', 'render', 'validate_template'];
if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`unexpected tools: ${names.join(', ')}`);
// the stdio server runs on the user's machine, so its convert tool reads local files
const convert = tools.find((t) => t.name === 'convert_to_pdf');
if (!convert?.inputSchema?.properties?.path) throw new Error('convert_to_pdf over stdio has no path parameter');
const result = await client.callTool({ name: 'validate_template', arguments: { html: '<p>{{ a | money }}</p>', engine: 'jinja2', data: { a: 1 } } });
if (result.structuredContent?.ok !== true) throw new Error(`validate_template failed: ${JSON.stringify(result)}`);
await client.close();
console.log(`formfeed-mcp smoke ok: ${names.length} tools, offline validation works`);

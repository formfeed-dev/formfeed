// Bundles the MCP server into dist/packages/mcp/bin/formfeed-mcp.mjs; workspace libraries inlined,
// npm dependencies external (see package.json), notices of inlined code in THIRD_PARTY_LICENSES.md.
import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import { writeThirdPartyLicenses } from '../../tools/publish/third-party-licenses.mjs';

const { metafile } = await build({
  entryPoints: ['packages/mcp/src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/packages/mcp/bin/formfeed-mcp.mjs',
  external: ['@modelcontextprotocol/sdk', 'zod'],
  tsconfig: 'packages/mcp/tsconfig.lib.json',
  banner: {
    js: `#!/usr/bin/env node\nimport { createRequire as __formfeedCreateRequire } from 'node:module';\nconst require = __formfeedCreateRequire(import.meta.url);`,
  },
  metafile: true,
  logLevel: 'warning',
});
mkdirSync('dist/packages/mcp', { recursive: true });
for (const file of ['package.json', 'README.md', 'LICENSE']) copyFileSync(`packages/mcp/${file}`, `dist/packages/mcp/${file}`);
writeThirdPartyLicenses(metafile, 'dist/packages/mcp/THIRD_PARTY_LICENSES.md', { title: 'The `@formfeed/mcp` bundle' });
console.log('bundled dist/packages/mcp/bin/formfeed-mcp.mjs');

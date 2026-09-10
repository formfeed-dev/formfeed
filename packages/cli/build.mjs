// Bundles the CLI into one ESM file (dist/packages/cli/bin/formfeed.mjs). Workspace libraries
// (@formfeed/engine, @formfeed/sdk-ts, @formfeed/api-types) are inlined; npm dependencies stay
// external and come from the published package.json. The banner gives CommonJS dependencies that
// are inlined (nunjucks, handlebars, liquidjs) a working `require`, and THIRD_PARTY_LICENSES.md
// carries the notices of everything inlined.
import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import { writeThirdPartyLicenses } from '../../tools/publish/third-party-licenses.mjs';

const externals = ['commander', 'pagedjs', 'chart.js', '@tailwindcss/browser'];

const { metafile } = await build({
  entryPoints: ['packages/cli/src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/packages/cli/bin/formfeed.mjs',
  external: externals,
  tsconfig: 'packages/cli/tsconfig.lib.json',
  banner: {
    js: `#!/usr/bin/env node\nimport { createRequire as __formfeedCreateRequire } from 'node:module';\nconst require = __formfeedCreateRequire(import.meta.url);`,
  },
  metafile: true,
  logLevel: 'warning',
});

mkdirSync('dist/packages/cli', { recursive: true });
for (const file of ['package.json', 'README.md', 'LICENSE']) copyFileSync(`packages/cli/${file}`, `dist/packages/cli/${file}`);
writeThirdPartyLicenses(metafile, 'dist/packages/cli/THIRD_PARTY_LICENSES.md', { title: 'The `formfeed` CLI bundle' });
console.log('bundled dist/packages/cli/bin/formfeed.mjs');

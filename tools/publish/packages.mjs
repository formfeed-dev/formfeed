/**
 * The npm packages built from workspace sources that have no manifest of their own.
 *
 * `cli`, `mcp` and `n8n-nodes-formfeed` keep a package.json in their folder. These four cannot:
 * the engine is imported by the app, the render-worker, the CLI and the dev kit, and a manifest
 * with dependencies would make pnpm install them into `packages/engine/node_modules`, changing
 * how every one of those importers resolves them (the render-worker's Docker image only copies
 * the root node_modules). So the manifests are generated at build time, with each dependency's
 * version taken from the root package.json as the lower bound of a caret range: the workspace
 * tests against that version, and a range lets users receive patches and share one copy with
 * their own dependencies. The @formfeed packages depend on each other exactly (one release).
 *
 * Order matters: a package may only depend on packages listed before it.
 *
 * `packages/cli`, `mcp` and `n8n-nodes-formfeed` repeat `author`, `repository` and `bugs` in their
 * own package.json; keep them equal to `common` below.
 */
export const VERSION = '0.3.7';

/** The public repository the packages are published from (tools/public-repo). */
export const PUBLIC_REPOSITORY = 'formfeed-dev/formfeed';

export const common = (dir) => ({
  author: { name: 'Formfeed', email: 'support@formfeed.dev', url: 'https://formfeed.dev' },
  repository: { type: 'git', url: `git+https://github.com/${PUBLIC_REPOSITORY}.git`, directory: `packages/${dir}` },
  bugs: { url: `https://github.com/${PUBLIC_REPOSITORY}/issues`, email: 'support@formfeed.dev' },
  engines: { node: '>=22' },
});

export const packages = [
  {
    dir: 'sdk-ts',
    name: '@formfeed/sdk',
    description: 'Formfeed API client: renders, templates, webhooks. No dependencies, Web APIs only.',
    homepage: 'https://docs.formfeed.dev/api/sdks/typescript',
    platform: 'neutral',
    entries: { '.': 'src/index.ts' },
    dependencies: [],
    keywords: ['formfeed', 'pdf', 'pdf-generation', 'html-to-pdf', 'image-generation', 'templates', 'api', 'sdk'],
  },
  {
    dir: 'engine',
    name: '@formfeed/engine',
    description: 'The Formfeed template engine (Jinja2, Liquid, Handlebars) for the browser and Node.',
    homepage: 'https://docs.formfeed.dev/devkit/engine-package',
    platform: 'neutral',
    entries: { '.': 'src/index.ts' },
    // @formfeed/api-types is internal and inlined into the bundle
    dependencies: ['@date-fns/tz', 'bwip-js', 'date-fns', 'handlebars', 'liquidjs', 'marked', 'n2words', 'nunjucks', 'qrcode'],
    keywords: ['formfeed', 'templates', 'template-engine', 'jinja2', 'liquid', 'handlebars', 'pdf'],
  },
  {
    dir: 'devkit',
    name: '@formfeed/devkit',
    description: 'Formfeed template folders, project config and local rendering, shared by the CLI and @formfeed/testing.',
    homepage: 'https://docs.formfeed.dev/devkit/overview',
    platform: 'node',
    entries: { '.': 'src/index.ts' },
    dependencies: ['@formfeed/engine', '@formfeed/sdk'],
    keywords: ['formfeed', 'templates', 'pdf', 'devkit'],
  },
  {
    dir: 'testing',
    name: '@formfeed/testing',
    description: 'Vitest and Jest matchers for Formfeed templates: render without errors, use only known variables, snapshots.',
    homepage: 'https://docs.formfeed.dev/devkit/testing',
    platform: 'node',
    entries: { '.': 'src/index.ts', './vitest': 'src/vitest.ts', './jest': 'src/jest.ts' },
    dependencies: ['@formfeed/devkit', '@formfeed/engine', '@formfeed/sdk'],
    // the matching runner is the user's, so neither is required; the Vitest entry's `Matchers`
    // augmentation needs 3.2
    peerDependencies: { vitest: '>=3.2' },
    optionalPeers: ['vitest'],
    keywords: ['formfeed', 'testing', 'vitest', 'jest', 'matchers', 'templates'],
  },
];

/** Workspace path aliases that differ from the published name. */
export const renames = { '@formfeed/sdk-ts': '@formfeed/sdk' };

export const published = new Set(packages.map((p) => p.name));

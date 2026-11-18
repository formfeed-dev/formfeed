import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  defaultData,
  listTemplateSlugs,
  type LocalTemplate,
  type Project,
} from '@formfeed/devkit';
import { CliError, exitCodes } from './errors';

/**
 * `formfeed ci preview` on every data set, compared with the base branch (plan 35): which data sets
 * a template renders, the base branch's copy of the templates read from git, how two renders of a
 * data set compare, and the summary for the pull request.
 */

/** `--data-sets`: the default data set (as before plan 35), every one, or the named ones. */
export type DataSetChoice = 'default' | 'all' | string[];

export function parseDataSets(value: string): DataSetChoice {
  const text = value.trim();
  if (text === 'default' || text === 'all') return text;
  const names = text
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length)
    throw new CliError(
      '--data-sets takes default, all, or data set names separated by commas',
      exitCodes.usage,
    );
  return names;
}

/**
 * The data sets of a template that `ci preview` renders. Named ones a template does not have are
 * left out, and a template that has none of them renders its default data set, so a changed
 * template is never left out of the preview.
 */
export function previewDataSets(
  tpl: LocalTemplate,
  choice: DataSetChoice,
): Array<{ name: string; data: unknown }> {
  const names = Object.keys(tpl.dataSets);
  const chosen =
    choice === 'default'
      ? []
      : choice === 'all'
        ? names
        : names.filter((name) => choice.includes(name));
  return chosen.length
    ? chosen.map((name) => ({ name, data: tpl.dataSets[name] }))
    : [defaultData(tpl)];
}

/** A rendered file of the preview: `<slug>.<ext>` for the default data set alone, as before. */
export function previewFile(
  outDir: string,
  slug: string,
  dataSet: string,
  output: string,
  choice: DataSetChoice,
): string {
  return choice === 'default'
    ? join(outDir, `${slug}.${output}`)
    : join(outDir, slug, `${dataSet}.${output}`);
}

/** Runs git and answers its stdout, or null when git cannot answer; injected in tests. */
export type Git = (args: string[], cwd: string) => string | null;
/** Runs git and answers its stdout as bytes, for files that may be binary; injected in tests. */
export type GitBytes = (args: string[], cwd: string) => Uint8Array | null;

/** A path relative to the project root, with forward slashes. */
function projectPath(project: Project, dir: string): string {
  const rel = resolve(dir).startsWith(resolve(project.root))
    ? resolve(dir).slice(resolve(project.root).length)
    : dir;
  return rel.replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

/** The base branch's copy of the templates `--compare` renders, in a folder of its own. */
export interface BaseProject {
  project: Project;
  /** The ref the files were read at: where the branch left the base, as the change list is. */
  ref: string;
  /** The templates that exist there. */
  slugs: Set<string>;
  remove(): void;
}

/**
 * Reads the base's copy of the template folders and of the partials folder through git, never by
 * checking anything out: `git ls-tree` names the files and `git cat-file blob` reads each as bytes,
 * since a Word template is binary. The ref is the merge base of `base` and `HEAD`, as `git diff
 * base...HEAD` takes it for the list of changed templates, so a template the base branch changed
 * after the branch left it does not show as this branch's change. The project keeps the branch's
 * `formfeed.json`; the brand kit and the library's address are the caller's, so that only the
 * templates differ between the two renders.
 */
export function readBaseProject(
  project: Project,
  base: string,
  slugs: string[],
  git: Git,
  gitBytes: GitBytes,
): BaseProject {
  const cwd = project.root;
  const ref = git(['merge-base', base, 'HEAD'], cwd)?.trim() || base;
  const templates = projectPath(project, project.templatesDir);
  const partials = projectPath(project, project.partialsDir);
  const listed = git(
    [
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      ref,
      '--',
      ...slugs.map((slug) => `${templates}/${slug}`),
      partials,
    ],
    cwd,
  );
  if (listed === null)
    throw new CliError(
      `ci preview --compare cannot read the templates of ${base} through git; fetch the history up to it (actions/checkout with fetch-depth: 0)`,
      exitCodes.usage,
    );
  const root = mkdtempSync(join(tmpdir(), 'formfeed-base-'));
  const remove = () => rmSync(root, { recursive: true, force: true });
  try {
    for (const name of listed.split('\0').filter(Boolean)) {
      const bytes = gitBytes(['cat-file', 'blob', `${ref}:./${name}`], cwd);
      if (!bytes) continue;
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
  } catch (e) {
    remove();
    throw e;
  }
  const baseProject: Project = {
    ...project,
    root,
    configPath: null,
    templatesDir: join(root, templates),
    partialsDir: join(root, partials),
  };
  return {
    project: baseProject,
    ref,
    slugs: new Set(listTemplateSlugs(baseProject)),
    remove,
  };
}

/** One render of a data set on one side, as the summary and `--json` show it. */
export interface PreviewSide {
  status: 'succeeded' | 'failed';
  pages?: number | null;
  url?: string | null;
  error?: string;
  /** Whose key rendered it, as the API says: the summary names it. */
  environment?: 'live' | 'test';
}

/** How a data set's page count compares with the base (`--compare`). */
export type PageChange = 'same' | 'changed' | 'new' | 'removed' | 'base_failed';

export interface PreviewRow extends Omit<Partial<PreviewSide>, 'status'> {
  slug: string;
  data: string;
  /** The branch's render; `removed` for a data set that only the base has, which is not rendered. */
  status: 'succeeded' | 'failed' | 'removed';
  file?: string;
  /** With `--compare`: the base's render of the same data set; absent where the base has none. */
  base?: PreviewSide;
  change?: PageChange;
}

/**
 * What a data set's two renders say about its pages: `new` where the base has no such data set,
 * `base_failed` where its render failed (never a failure of the branch, which may be the fix), and
 * nothing for a branch render that failed, which fails the run on its own, or for an image.
 */
export function pageChange(
  branch: PreviewSide,
  base: PreviewSide | undefined,
): PageChange | undefined {
  if (!base) return 'new';
  if (branch.status !== 'succeeded') return undefined;
  if (base.status !== 'succeeded') return 'base_failed';
  if (typeof branch.pages !== 'number' || typeof base.pages !== 'number')
    return undefined;
  return branch.pages === base.pages ? 'same' : 'changed';
}

/**
 * What the summary says about the key, from the renders themselves: until 2026-10-19 it said "test
 * key" whatever key rendered, also under renders that had counted units.
 */
export function previewKeyLine(
  rows: Array<
    Pick<PreviewRow, 'environment'> & {
      base?: Pick<PreviewSide, 'environment'>;
    }
  >,
): string | null {
  const environments = new Set(
    rows.flatMap((r) => [r.environment, r.base?.environment]).filter(Boolean),
  );
  if (environments.has('live'))
    return 'Rendered with a Formfeed live key, so these renders counted units; links expire.';
  if (environments.has('test'))
    return 'Rendered with a Formfeed test key; links expire.';
  return null;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** The rendered file as a link: its name and the render's download link, or the local file. */
function output(row: PreviewRow): string {
  if (row.status === 'removed') return '—';
  if (row.status === 'failed') return `failed: ${row.error ?? 'unknown error'}`;
  const link = `[${basename(row.file ?? '')}](${row.url ?? row.file ?? ''})`;
  return row.base?.url ? `${link}, [base](${row.base.url})` : link;
}

/** The base's cell of a row: its pages, or why it has none. */
function baseCell(row: PreviewRow): string {
  if (!row.base) return '—';
  if (row.base.status !== 'succeeded')
    return `base failed: ${row.base.error ?? 'unknown error'}`;
  return String(row.base.pages ?? '—');
}

/** The branch's cell of a row: its pages, bold when they changed. */
function branchCell(row: PreviewRow): string {
  if (row.status === 'removed') return 'removed';
  if (row.status === 'failed') return '—';
  const pages = String(row.pages ?? '?');
  if (row.change === 'changed') return `**${pages}**`;
  if (row.change === 'new') return `${pages} (new)`;
  return pages;
}

export interface PreviewSummary {
  base: string;
  rows: PreviewRow[];
  /** `--compare` ran: the table has a column for the base. */
  compare: boolean;
  /** `--allow-page-changes`: a changed count is reported, not failed. */
  allowPageChanges: boolean;
}

/** The data sets whose page count changed against the base. */
export const pagesChanged = (rows: PreviewRow[]) =>
  rows.filter((r) => r.change === 'changed').length;

/**
 * The Markdown summary for the pull request. Without `--compare` it is the table it always was, a
 * row per rendered data set; with it, a column for the base, the changed counts in bold and the
 * number of them in the first line.
 */
export function previewMarkdown(summary: PreviewSummary): string {
  const { base, rows, compare } = summary;
  const templates = new Set(rows.map((r) => r.slug)).size;
  const keyLine = previewKeyLine(rows);
  let first = `Templates changed against \`${base}\`: ${templates}`;
  if (rows.length !== templates)
    first += `, data sets: ${rows.filter((r) => r.status !== 'removed').length}`;
  const changed = pagesChanged(rows);
  if (compare)
    first +=
      changed > 0
        ? `. **${plural(changed, 'data set changed its page count', 'data sets changed their page count')}.**`
        : '. No data set changed its page count.';
  const lines = ['## Formfeed preview', '', first, ''];
  if (compare)
    lines.push(
      '| Template | Data set | Base | Branch | Output |',
      '| --- | --- | --- | --- | --- |',
      ...rows.map(
        (r) =>
          `| \`${r.slug}\` | ${r.data} | ${baseCell(r)} | ${branchCell(r)} | ${output(r)} |`,
      ),
    );
  else
    lines.push(
      '| Template | Data set | Pages | Output |',
      '| --- | --- | --- | --- |',
      ...rows.map((r) =>
        r.status === 'succeeded'
          ? `| \`${r.slug}\` | ${r.data} | ${r.pages ?? '?'} | ${output(r)} |`
          : `| \`${r.slug}\` | ${r.data} | — | ${output(r)} |`,
      ),
    );
  lines.push('');
  if (compare && changed > 0 && summary.allowPageChanges)
    lines.push('Changed page counts do not fail this run.', '');
  if (keyLine) lines.push(keyLine, '');
  return lines.join('\n');
}

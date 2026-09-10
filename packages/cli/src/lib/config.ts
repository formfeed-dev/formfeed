import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { findProject, type Project } from '@formfeed/devkit';
import { Formfeed } from '@formfeed/sdk-ts';
import { CliError, exitCodes } from './errors';

export { defaultProjectConfig, findProject, loadProject, writeProjectConfig } from '@formfeed/devkit';
export type { Project, ProjectConfig } from '@formfeed/devkit';

export type Region = 'eu' | 'us';

/** `~/.config/formfeed/config.json` (spec 15 §1, §8). */
export interface UserConfig {
  apiKey?: string;
  baseUrl?: string;
  workspace?: string;
  region?: Region;
}

/** Global flags every command accepts. */
export interface GlobalFlags {
  apiKey?: string;
  baseUrl?: string;
  workspace?: string;
  region?: Region;
  json?: boolean;
  ci?: boolean;
  verbose?: boolean;
}

export interface Settings {
  apiKey: string | null;
  baseUrl: string | null;
  workspace: string | null;
  region: Region;
  json: boolean;
  ci: boolean;
  verbose: boolean;
  project: Project | null;
  user: UserConfig;
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env['FORMFEED_CONFIG_DIR']) return join(env['FORMFEED_CONFIG_DIR'], 'config.json');
  if (process.platform === 'win32' && env['APPDATA']) return join(env['APPDATA'], 'formfeed', 'config.json');
  const base = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, 'formfeed', 'config.json');
}

export function loadUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfig {
  const path = userConfigPath(env);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as UserConfig;
  } catch {
    throw new CliError(`The user config at ${path} is not valid JSON`, exitCodes.usage);
  }
}

/** Written with mode 0600: the file holds the API key when no keychain is available. */
export function saveUserConfig(config: UserConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = userConfigPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACLs: the directory is the user's profile
  }
  return path;
}

/** Precedence of spec 15 §1: flags > environment > formfeed.json > user config. */
export function resolveSettings(
  flags: GlobalFlags,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Settings {
  const user = loadUserConfig(env);
  const project = findProject(cwd);
  const region = (flags.region ?? (env['FORMFEED_REGION'] as Region | undefined) ?? project?.config.region ?? user.region ?? 'eu') as Region;
  return {
    apiKey: flags.apiKey ?? env['FORMFEED_API_KEY'] ?? user.apiKey ?? null,
    baseUrl: flags.baseUrl ?? env['FORMFEED_BASE_URL'] ?? user.baseUrl ?? null,
    workspace: flags.workspace ?? env['FORMFEED_WORKSPACE'] ?? project?.config.workspace ?? user.workspace ?? null,
    region,
    json: Boolean(flags.json),
    ci: Boolean(flags.ci) || Boolean(env['CI']),
    verbose: Boolean(flags.verbose),
    project,
    user,
  };
}

export function requireProject(settings: Settings): Project {
  if (!settings.project)
    throw new CliError('No formfeed.json found here or above; run `formfeed init` first', exitCodes.usage);
  return settings.project;
}

export function createClient(settings: Settings, fetchImpl?: typeof fetch): Formfeed {
  if (!settings.apiKey)
    throw new CliError(
      'No API key: run `formfeed login --api-key ff_…` or set FORMFEED_API_KEY',
      exitCodes.auth,
    );
  return new Formfeed({
    apiKey: settings.apiKey,
    region: settings.region,
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

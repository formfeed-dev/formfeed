import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProject, loadUserConfig, resolveSettings, saveUserConfig, userConfigPath, writeProjectConfig } from './config';

describe('config precedence (spec 15 §1)', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'formfeed-cli-'));
    env = { FORMFEED_CONFIG_DIR: join(dir, 'user') };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads flags over environment over formfeed.json over the user config', () => {
    saveUserConfig({ apiKey: 'ff_test_user', region: 'us', workspace: 'user/ws' }, env);
    expect(readFileSync(userConfigPath(env), 'utf8')).toContain('ff_test_user');
    writeProjectConfig(dir, { workspace: 'fennlor/production', region: 'eu' });
    const nested = join(dir, 'templates', 'deep');
    mkdirSync(nested, { recursive: true });

    const fromFiles = resolveSettings({}, nested, env);
    expect(fromFiles.apiKey).toBe('ff_test_user');
    expect(fromFiles.workspace).toBe('fennlor/production'); // project beats user config
    expect(fromFiles.region).toBe('eu');
    expect(fromFiles.project?.root).toBe(dir);

    const fromEnv = resolveSettings({}, nested, { ...env, FORMFEED_API_KEY: 'ff_test_env', FORMFEED_WORKSPACE: 'env/ws', CI: '1' });
    expect(fromEnv.apiKey).toBe('ff_test_env');
    expect(fromEnv.workspace).toBe('env/ws');
    expect(fromEnv.ci).toBe(true);

    const fromFlags = resolveSettings({ apiKey: 'ff_test_flag', region: 'us', json: true }, nested, { ...env, FORMFEED_API_KEY: 'ff_test_env' });
    expect(fromFlags.apiKey).toBe('ff_test_flag');
    expect(fromFlags.region).toBe('us');
    expect(fromFlags.json).toBe(true);
  });

  it('finds no project outside one and tolerates a missing user config', () => {
    expect(findProject(dir)).toBeNull();
    expect(loadUserConfig(env)).toEqual({});
    expect(resolveSettings({}, dir, env).apiKey).toBeNull();
  });

  it('rejects invalid JSON with a usage error', () => {
    writeFileSync(join(dir, 'formfeed.json'), '{ not json');
    expect(() => resolveSettings({}, dir, env)).toThrow(/not valid JSON/);
  });
});

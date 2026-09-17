import { join } from 'node:path';
import { defaultProjectConfig, isIgnored, type Project } from './project-config';

const root = join('/', 'work', 'shop');
const project = (ignore: string[]): Project => ({
  root,
  configPath: join(root, 'formfeed.json'),
  config: { ...defaultProjectConfig, ignore },
  templatesDir: join(root, 'templates'),
  partialsDir: join(root, 'partials'),
  filesDir: join(root, 'files'),
});

describe('ignore patterns of formfeed.json', () => {
  it('matches folders by their path relative to the project root', () => {
    const p = project(['templates/wip-*']);
    expect(isIgnored(p, join(root, 'templates', 'wip-offer'), true)).toBe(true);
    expect(isIgnored(p, join(root, 'templates', 'offer'), true)).toBe(false);
    expect(isIgnored(p, join(root, 'templates', 'wip-offer', 'nested'), true)).toBe(false);
  });

  it('lets ** span folders and a bare name match at any depth', () => {
    expect(isIgnored(project(['**/drafts/**']), join(root, 'templates', 'drafts'), true)).toBe(true);
    expect(isIgnored(project(['**/drafts/**']), join(root, 'templates', 'draft'), true)).toBe(false);
    expect(isIgnored(project(['scratch']), join(root, 'templates', 'scratch'), true)).toBe(true);
    expect(isIgnored(project(['*.bak']), join(root, 'templates', 'offer', 'template.html.bak'))).toBe(true);
    expect(isIgnored(project(['templates/?ld']), join(root, 'templates', 'old'), true)).toBe(true);
  });

  it('treats regular expression characters in a pattern literally', () => {
    expect(isIgnored(project(['templates/a+b']), join(root, 'templates', 'a+b'), true)).toBe(true);
    expect(isIgnored(project(['templates/a+b']), join(root, 'templates', 'aab'), true)).toBe(false);
    expect(isIgnored(project([]), join(root, 'templates', 'drafts'), true)).toBe(false);
  });
});

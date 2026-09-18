import { describe, expect, it } from 'vitest';
import { printer, startRun } from './output';
import { Progress, colorEnabled, createStyle, formatElapsed, paintLine, plain, tally, truncate, unicodeSupported } from './ui';

const ESC = String.fromCharCode(27);
const strip = (text: string) => text.split(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`)).join('');

describe('terminal detection', () => {
  it('colours only a terminal, and NO_COLOR and FORCE_COLOR override that', () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: '0' }, true)).toBe(false);
    expect(colorEnabled({ TERM: 'dumb' }, true)).toBe(false);
  });

  it('keeps to ASCII in the legacy Windows console', () => {
    expect(unicodeSupported({}, 'win32')).toBe(false);
    expect(unicodeSupported({ WT_SESSION: 'x' }, 'win32')).toBe(true);
    expect(unicodeSupported({ TERM_PROGRAM: 'vscode' }, 'win32')).toBe(true);
    expect(unicodeSupported({}, 'linux')).toBe(true);
  });
});

describe('paintLine', () => {
  const style = createStyle(true);

  it('leaves text alone without colours', () => {
    expect(paintLine(plain, 'invoice: v3 published')).toBe('invoice: v3 published');
  });

  it('never changes the text, only adds colour', () => {
    for (const line of [
      'invoice: v3 published -> channel staging',
      'error  invoice/template.html:3:7  Unknown filter  [unknown-filter]',
      'warn   invoice/template.html:1:1  Unused variable  [unused]',
      'slug     kind  engine',
      '-------  ----  ------',
      'error: No formfeed.json found here or above',
      '  warning (inferred from sample data): "total" is no longer in the schema',
      '19 templates: 14 published, 5 unchanged in 9.2s',
    ])
      expect(strip(paintLine(style, line))).toBe(line);
  });

  it('colours a status word but not a slug or file that contains one', () => {
    expect(paintLine(style, 'invoice: v3 published')).toContain(style.green('published'));
    expect(paintLine(style, 'invoice: failed')).toContain(style.red('failed'));
    expect(paintLine(style, 'new-offer: unchanged')).toBe(`new-offer: ${style.dim('unchanged')}`);
    expect(paintLine(style, 'pulled.html: x')).toBe('pulled.html: x');
  });

  it('colours the tag of a finding and dims its code', () => {
    const line = paintLine(style, 'error  a.html:1:1  Broken  [broken-thing]');
    expect(line.startsWith(style.red('error'))).toBe(true);
    expect(line.endsWith(style.dim('[broken-thing]'))).toBe(true);
  });
});

describe('Progress', () => {
  it('draws position, item, stage and time, and erases itself', () => {
    let now = 0;
    const written: string[] = [];
    const progress = new Progress({ terminal: { write: (t) => written.push(t), columns: 200 }, style: plain, unicode: false, total: 19, now: () => now });
    for (let i = 0; i < 14; i++) progress.advance();
    progress.step('roof-configuration-mds', 'publishing');
    now = 2500;
    expect(progress.line()).toMatch(/^. 15\/19 roof-configuration-mds - publishing 2\.5s$/);
    now = 12_000;
    expect(progress.line()).toContain('the API has not answered yet');
    progress.stop();
    expect(written.at(-1)).toBe(`\r${ESC}[2K`);
    progress.stop();
  });

  it('draws nothing without a terminal', () => {
    const progress = new Progress({ terminal: null, style: plain, unicode: true, total: 2 });
    progress.step('a', 'pushing');
    progress.stop();
  });

  it('cuts the line to the terminal width without counting colours', () => {
    const style = createStyle(true);
    const cut = truncate(`${style.bold('a-very-long-template-name')} ${style.dim('publishing 12.0s')}`, 20);
    expect([...strip(cut)].length).toBeLessThanOrEqual(19);
    expect(strip(cut).endsWith('…')).toBe(true);
    expect(truncate('short', 80)).toBe('short');
  });
});

describe('startRun', () => {
  it('prints each result when it is done and a summary at the end', () => {
    const out: string[] = [];
    const run = startRun<{ slug: string }>(printer(false, { out: (t) => out.push(t), err: () => undefined }), 2);
    run.step('a', 'pushing');
    run.done({ slug: 'a' }, ['a: v1 draft']);
    expect(out).toEqual(['a: v1 draft']);
    run.done({ slug: 'b' }, ['b: unchanged']);
    run.finish(run.results, '2 templates: 1 draft, 1 unchanged');
    expect(out[1]).toBe('b: unchanged');
    expect(out[2]).toMatch(/^2 templates: 1 draft, 1 unchanged in \d/);
  });

  it('keeps --json to one document', () => {
    const out: string[] = [];
    const run = startRun<{ slug: string }>(printer(true, { out: (t) => out.push(t), err: () => undefined }), 2);
    run.done({ slug: 'a' }, ['a: v1 draft']);
    run.finish(run.results, 'ignored');
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual([{ slug: 'a' }]);
  });
});

describe('helpers', () => {
  it('formats durations and tallies statuses', () => {
    expect(formatElapsed(420)).toBe('420ms');
    expect(formatElapsed(2500)).toBe('2.5s');
    expect(formatElapsed(125_000)).toBe('2m 05s');
    expect(tally(['published', 'unchanged', 'published'])).toBe('2 published, 1 unchanged');
  });
});

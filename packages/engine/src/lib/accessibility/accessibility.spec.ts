import {
  ACCESSIBILITY_HEADER_LENGTH,
  ACCESSIBILITY_MAX_ELEMENTS,
  ACCESSIBILITY_MAX_FAILURES,
  AUDIT_CODES,
  AUDIT_RULES,
  AUDIT_SEVERITY,
  AUDIT_TITLES,
  accessibilityHeader,
  accessibilityHeaderValue,
  accessibilityResult,
  auditMessage,
  isUaSetting,
  resolveUa,
  type AccessibilityResult,
  type AuditFinding,
  type ValidatorVerdict,
} from './index';
import { staticAudit } from './static';

const finding = (
  code: AuditFinding['code'],
  snippet = '',
  args: AuditFinding['args'] = {},
): AuditFinding => ({
  code,
  severity: AUDIT_SEVERITY[code],
  src: null,
  snippet,
  args,
});

describe('resolveUa', () => {
  it('reads true as strict: the claim needs the proof', () => {
    expect(resolveUa(true)).toEqual({ check: 'strict' });
    expect(resolveUa({})).toEqual({ check: 'strict' });
    expect(resolveUa({ check: 'strict' })).toEqual({ check: 'strict' });
    expect(resolveUa({ check: 'report' })).toEqual({ check: 'report' });
  });

  it('is off for anything that is no declaration', () => {
    for (const off of [false, null, undefined, 0, '', 'true', []])
      expect(resolveUa(off)).toBeNull();
  });

  it('knows what the API takes', () => {
    for (const ok of [true, false, null, {}, { check: 'report' }])
      expect(isUaSetting(ok)).toBe(true);
    for (const bad of ['strict', 1, [], { check: 'warn' }, { mode: 'strict' }])
      expect(isUaSetting(bad)).toBe(false);
  });
});

describe('the audit’s codes', () => {
  it('have a severity, rules, a title and a sentence each', () => {
    for (const code of AUDIT_CODES) {
      expect(AUDIT_SEVERITY[code]).toMatch(/^(error|warning)$/);
      expect(Array.isArray(AUDIT_RULES[code])).toBe(true);
      expect(AUDIT_TITLES[code].length).toBeGreaterThan(8);
      const sentence = auditMessage(
        finding(code, '', {
          tag: 'canvas',
          level: 3,
          previous: 1,
          text: 'x',
          part: 'footer',
          first: 3,
          other: 2,
        }),
      );
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence).not.toContain('undefined');
    }
  });

  it('call an error only what a rule fails for', () => {
    for (const code of AUDIT_CODES)
      expect(AUDIT_RULES[code].length > 0, code).toBe(
        AUDIT_SEVERITY[code] === 'error',
      );
  });

  it('say which heading is wrong, and what it should be', () => {
    expect(
      auditMessage(finding('heading-order', '<h3>', { level: 3, previous: 1 })),
    ).toBe(
      'This h3 follows an h1, so a heading level is skipped. Make it an h2 and size it with CSS.',
    );
    expect(
      auditMessage(finding('heading-order', '<h2>', { level: 2, previous: 0 })),
    ).toBe(
      'The first heading is an h2. Start with an h1 and size it with CSS.',
    );
  });
});

describe('accessibilityResult', () => {
  const verdict = (
    failures: ValidatorVerdict['failures'],
  ): ValidatorVerdict => ({
    validator: 'veraPDF 1.30.2',
    compliant: failures.length === 0,
    rules: { passed: 106 - failures.length, failed: failures.length },
    failures,
  });

  it('is the validator’s word, with the warnings the audit adds', () => {
    const result = accessibilityResult({ check: 'strict' }, verdict([]), [
      finding('running-text', '<div>', {
        text: 'DE36 0000 0000 0000 0000 00',
        part: 'footer',
      }),
      finding('running-text', '<div>', { text: 'HRB 00000', part: 'footer' }),
      finding('table-headers', '<table class="lines">'),
    ]);
    expect(result).toEqual({
      standard: 'PDF/UA-1',
      check: 'strict',
      conformant: true,
      validator: 'veraPDF 1.30.2',
      rules: { passed: 106, failed: 0 },
      failures: [],
      warnings: [
        {
          code: 'running-text',
          count: 2,
          elements: ['DE36 0000 0000 0000 0000 00', 'HRB 00000'],
        },
        {
          code: 'table-headers',
          count: 1,
          elements: ['<table class="lines">'],
        },
      ],
    });
    expect(accessibilityHeader(result)).toBe('conformant');
  });

  it('joins the audit’s elements to the rule they fail', () => {
    const result = accessibilityResult(
      { check: 'report' },
      verdict([
        { rule: '7.3-1', description: 'Figure tags shall include…', checks: 3 },
        {
          rule: '7.2-20',
          description: 'LI shall  hold\n only Lbl and LBody',
          checks: 1,
        },
      ]),
      [
        finding('image-alt', '<img src="a.png">'),
        finding('figure-name', '<canvas data-ff-chart="…">', { tag: 'canvas' }),
        finding('image-alt', '<img src="a.png">'),
        finding('link-name', '<a href="#">'),
      ],
    );
    expect(result.conformant).toBe(false);
    expect(accessibilityHeader(result)).toBe('not-conformant');
    expect(result.failures).toEqual([
      {
        rule: '7.3-1',
        code: 'image-alt',
        // the rule and its count are the validator's, the sentence and the elements the audit's
        count: 3,
        message:
          'The image has no alt attribute. Say what it shows, or write alt="" if it is decoration.',
        elements: ['<img src="a.png">', '<canvas data-ff-chart="…">'],
      },
      {
        rule: '7.2-20',
        count: 1,
        // no finding of ours explains it: the validator's own sentence
        message: 'LI shall hold only Lbl and LBody',
        elements: [],
      },
    ]);
    expect(result.warnings).toEqual([
      { code: 'link-name', count: 1, elements: ['<a href="#">'] },
    ]);
  });

  it('keeps no more than a row of every list can carry', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      rule: `7.1-${i + 1}`,
      description: 'x',
      checks: 1,
    }));
    const images = Array.from({ length: 9 }, (_, i) =>
      finding('image-alt', `<img src="${i}.png">`),
    );
    const result = accessibilityResult(
      { check: 'strict' },
      verdict([{ rule: '7.3-1', description: 'x', checks: 9 }, ...many]),
      images,
    );
    expect(result.failures).toHaveLength(ACCESSIBILITY_MAX_FAILURES);
    expect(result.failures[0]!.elements).toHaveLength(
      ACCESSIBILITY_MAX_ELEMENTS,
    );
    expect(result.truncated).toBe(true);
  });
});

describe('accessibilityHeaderValue', () => {
  const report = (failures: number, elements: number): AccessibilityResult => ({
    standard: 'PDF/UA-1',
    check: 'report',
    conformant: failures === 0,
    validator: 'veraPDF 1.30.2',
    rules: { passed: 106 - failures, failed: failures },
    failures: Array.from({ length: failures }, (_, i) => ({
      rule: `7.1-${i + 1}`,
      code: 'image-alt' as const,
      count: elements,
      message:
        'The image has no alt attribute. Say what it shows, or write alt="" if it is decoration.',
      elements: Array.from(
        { length: elements },
        (_, n) => `<img src="${'bild-'.repeat(20)}${n}.png" class="größe">`,
      ),
    })),
    warnings: [
      { code: 'running-text', count: 1, elements: ['Fennlor Studio GmbH'] },
    ],
  });
  const read = (value: string) =>
    JSON.parse(decodeURIComponent(value)) as AccessibilityResult;

  it('carries a report as it is where it fits, in ASCII', () => {
    const value = accessibilityHeaderValue(report(2, 2));
    expect(value).toMatch(/^[\x21-\x7e]+$/);
    expect(read(value)).toEqual(report(2, 2));
  });

  it('gives up elements before failures, and says that it did', () => {
    const long = report(8, 5);
    const value = accessibilityHeaderValue(long);
    expect(value.length).toBeLessThanOrEqual(ACCESSIBILITY_HEADER_LENGTH);
    const cut = read(value);
    expect(cut.truncated).toBe(true);
    // every rule still arrives with its count and its sentence, and one element says where to look
    expect(cut.failures.map((failure) => failure.rule)).toEqual(
      long.failures.map((failure) => failure.rule),
    );
    expect(cut.failures[0]!.elements).toHaveLength(1);
    expect(cut.failures[0]!.count).toBe(5);
    expect(cut.rules).toEqual(long.rules);
  });

  it('always fits, down to the verdict alone', () => {
    const long = report(20, 5);
    for (const limit of [4000, 1500, 400]) {
      const value = accessibilityHeaderValue(long, limit);
      expect(value.length).toBeLessThanOrEqual(limit);
      expect(read(value)).toMatchObject({
        conformant: false,
        validator: 'veraPDF 1.30.2',
        rules: { passed: 86, failed: 20 },
        truncated: true,
      });
    }
  });
});

describe('staticAudit', () => {
  const run = (html: string, title: string | null = 'Rechnung', head = '') =>
    staticAudit({ engine: 'jinja2', html, head, title });

  it('asks for a title where neither the settings nor the head give one', () => {
    expect(run('<h1>A</h1>', '  ')).toMatchObject([
      { code: 'document-title', severity: 'error', src: null },
    ]);
    expect(
      run('<h1>A</h1>', null, '<title>{{ invoice.number }}</title>'),
    ).toEqual([]);
    expect(run('<h1>A</h1>')).toEqual([]);
  });

  it('finds an image written without alt, at its line and column', () => {
    const findings = run(
      '<h1>A</h1>\n  <img src="{{ brand.logos.primary }}" class="logo">\n<img src="b.png" alt="B">',
    );
    expect(findings).toEqual([
      {
        code: 'image-alt',
        severity: 'error',
        src: 'body:2:3',
        snippet: '<img src="{{ brand.logos.primary }}" class="logo">',
        args: {},
      },
    ]);
  });

  it('knows every way an image is named or kept out of the reading', () => {
    expect(
      run(
        '<img src="a.png" alt=""><img src="a.png" ALT="a"><img aria-label="a" src="a.png">' +
          '<img src="a.png" title="a"><img src="a.png" role="presentation"><img src="a.png" aria-hidden="true">' +
          "<img src='a.png' alt='{{ t(\"logo > alt\") }}'>",
      ),
    ).toEqual([]);
    expect(run('<img src="a.png" data-alt="x" class="alt">')).toHaveLength(1);
    expect(run('<img src="a.png" aria-hidden="false">')).toHaveLength(1);
  });

  it('says nothing where the template builds the attributes, and nothing of what is no tag', () => {
    expect(run('<img src="a.png" {{ attrs }}>')).toEqual([]);
    expect(
      run('<img src="a.png" {% if alt %}alt="{{ alt }}"{% endif %}>'),
    ).toEqual([]);
    expect(
      run(
        '<!-- <img src="a.png"> -->{# <img src="a.png"> #}{% raw %}<img src="a.png">{% endraw %}' +
          '<script>var s = "<img src=a.png>";</script><textarea><img src="a.png"></textarea>',
      ),
    ).toEqual([]);
  });

  it('reads each engine’s own syntax', () => {
    expect(
      staticAudit({
        engine: 'handlebars',
        html: '{{!-- <img src="a.png"> --}}<img src="{{logo}}">',
        title: 'x',
      }),
    ).toHaveLength(1);
    expect(
      staticAudit({
        engine: 'liquid',
        html: '{% comment %}<img src="a.png">{% endcomment %}<img src="{{ logo }}">',
        title: 'x',
      }),
    ).toHaveLength(1);
  });
});

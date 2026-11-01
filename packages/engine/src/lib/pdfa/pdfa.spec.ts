import { describe, expect, it } from 'vitest';
import {
  PDFA_MAX_MESSAGES,
  isPdfaResult,
  isPdfaSetting,
  pdfaFromEinvoice,
  pdfaHeaderValue,
  pdfaResult,
  pdfaStandard,
  resolvePdfa,
  type PdfaValidatorReport,
} from './index';
import * as main from '../../index';

const report = (
  overrides: Partial<PdfaValidatorReport> = {},
): PdfaValidatorReport => ({
  id: '4f6a1c2e-0000-4000-8000-000000000001',
  valid: true,
  pdfa: 'PDF/A-2b',
  validator: 'veraPDF 1.30.2',
  messages: [],
  versions: { verapdf: '1.30.2', pdfbox: '3.0.8' },
  ...overrides,
});

describe('pdf.pdfa', () => {
  it('takes a level, true for 3b, and nothing else', () => {
    expect(resolvePdfa('2b')).toBe('2b');
    expect(resolvePdfa('3b')).toBe('3b');
    expect(resolvePdfa(true)).toBe('3b');
    for (const off of [false, null, undefined, '1b', '3u', '2B', 3, {}, []])
      expect(resolvePdfa(off)).toBeNull();
  });

  it('knows which values are a declaration', () => {
    for (const value of ['2b', '3b', true, false, null])
      expect(isPdfaSetting(value)).toBe(true);
    for (const value of ['1b', '4', 'PDF/A-2b', 2, {}, { level: '2b' }, []])
      expect(isPdfaSetting(value)).toBe(false);
  });

  it('names the standard of a level', () => {
    expect(pdfaStandard('2b')).toBe('PDF/A-2b');
    expect(pdfaStandard('3b')).toBe('PDF/A-3b');
  });

  it('is exported from the main entry too, for the app and the published package', () => {
    expect(main.resolvePdfa).toBe(resolvePdfa);
    expect(main.pdfaResult).toBe(pdfaResult);
    expect(main.PDFA_REFUSALS.password).toContain('post.password');
  });
});

describe('the report', () => {
  it('is the sidecar report with the hash of the file it judged', () => {
    expect(pdfaResult('2b', report(), 'ab'.repeat(32))).toEqual({
      standard: 'PDF/A-2b',
      conformant: true,
      validator: 'veraPDF 1.30.2',
      id: '4f6a1c2e-0000-4000-8000-000000000001',
      versions: { verapdf: '1.30.2', pdfbox: '3.0.8' },
      pdf_sha256: 'ab'.repeat(32),
      messages: [],
    });
  });

  it('keeps the findings of a file that failed, errors first and capped', () => {
    const messages = [
      ...Array.from({ length: PDFA_MAX_MESSAGES }, (_, i) => ({
        severity: 'warning',
        rule: `6.1.${i}-1`,
        message: 'a warning',
        location: null,
      })),
      {
        severity: 'error',
        rule: '6.2.11.4.1-1',
        message: 'The font program is not embedded',
        location: 'root/document[0]/pages[0]/font[0](Helvetica)',
      },
    ];
    const result = pdfaResult(
      '3b',
      report({ valid: false, pdfa: 'PDF/A-3b', messages }),
      null,
    );
    expect(result.standard).toBe('PDF/A-3b');
    expect(result.conformant).toBe(false);
    expect(result.pdf_sha256).toBeNull();
    expect(result.messages).toHaveLength(PDFA_MAX_MESSAGES);
    expect(result.messages[0]?.rule).toBe('6.2.11.4.1-1');
    expect(result.truncated).toBe(true);
  });

  it('is made from an e-invoice validation, which judged a PDF/A-3b', () => {
    expect(
      pdfaFromEinvoice({
        valid: false,
        schematron: 'Factur-X 1.09.2 (Mustang 2.26.0)',
        pdfa: 'PDF/A-3b',
        messages: [
          {
            part: 'xml',
            severity: 'error',
            rule: 'BR-CO-15',
            message: 'total',
            location: '/rsm:CrossIndustryInvoice',
          },
          {
            part: 'pdf',
            severity: 'error',
            rule: '6.2.11.4.1-1',
            message: 'not embedded',
            location: 'font',
          },
        ],
        id: 'r1',
        versions: { mustang: '2.26.0', verapdf: '1.30.2', pdfbox: '3.0.8' },
        xml_sha256: 'x',
        pdf_sha256: 'p',
      }),
    ).toEqual({
      standard: 'PDF/A-3b',
      conformant: false,
      validator: 'veraPDF 1.30.2',
      id: 'r1',
      versions: { mustang: '2.26.0', verapdf: '1.30.2', pdfbox: '3.0.8' },
      pdf_sha256: 'p',
      messages: [
        {
          severity: 'error',
          rule: '6.2.11.4.1-1',
          message: 'not embedded',
          location: 'font',
        },
      ],
    });
    // the XML failed before there was a file: nothing to say about PDF/A
    expect(
      pdfaFromEinvoice({
        valid: false,
        schematron: 's',
        pdfa: null,
        messages: [],
      }),
    ).toBeNull();
    expect(pdfaFromEinvoice(null)).toBeNull();
  });

  it('is told apart from what is no report', () => {
    expect(isPdfaResult(pdfaResult('2b', report(), 'h'))).toBe(true);
    expect(isPdfaResult({ standard: 'PDF/A-1b', conformant: true })).toBe(
      false,
    );
    expect(isPdfaResult({ standard: 'PDF/A-2b' })).toBe(false);
    expect(isPdfaResult('PDF/A-2b')).toBe(false);
    expect(isPdfaResult(null)).toBe(false);
  });

  it('travels in a header percent-encoded, and short', () => {
    const result = pdfaResult('2b', report(), 'h');
    expect(JSON.parse(decodeURIComponent(pdfaHeaderValue(result)))).toEqual(
      result,
    );
    const long = pdfaResult(
      '2b',
      report({
        messages: Array.from({ length: 40 }, () => ({
          severity: 'warning',
          rule: '6.1.3-1',
          message: 'ü'.repeat(100),
          location: null,
        })),
      }),
      'h',
    );
    const value = pdfaHeaderValue(long);
    expect(value.length).toBeLessThanOrEqual(2000);
    expect(JSON.parse(decodeURIComponent(value))).toMatchObject({
      standard: 'PDF/A-2b',
      conformant: true,
      messages: [],
      truncated: true,
    });
  });
});

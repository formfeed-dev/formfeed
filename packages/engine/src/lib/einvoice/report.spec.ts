import {
  EINVOICE_HEADER_LENGTH,
  EINVOICE_MAX_MESSAGES,
  capMessages,
  einvoiceHeaderValue,
  einvoiceResult,
  invoiceLineOf,
  type EinvoiceMessage,
  type EinvoiceResult,
} from './report';

const message = (
  severity: EinvoiceMessage['severity'],
  rule: string,
): EinvoiceMessage => ({
  part: 'xml',
  severity,
  rule,
  message: rule,
  location: null,
});

describe('capMessages', () => {
  it('keeps a short report as it is, errors first', () => {
    const report = capMessages([
      message('warning', 'W-1'),
      message('error', 'E-1'),
    ]);
    expect(report.messages.map((m) => m.rule)).toEqual(['E-1', 'W-1']);
    expect(report.truncated).toBeUndefined();
  });

  it('cuts a long report and says so, without losing an error to the warnings before it', () => {
    const many = [
      ...Array.from({ length: EINVOICE_MAX_MESSAGES + 10 }, (_, index) =>
        message('warning', `W-${index}`),
      ),
      message('error', 'E-last'),
    ];
    const report = capMessages(many);
    expect(report.messages).toHaveLength(EINVOICE_MAX_MESSAGES);
    expect(report.truncated).toBe(true);
    expect(report.messages[0]?.rule).toBe('E-last');
  });
});

describe('einvoiceResult', () => {
  it('names the options, the release, the report and what the PDF shows', () => {
    const result = einvoiceResult(
      { profile: 'en16931', flavour: 'zugferd' },
      '2.5',
      {
        valid: true,
        schematron: 'rules',
        pdfa: 'PDF/A-3b',
        messages: [],
      },
      {
        checked: ['BT-1', 'BT-112'],
        missing: ['BT-1'],
        values: [],
      },
    );
    expect(result).toEqual({
      profile: 'en16931',
      flavour: 'zugferd',
      spec_version: '2.5',
      validation: {
        valid: true,
        schematron: 'rules',
        pdfa: 'PDF/A-3b',
        messages: [],
      },
      display: { checked: ['BT-1', 'BT-112'], missing: ['BT-1'] },
    });
  });

  it('keeps what judged the file and the hashes of what it judged', () => {
    const proof = {
      id: 'b6f7c1d2',
      versions: { mustang: '2.26.0', verapdf: '1.30.2', pdfbox: '3.0.8' },
      xml_sha256: 'a'.repeat(64),
      pdf_sha256: 'b'.repeat(64),
    };
    const result = einvoiceResult(
      { profile: 'en16931', flavour: 'factur-x' },
      '1.09',
      {
        valid: true,
        schematron: 'rules',
        pdfa: 'PDF/A-3b',
        messages: [],
        ...proof,
      },
      null,
    );
    expect(result.validation).toEqual({
      valid: true,
      schematron: 'rules',
      pdfa: 'PDF/A-3b',
      messages: [],
      ...proof,
    });
    // a refusal before the conversion names the XML only
    const refused = einvoiceResult(
      { profile: 'en16931', flavour: 'factur-x' },
      '1.09',
      {
        valid: false,
        schematron: 'rules',
        pdfa: null,
        messages: [],
        xml_sha256: proof.xml_sha256,
        pdf_sha256: null,
      },
      null,
    );
    expect(refused.validation).toMatchObject({
      xml_sha256: proof.xml_sha256,
      pdf_sha256: null,
    });
  });

  it('has neither report nor display before the validator answered', () => {
    expect(
      einvoiceResult(
        { profile: 'basic', flavour: 'factur-x' },
        '1.09',
        null,
        null,
      ),
    ).toMatchObject({ validation: null, display: null });
  });
});

describe('einvoiceHeaderValue', () => {
  /** An XRechnung-sized report: fifty long German warnings of BR-DE rules, each with its place. */
  const report = (errors: number): EinvoiceResult => ({
    profile: 'en16931',
    flavour: 'zugferd',
    spec_version: '2.5',
    validation: {
      valid: errors === 0,
      schematron: 'Factur-X 1.09.2 (Mustang 2.26.0)',
      pdfa: 'PDF/A-3b',
      messages: Array.from({ length: 50 }, (_, i) => ({
        part: 'xml' as const,
        severity: i < errors ? ('error' as const) : ('warning' as const),
        rule: `BR-DE-${10 + (i % 20)}`,
        message:
          'Das Element „Buyer reference“ (BT-10) soll übermittelt werden; für Rechnungen an öffentliche Auftraggeber ist die Leitweg-ID anzugeben, die der Auftraggeber übermittelt hat.',
        location: `/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/ram:IncludedSupplyChainTradeLineItem[${i + 1}]/ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax`,
      })),
      id: '6d3e1f20-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      versions: { mustang: '2.26.0', verapdf: '1.30.2', pdfbox: '3.0.8' },
      xml_sha256: '1a2b'.padEnd(64, '0'),
      pdf_sha256: '3c4d'.padEnd(64, '0'),
    },
    display: { checked: ['BT-1', 'BT-109', 'BT-110', 'BT-112'], missing: [] },
  });
  const read = (value: string) =>
    JSON.parse(decodeURIComponent(value)) as EinvoiceResult;

  it('keeps a report that fits as it is', () => {
    const small: EinvoiceResult = {
      ...report(0),
      validation: { ...report(0).validation!, messages: [] },
    };
    expect(read(einvoiceHeaderValue(small))).toEqual(small);
  });

  it('fits fifty long German warnings, keeping everything that makes it a verdict (plan 25 §5.5)', () => {
    const value = einvoiceHeaderValue(report(0));
    expect(
      encodeURIComponent(JSON.stringify(report(0))).length,
    ).toBeGreaterThan(EINVOICE_HEADER_LENGTH);
    expect(value.length).toBeLessThanOrEqual(EINVOICE_HEADER_LENGTH);
    const header = read(value);
    const { messages, truncated, ...kept } = header.validation!;
    const { messages: _all, ...whole } = report(0).validation!;
    void _all;
    expect(kept).toEqual(whole);
    expect(truncated).toBe(true);
    expect(header.display).toEqual(report(0).display);
    // places went first, then warnings from the last
    expect(messages.every((message) => message.location === null)).toBe(true);
    expect(messages.length).toBeLessThan(50);
    expect(messages.map((message) => message.rule)).toEqual(
      report(0)
        .validation!.messages.slice(0, messages.length)
        .map((message) => message.rule),
    );
  });

  it('gives up warnings before errors, and fits a smaller room too', () => {
    const header = read(einvoiceHeaderValue(report(3), 2000));
    expect(
      encodeURIComponent(JSON.stringify(header)).length,
    ).toBeLessThanOrEqual(2000);
    const severities = header.validation!.messages.map((m) => m.severity);
    expect(severities.slice(0, 3)).toEqual(['error', 'error', 'error']);
    expect(header.validation!.valid).toBe(false);
  });
});

describe('invoiceLineOf', () => {
  it('reads the line a finding is in off its XPath', () => {
    expect(
      invoiceLineOf(
        '/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/ram:IncludedSupplyChainTradeLineItem[2]/ram:SpecifiedLineTradeDelivery/ram:BilledQuantity',
      ),
    ).toBe(2);
    expect(
      invoiceLineOf(
        '/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeSettlement',
      ),
    ).toBeNull();
    expect(invoiceLineOf(null)).toBeNull();
  });
});

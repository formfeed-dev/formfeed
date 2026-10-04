import {
  EINVOICE_MAX_MESSAGES,
  capMessages,
  einvoiceResult,
  invoiceLineOf,
  type EinvoiceMessage,
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

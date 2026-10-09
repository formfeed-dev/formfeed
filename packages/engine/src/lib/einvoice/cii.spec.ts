import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CII_GUIDELINES,
  checkInvoice,
  einvoiceXml,
  invoiceSkeleton,
  invoiceToCii,
  type EinvoiceProfile,
} from './index';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8'));

/**
 * The golden files. Each `fixtures/<name>.<profile>.xml` is what the mapper writes for
 * `fixtures/<name>.json`, and the sidecar's `check` target holds every one of them against the
 * official XSD and schematron: a change here that the validator refuses fails there, not in
 * production. Update them with `vitest -u` and read the diff.
 */
const golden: Array<[name: string, profiles: EinvoiceProfile[]]> = [
  ['simple', ['en16931', 'basic']],
  ['multi-rate', ['en16931', 'basic']],
  ['credit-note', ['en16931']],
  ['reverse-charge', ['en16931']],
  ['intra-community', ['en16931']],
  ['allowance-charge', ['en16931', 'basic']],
  ['rounding', ['en16931']],
  ['foreign-currency', ['en16931']],
  ['france-domestic', ['en16931']],
  ['small-business', ['en16931']],
];

describe('invoiceToCii', () => {
  for (const [name, profiles] of golden)
    for (const profile of profiles)
      it(`writes ${name} as ${profile}`, async () => {
        const check = checkInvoice(fixture(name), { profile });
        expect(check.problems).toEqual([]);
        if (!check.ok) return;
        await expect(
          invoiceToCii(check.invoice, { profile }),
        ).toMatchFileSnapshot(`./fixtures/${name}.${profile}.xml`);
      });

  it('names the profile it is written in', () => {
    const check = checkInvoice(fixture('simple'));
    if (!check.ok) throw new Error('fixture');
    expect(invoiceToCii(check.invoice, { profile: 'en16931' })).toContain(
      `<ram:ID>${CII_GUIDELINES.en16931}</ram:ID>`,
    );
    expect(invoiceToCii(check.invoice, { profile: 'basic' })).toContain(
      '<ram:ID>urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic</ram:ID>',
    );
  });

  it('leaves out of basic what only en16931 carries', () => {
    const check = checkInvoice(fixture('multi-rate'));
    if (!check.ok) throw new Error('fixture');
    const full = invoiceToCii(check.invoice, { profile: 'en16931' });
    const basic = invoiceToCii(check.invoice, { profile: 'basic' });
    for (const element of [
      'ram:DefinedTradeContact',
      'ram:SellerAssignedID',
      'ram:Description>Gebundene Ausgabe',
      'ram:AccountName',
      'ram:BICID',
      'ram:ReceivableSpecifiedTradeAccountingAccount',
    ]) {
      expect(full).toContain(element);
      expect(basic).not.toContain(element);
    }
    // what both carry is the same text
    expect(basic).toContain(
      '<ram:GrandTotalAmount>1529.81</ram:GrandTotalAmount>',
    );
  });

  it('writes the same bytes for the same invoice, however its numbers were typed', () => {
    const typed = fixture('simple') as Record<string, unknown> & {
      totals: Record<string, unknown>;
    };
    const asText = structuredClone(typed);
    asText.totals = {
      line_net: '3160.00',
      tax_basis: '3160',
      tax_total: '600.40',
      grand: '3760.4',
      due: '3760.40',
    };
    const a = einvoiceXml({ _invoice: typed }, { profile: 'en16931' });
    const b = einvoiceXml({ _invoice: asText }, { profile: 'en16931' });
    expect(a.ok && b.ok && a.xml === b.xml).toBe(true);
  });

  it('writes amounts with two decimals and nothing the invoice does not state', () => {
    const check = checkInvoice(fixture('reverse-charge'));
    if (!check.ok) throw new Error('fixture');
    const xml = invoiceToCii(check.invoice, { profile: 'en16931' });
    expect(xml).toContain('<ram:CalculatedAmount>0.00</ram:CalculatedAmount>');
    expect(xml).toContain(
      '<ram:RateApplicablePercent>0</ram:RateApplicablePercent>',
    );
    expect(xml).toContain(
      '<ram:ExemptionReasonCode>VATEX-EU-AE</ram:ExemptionReasonCode>',
    );
    // No empty element, which the profiles' rules warn about, except the one the schema demands:
    // this invoice states a period and no delivery.
    expect(xml.match(/<[a-z]+:[A-Za-z]+\/>/g)).toEqual([
      '<ram:ApplicableHeaderTradeDelivery/>',
    ]);
    expect(xml).not.toMatch(/<([a-z]+:[A-Za-z]+)[^>]*><\/\1>/);
  });

  it('escapes what XML reserves and drops what it cannot carry', () => {
    const data = fixture('simple') as {
      note?: string;
      buyer: { name: string };
    };
    data.buyer.name = 'Olvarest & Söhne <GmbH>';
    data.note = `Tab\tand${String.fromCharCode(0)}null${String.fromCharCode(0xb)}`;
    const check = checkInvoice(data);
    if (!check.ok) throw new Error(JSON.stringify(check.problems));
    const xml = invoiceToCii(check.invoice, { profile: 'en16931' });
    expect(xml).toContain(
      '<ram:Name>Olvarest &amp; Söhne &lt;GmbH&gt;</ram:Name>',
    );
    expect(xml).toContain('<ram:Content>Tab\tandnull</ram:Content>');
  });

  it("carries a French invoice's four statements, in the one profile France takes", () => {
    const result = einvoiceXml(
      { _invoice: fixture('france-domestic') },
      { profile: 'en16931' },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    // the buyer's SIREN, the delivery address, the billing framework, VAT on debits
    expect(result.xml).toContain('<ram:ID schemeID="0002">000000018</ram:ID>');
    expect(result.xml).toContain('<ram:ShipToTradeParty>');
    expect(result.xml).toMatch(
      /<ram:BusinessProcessSpecifiedDocumentContextParameter>\s*<ram:ID>S1<\/ram:ID>/,
    );
    expect(result.xml).toContain(
      '<ram:DueDateTypeCode>5</ram:DueDateTypeCode>',
    );
    // basic would carry them too, but the French reform does not accept that profile
    const basic = einvoiceXml(
      { _invoice: fixture('france-domestic') },
      { profile: 'basic' },
    );
    expect(basic.ok).toBe(false);
    if (!basic.ok)
      expect(basic.problems.map((problem) => problem.code)).toEqual([
        'fr_profile',
      ]);
  });
});

describe('einvoiceXml', () => {
  it('builds the XML of the skeleton the editor inserts', () => {
    const result = einvoiceXml(
      { _invoice: invoiceSkeleton('2026-03-02') },
      { profile: 'en16931' },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.invoice.number).toBe('RE-2026-0001');
    expect(result.invoice.payment?.due_date).toBe('2026-03-16');
    expect(
      result.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'),
    ).toBe(true);
  });

  it('says so when the data has no _invoice block', () => {
    for (const data of [
      {},
      { invoice: {} },
      { _invoice: null },
      null,
      'text',
    ]) {
      const result = einvoiceXml(data, { profile: 'en16931' });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.problems[0]?.message).toContain('no _invoice block');
    }
  });
});

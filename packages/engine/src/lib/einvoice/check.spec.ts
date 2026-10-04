import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkInvoice, invoiceSkeleton, type InvoiceProblem } from './index';

const fixtures = join(__dirname, 'fixtures');
const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8'));

/** The findings of an invoice changed from a valid one, so each test shows exactly what it broke. */
function problemsOf(
  name: string,
  change: (invoice: Record<string, any>) => void,
  profile: 'basic' | 'en16931' = 'en16931',
): InvoiceProblem[] {
  const invoice = fixture(name);
  change(invoice);
  return checkInvoice(invoice, { profile }).problems;
}
const rulesOf = (problems: InvoiceProblem[]): Array<string | undefined> =>
  problems.map((problem) => problem.rule);

describe('checkInvoice', () => {
  it('accepts every fixture, and the skeleton', () => {
    const names = readdirSync(fixtures)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''));
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names)
      expect(checkInvoice(fixture(name)).problems, name).toEqual([]);
    expect(checkInvoice(invoiceSkeleton()).problems).toEqual([]);
  });

  it('returns the invoice with exact decimals and its defaults', () => {
    const check = checkInvoice(fixture('multi-rate'));
    if (!check.ok) throw new Error('fixture');
    const { invoice } = check;
    expect(invoice.type_code).toBe('380');
    // a number and a string for the same amount are the same amount
    expect(invoice.lines[0]?.net_amount).toBe('89.7');
    expect(invoice.lines[2]?.net_amount).toBe('4.9');
    expect(invoice.lines[0]?.unit_code).toBe('C62');
    expect(invoice.payment?.means_code).toBe('58');
    expect(invoice.notes).toEqual([{ text: 'Vielen Dank für Ihren Auftrag.' }]);
    expect(invoice.totals.grand).toBe('1529.81');
  });

  it('takes arithmetic noise off a number, and nothing off a string', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in every language that sends JSON
    const noisy = problemsOf('simple', (invoice) => {
      invoice.lines[0].net_amount = 959.9 + 0.1;
      invoice.totals.tax_total = 600.3 + 0.1;
    });
    expect(noisy).toEqual([]);
    const typed = problemsOf('simple', (invoice) => {
      invoice.totals.tax_total = '600.400000000000004';
    });
    expect(typed.map((problem) => problem.code)).toEqual(['decimals']);
    expect(typed[0]?.path).toBe('totals.tax_total');
  });

  describe('what is missing', () => {
    it('names the field, the business term and the rule', () => {
      const problems = problemsOf('simple', (invoice) => {
        delete invoice.number;
        delete invoice.seller.address.country;
        delete invoice.totals.grand;
        delete invoice.lines[1].net_amount;
      });
      expect(
        problems.map((problem) => [problem.code, problem.path, problem.rule]),
      ).toEqual([
        ['missing', 'number', 'BR-02'],
        ['missing', 'seller.address.country', 'BR-09'],
        ['missing', 'lines[1].net_amount', 'BR-24'],
        ['missing', 'totals.grand', 'BR-14'],
      ]);
      expect(problems[0]?.message).toBe(
        '_invoice.number is missing (BT-1) (BR-02)',
      );
      expect(problems[2]?.args).toMatchObject({ term: 'BT-131' });
    });

    it('treats null like an absent field', () => {
      const problems = problemsOf('simple', (invoice) => {
        invoice.currency = null;
      });
      expect(problems.map((problem) => [problem.code, problem.rule])).toEqual([
        ['missing', 'BR-05'],
      ]);
    });

    it('asks for at least one line and one VAT breakdown', () => {
      const problems = problemsOf('simple', (invoice) => {
        invoice.lines = [];
        invoice.tax.breakdown = [];
      });
      expect(rulesOf(problems)).toEqual(['BR-16', 'BR-CO-18']);
    });

    it('says what is wrong with a value of the wrong kind', () => {
      const problems = problemsOf('simple', (invoice) => {
        invoice.issue_date = '10.09.2026';
        invoice.lines[0].tax.category = 'standard';
        invoice.seller.vat_on_debits = 'yes';
      });
      expect(problems.map((problem) => [problem.code, problem.path])).toEqual([
        ['invalid', 'issue_date'],
        ['invalid', 'seller.vat_on_debits'],
        ['invalid', 'lines[0].tax.category'],
      ]);
      expect(problems[0]?.message).toContain('YYYY-MM-DD');
    });
  });

  describe('totals', () => {
    it('refuses a total that does not add up, to the cent, and names the rule', () => {
      const problems = problemsOf('simple', (invoice) => {
        invoice.totals.grand = 3760;
        invoice.totals.due = 3760;
      });
      expect(rulesOf(problems)).toEqual(['BR-CO-15']);
      expect(problems[0]).toMatchObject({
        code: 'sum',
        path: 'totals.grand',
        args: { value: '3760.00', expected: '3760.40' },
      });
      expect(problems[0]?.message).toBe(
        '_invoice.totals.grand is 3760.00, but tax_basis plus tax_total is 3760.40 (BR-CO-15)',
      );
    });

    it('checks every sum the standard defines', () => {
      const one = (
        change: (invoice: Record<string, any>) => void,
      ): Array<string | undefined> =>
        rulesOf(problemsOf('allowance-charge', change));
      expect(one((i) => (i.lines[1].net_amount = 50.01))).toEqual([
        'BR-CO-10',
        'BR-S-08',
      ]);
      expect(one((i) => (i.totals.allowances = 10))).toEqual([
        'BR-CO-11',
        'BR-CO-13',
      ]);
      expect(one((i) => (i.totals.charges = 0))).toEqual([
        'BR-CO-12',
        'BR-CO-13',
      ]);
      expect(one((i) => (i.totals.tax_basis = 211.31))).toEqual([
        'BR-CO-13',
        'BR-CO-15',
      ]);
      expect(one((i) => (i.totals.tax_total = 40.16))).toEqual([
        'BR-CO-14',
        'BR-CO-15',
      ]);
      expect(one((i) => (i.totals.due = 251.45))).toEqual(['BR-CO-16']);
      // a wrong basis also no longer yields the stated VAT
      expect(one((i) => (i.tax.breakdown[0].basis = 212))).toEqual([
        'BR-S-08',
        'BR-CO-17',
      ]);
    });

    it('treats a total left out as zero, so an allowance needs its sum stated', () => {
      const problems = problemsOf('allowance-charge', (invoice) => {
        delete invoice.totals.allowances;
      });
      expect(rulesOf(problems)).toEqual(['BR-CO-11', 'BR-CO-13']);
    });

    it('accepts VAT rounded line by line, and no more than that', () => {
      // five lines: line by line the VAT is 0.27, on the total 0.25; both are honest
      expect(checkInvoice(fixture('rounding')).problems).toEqual([]);
      const total = problemsOf('rounding', (invoice) => {
        invoice.tax.breakdown[0].amount = 0.25;
        invoice.totals.tax_total = 0.25;
        invoice.totals.grand = 1.58;
        invoice.totals.due = 1.58;
      });
      expect(total).toEqual([]);
      // the standard's own tolerance is a whole euro, which would let this through
      const wrong = problemsOf('rounding', (invoice) => {
        invoice.tax.breakdown[0].amount = 0.3;
        invoice.totals.tax_total = 0.3;
        invoice.totals.grand = 1.63;
        invoice.totals.due = 1.63;
      });
      expect(rulesOf(wrong)).toEqual(['BR-CO-17']);
      expect(wrong[0]?.message).toContain('19 % of 1.33 is 0.25');
      const single = problemsOf('simple', (invoice) => {
        invoice.tax.breakdown[0].amount = 600.42;
        invoice.totals.tax_total = 600.42;
        invoice.totals.grand = 3760.42;
        invoice.totals.due = 3760.42;
      });
      expect(rulesOf(single)).toEqual(['BR-CO-17']);
    });

    it('refuses an amount finer than a cent, and a price finer than six places', () => {
      const problems = problemsOf('simple', (invoice) => {
        invoice.lines[0].net_amount = 960.001;
        invoice.lines[0].net_price = 0.1234567;
      });
      expect(
        problems.map((problem) => [
          problem.code,
          problem.path,
          problem.args['max'],
        ]),
      ).toEqual([
        ['decimals', 'lines[0].net_price', 6],
        ['decimals', 'lines[0].net_amount', 2],
      ]);
    });

    it('refuses a negative price and what is not a number', () => {
      const problems = problemsOf('simple', (invoice) => {
        invoice.lines[0].net_price = -120;
        invoice.lines[1].quantity = 'twenty';
      });
      expect(
        problems.map((problem) => [problem.code, problem.path, problem.rule]),
      ).toEqual([
        ['negative', 'lines[0].net_price', 'BR-27'],
        ['not_a_number', 'lines[1].quantity', undefined],
      ]);
    });
  });

  describe('the VAT breakdown', () => {
    it('wants one entry for every category and rate in use', () => {
      const problems = problemsOf('multi-rate', (invoice) => {
        invoice.tax.breakdown = [
          { category: 'S', rate: 19, basis: 1294.6, amount: 245.97 },
        ];
        invoice.totals.tax_total = 245.97;
        invoice.totals.grand = 1540.57;
        invoice.totals.due = 1540.57;
      });
      expect(problems.map((problem) => [problem.code, problem.rule])).toEqual([
        ['sum', 'BR-S-08'],
        ['breakdown_missing', 'BR-S-01'],
      ]);
      expect(problems[1]?.message).toContain(
        'category S at 7 %, which _invoice.lines[0] falls under',
      );
    });

    it('refuses the same category and rate twice', () => {
      const problems = problemsOf('simple', (invoice) => {
        invoice.tax.breakdown.push({
          category: 'S',
          rate: '19.0',
          basis: 0,
          amount: 0,
        });
      });
      expect(problems.map((problem) => problem.code)).toContain(
        'breakdown_duplicate',
      );
    });
  });

  describe('VAT categories', () => {
    it('S needs a rate above zero and a tax identifier of the seller', () => {
      const problems = problemsOf('simple', (invoice) => {
        delete invoice.seller.vat_id;
        invoice.lines[0].tax.rate = 0;
      });
      expect(problems.map((problem) => [problem.code, problem.rule])).toEqual(
        expect.arrayContaining([
          ['rate_positive', 'BR-S-05'],
          ['seller_tax_id_required', 'BR-S-02'],
        ]),
      );
      // the legal registration still identifies the seller, so BR-CO-26 holds
      expect(rulesOf(problems)).not.toContain('BR-CO-26');
    });

    it('a seller without a VAT ID may state the tax number instead', () => {
      const problems = problemsOf('simple', (invoice) => {
        delete invoice.seller.vat_id;
        invoice.seller.tax_number = '00/000/00000';
      });
      expect(problems).toEqual([]);
    });

    it('S and Z state no exemption reason; E, AE, K, G and O must', () => {
      const withReason = problemsOf('simple', (invoice) => {
        invoice.tax.breakdown[0].exemption_reason = 'none';
      });
      expect(withReason.map((problem) => [problem.code, problem.rule])).toEqual(
        [['exemption_reason_forbidden', 'BR-S-10']],
      );
      const without = problemsOf('small-business', (invoice) => {
        delete invoice.tax.breakdown[0].exemption_reason;
      });
      expect(without.map((problem) => [problem.code, problem.rule])).toEqual([
        ['exemption_reason_required', 'BR-E-10'],
      ]);
      const code = problemsOf('small-business', (invoice) => {
        delete invoice.tax.breakdown[0].exemption_reason;
        invoice.tax.breakdown[0].exemption_reason_code = 'VATEX-EU-132';
      });
      expect(code).toEqual([]);
    });

    it('every category but S carries a rate of 0 and no VAT', () => {
      const problems = problemsOf('reverse-charge', (invoice) => {
        invoice.lines[0].tax.rate = 20;
        invoice.tax.breakdown[0].rate = 20;
        invoice.tax.breakdown[0].amount = 760;
        invoice.totals.tax_total = 760;
        invoice.totals.grand = 4560;
        invoice.totals.due = 4560;
      });
      expect(problems.map((problem) => [problem.code, problem.rule])).toEqual([
        ['rate_zero', 'BR-AE-05'],
        ['rate_zero', 'BR-AE-05'],
        ['amount_zero', 'BR-AE-09'],
      ]);
    });

    it('reverse charge names the buyer by VAT ID or registration', () => {
      const problems = problemsOf('reverse-charge', (invoice) => {
        delete invoice.buyer.vat_id;
      });
      expect(problems.map((problem) => [problem.code, problem.rule])).toEqual([
        ['buyer_tax_id_required', 'BR-AE-02'],
      ]);
      expect(
        problemsOf('reverse-charge', (invoice) => {
          delete invoice.buyer.vat_id;
          invoice.buyer.legal_registration = 'FN 000000a';
        }),
      ).toEqual([]);
    });

    it('an intra-community supply names both VAT IDs, a delivery date and the country delivered to', () => {
      const problems = problemsOf('intra-community', (invoice) => {
        delete invoice.buyer.vat_id;
        delete invoice.delivery;
      });
      expect(
        problems.map((problem) => [problem.code, problem.path, problem.rule]),
      ).toEqual([
        ['buyer_tax_id_required', 'buyer.vat_id', 'BR-IC-02'],
        ['delivery_required', 'delivery.date', 'BR-IC-11'],
        ['delivery_required', 'delivery.address.country', 'BR-IC-12'],
      ]);
    });

    it('category O has no rate, stands alone, and names no VAT ID', () => {
      const outside = (invoice: Record<string, any>): void => {
        invoice.lines[0].tax = { category: 'O' };
        invoice.tax.breakdown[0] = {
          category: 'O',
          basis: 450,
          amount: 0,
          exemption_reason: 'Nicht steuerbar',
        };
      };
      expect(problemsOf('small-business', outside)).toEqual([]);
      const problems = problemsOf('small-business', (invoice) => {
        outside(invoice);
        invoice.lines[0].tax.rate = 0;
        invoice.seller.vat_id = 'DE000000000';
      });
      expect(problems.map((problem) => [problem.code, problem.rule])).toEqual([
        ['sum', 'BR-O-08'],
        ['breakdown_missing', 'BR-O-01'],
        ['rate_forbidden', 'BR-O-05'],
        ['vat_id_forbidden', 'BR-O-02'],
      ]);
    });
  });

  describe('codes', () => {
    it('checks country, currency, document type, unit and payment means against the lists of the release', () => {
      const problems = problemsOf('simple', (invoice) => {
        invoice.currency = 'Euro';
        invoice.type_code = 999;
        invoice.buyer.address.country = 'Deutschland';
        invoice.lines[0].unit_code = 'hours';
        invoice.lines[1].unit_code = 'crates';
        invoice.payment.means_code = 'SEPA';
      });
      expect(problems.map((problem) => [problem.path, problem.rule])).toEqual([
        ['buyer.address.country', 'BR-CL-14'],
        ['payment.means_code', 'BR-CL-16'],
        ['type_code', 'BR-CL-01'],
        ['currency', 'BR-CL-04'],
        ['lines[0].unit_code', 'BR-CL-23'],
        ['lines[1].unit_code', 'BR-CL-23'],
      ]);
      // what people write for an hour is known, so the answer says what to write instead
      const hours = problems.find(
        (problem) => problem.path === 'lines[0].unit_code',
      );
      expect(hours?.message).toContain('HUR is the code for it');
      expect(hours?.args['suggestion']).toBe('HUR');
    });

    it('takes codes in any case and writes them as the lists have them', () => {
      const check = checkInvoice({
        ...fixture('simple'),
        currency: 'eur',
        lines: fixture('simple')['lines'].map((line: Record<string, any>) => ({
          ...line,
          unit_code: 'hur',
        })),
      });
      if (!check.ok) throw new Error(JSON.stringify(check.problems));
      expect(check.invoice.currency).toBe('EUR');
      expect(check.invoice.lines[0]?.unit_code).toBe('HUR');
    });

    it('wants a VAT ID to begin with its country, and lets Greece write EL', () => {
      const problems = problemsOf('simple', (invoice) => {
        invoice.seller.vat_id = '000000000';
        invoice.buyer.vat_id = 'EL000000000';
      });
      expect(problems.map((problem) => [problem.path, problem.rule])).toEqual([
        ['seller.vat_id', 'BR-CO-09'],
      ]);
    });

    it('takes an e-mail address as an electronic address, and asks for the scheme of anything else', () => {
      const check = checkInvoice(fixture('simple'));
      if (!check.ok) throw new Error('fixture');
      expect(check.invoice.buyer.electronic_address).toEqual({
        value: 'eingang@olvarest.example',
        scheme: 'EM',
      });
      const problems = problemsOf('simple', (invoice) => {
        invoice.seller.electronic_address = '04011000-12345-06';
        invoice.buyer.electronic_address = {
          value: '000000018',
          scheme: 'siren',
        };
      });
      expect(
        problems.map((problem) => [problem.code, problem.path, problem.rule]),
      ).toEqual([
        ['scheme_required', 'seller.electronic_address', 'BR-62'],
        ['code_list', 'buyer.electronic_address.scheme', 'BR-CL-25'],
      ]);
    });

    it('checks an IBAN by its check digits and writes it without spaces', () => {
      const check = checkInvoice(fixture('simple'));
      if (!check.ok) throw new Error('fixture');
      expect(check.invoice.payment?.iban).toBe('DE36000000000000000000');
      const problems = problemsOf('simple', (invoice) => {
        invoice.payment.iban = 'DE00 0000 0000 0000 0000 00';
      });
      expect(problems.map((problem) => [problem.code, problem.path])).toEqual([
        ['iban', 'payment.iban'],
      ]);
    });
  });

  describe('dates', () => {
    it('refuses a date the calendar does not have, and a period that ends before it starts', () => {
      const problems = problemsOf('multi-rate', (invoice) => {
        invoice.issue_date = '2026-02-30';
        invoice.lines[1].period = { start: '2026-09-02', end: '2026-09-01' };
      });
      expect(
        problems.map((problem) => [problem.code, problem.path, problem.rule]),
      ).toEqual([
        ['date', 'issue_date', undefined],
        ['date_order', 'lines[1].period', 'BR-30'],
      ]);
    });
  });

  describe('payment and identification', () => {
    it('a credit transfer names the account', () => {
      const problems = problemsOf('simple', (invoice) => {
        delete invoice.payment.iban;
      });
      expect(
        problems.map((problem) => [problem.code, problem.path, problem.rule]),
      ).toEqual([['account_required', 'payment.iban', 'BR-61']]);
    });

    it('an account needs the payment means it belongs to', () => {
      const problems = problemsOf('simple', (invoice) => {
        delete invoice.payment.means_code;
      });
      expect(rulesOf(problems)).toEqual(['BR-49']);
    });

    it('an amount due needs a due date or payment terms', () => {
      const problems = problemsOf('simple', (invoice) => {
        delete invoice.payment;
      });
      expect(problems.map((problem) => [problem.code, problem.rule])).toEqual([
        ['due_or_terms_required', 'BR-CO-25'],
      ]);
      // nothing due, nothing to say about when
      const paid = problemsOf('simple', (invoice) => {
        delete invoice.payment;
        invoice.totals.prepaid = 3760.4;
        invoice.totals.due = 0;
      });
      expect(paid).toEqual([]);
    });

    it('the seller is identified by VAT ID, registration or an identifier', () => {
      const problems = problemsOf('small-business', (invoice) => {
        delete invoice.seller.id;
      });
      expect(problems.map((problem) => [problem.code, problem.rule])).toEqual([
        ['seller_identifier_required', 'BR-CO-26'],
      ]);
    });

    it('an accounting currency comes with its VAT total, and the other way round', () => {
      expect(
        rulesOf(
          problemsOf('foreign-currency', (invoice) => {
            delete invoice.totals.tax_total_accounting;
          }),
        ),
      ).toEqual(['BR-53']);
      expect(
        rulesOf(
          problemsOf('foreign-currency', (invoice) => {
            delete invoice.accounting_currency;
          }),
        ),
      ).toEqual(['BR-53']);
    });
  });

  describe('invoices between French businesses', () => {
    it('asks for both SIREN, the kind of operation and the VAT regime', () => {
      const problems = problemsOf('france-domestic', (invoice) => {
        delete invoice.seller.legal_registration;
        delete invoice.buyer.siren;
        delete invoice.operation;
        delete invoice.seller.vat_on_debits;
      });
      expect(
        problems.map((problem) => [problem.code, problem.path, problem.rule]),
      ).toEqual([
        ['fr_seller_siren', 'seller.legal_registration', 'BR-FR-10'],
        ['fr_buyer_siren', 'buyer.siren', 'BR-FR-11'],
        ['fr_operation', 'operation', 'BR-FR-08'],
        ['fr_vat_on_debits', 'seller.vat_on_debits', undefined],
      ]);
    });

    it('asks for none of it when one of the two is elsewhere', () => {
      const problems = problemsOf('simple', (invoice) => {
        invoice.buyer.address.country = 'FR';
      });
      expect(problems).toEqual([]);
    });

    it('takes the framework code as it is where the plain case does not fit', () => {
      const check = checkInvoice({
        ...fixture('france-domestic'),
        operation_code: 's2',
      });
      if (!check.ok) throw new Error(JSON.stringify(check.problems));
      expect(check.invoice.business_process).toBe('S2');
      const problems = problemsOf('france-domestic', (invoice) => {
        invoice.operation_code = 'X9';
      });
      expect(problems.map((problem) => [problem.code, problem.rule])).toEqual([
        ['code_list', 'BR-FR-08'],
      ]);
    });

    it("reads the buyer's SIREN as its legal registration, and refuses two that differ", () => {
      const check = checkInvoice(fixture('france-domestic'));
      if (!check.ok) throw new Error('fixture');
      expect(check.invoice.buyer.legal_registration).toEqual({
        value: '000000018',
        scheme: '0002',
      });
      const problems = problemsOf('france-domestic', (invoice) => {
        invoice.buyer.legal_registration = '000000026';
      });
      expect(problems.map((problem) => problem.code)).toEqual([
        'siren_mismatch',
      ]);
    });
  });

  describe('profiles', () => {
    it('basic cannot carry a rounding amount, en16931 can', () => {
      const rounded = (invoice: Record<string, any>): void => {
        invoice.totals.rounding = -0.4;
        invoice.totals.due = 3760;
      };
      expect(problemsOf('simple', rounded, 'en16931')).toEqual([]);
      const problems = problemsOf('simple', rounded, 'basic');
      expect(problems.map((problem) => [problem.code, problem.path])).toEqual([
        ['profile', 'totals.rounding'],
      ]);
    });
  });
});

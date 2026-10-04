import type { InvoiceInput } from './schema';

/**
 * A complete `_invoice` block with placeholder values, for a data set that has none yet: the editor
 * inserts it, and the docs show it. Every value is one to replace; it is valid as it stands, so the
 * first preview of a template that reads it renders, and passes the check.
 *
 * The names are the placeholders every published sample of ours uses. `issueDate` is a parameter
 * because the engine has no clock of its own.
 */
export function invoiceSkeleton(issueDate = '2026-01-15'): InvoiceInput {
  const due = new Date(`${issueDate}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + 14);
  const number = `RE-${issueDate.slice(0, 4)}-0001`;
  return {
    number,
    issue_date: issueDate,
    type_code: '380',
    currency: 'EUR',
    seller: {
      name: 'Fennlor Studio GmbH',
      vat_id: 'DE000000000',
      address: {
        street: 'Musterstraße 1',
        postcode: '12345',
        city: 'Musterstadt',
        country: 'DE',
      },
      contact: {
        name: 'Erika Mustermann',
        email: 'rechnung@fennlor.example',
        phone: '+49 30 0000000',
      },
    },
    buyer: {
      name: 'Olvarest GmbH',
      address: {
        street: 'Beispielweg 2',
        postcode: '54321',
        city: 'Beispielstadt',
        country: 'DE',
      },
    },
    delivery: { date: issueDate },
    lines: [
      {
        id: '1',
        name: 'Consulting',
        quantity: 8,
        unit_code: 'HUR',
        net_price: 120,
        net_amount: 960,
        tax: { category: 'S', rate: 19 },
      },
    ],
    tax: {
      breakdown: [{ category: 'S', rate: 19, basis: 960, amount: 182.4 }],
    },
    totals: {
      line_net: 960,
      tax_basis: 960,
      tax_total: 182.4,
      grand: 1142.4,
      due: 1142.4,
    },
    payment: {
      means_code: '58',
      iban: 'DE36000000000000000000',
      reference: number,
      terms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug',
      due_date: due.toISOString().slice(0, 10),
    },
  };
}

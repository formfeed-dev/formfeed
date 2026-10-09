/**
 * Which business terms of EN 16931 the `_invoice` block carries into the e-invoice, term by term
 * (spec 17 §4.3): the fields of the block each one is written from, or none where the block does
 * not carry it. The documentation's coverage page is generated from this list
 * (`apps/docs/scripts/gen-einvoice.ts`), and `coverage.spec.ts` holds it to the schema both ways, so
 * a field added to the block without its term fails there, and to what the profile `basic` leaves out.
 *
 * The 164 terms and their names are those of the English edition of EN 16931-1 (2017): BT-1 to BT-165,
 * the standard has no BT-4. The names were taken from KoSIT's XRechnung semantic model
 * (`itplr-kosit/xrechnung-visualization`, `src/xsd/xrechnung-semantic-model.xsd`, Apache-2.0), read on
 * 9 October 2026, without the terms XRechnung adds of its own.
 */

/** A business term of EN 16931 and what the `_invoice` block writes it from. */
export interface EinvoiceTerm {
  /** `BT-1` to `BT-165`. */
  term: string;
  /** Its name in the English edition of the standard. */
  name: string;
  /** Where the block takes it from, dotted, `[]` for every item of a list; empty where it does not. */
  fields: readonly string[];
  /** Written from an e-invoice option rather than a field of the block. */
  option?: 'profile';
  /** Written in the profile `en16931` only: `basic` leaves it out. */
  en16931Only?: true;
}

export const EN16931_TERMS: readonly EinvoiceTerm[] = [
  { term: 'BT-1', name: 'Invoice number', fields: ['number'] },
  { term: 'BT-2', name: 'Invoice issue date', fields: ['issue_date'] },
  { term: 'BT-3', name: 'Invoice type code', fields: ['type_code'] },
  { term: 'BT-5', name: 'Invoice currency code', fields: ['currency'] },
  {
    term: 'BT-6',
    name: 'VAT accounting currency code',
    fields: ['accounting_currency'],
  },
  { term: 'BT-7', name: 'Value added tax point date', fields: [] },
  {
    term: 'BT-8',
    name: 'Value added tax point date code',
    fields: ['seller.vat_on_debits'],
  },
  { term: 'BT-9', name: 'Payment due date', fields: ['payment.due_date'] },
  { term: 'BT-10', name: 'Buyer reference', fields: ['buyer_reference'] },
  { term: 'BT-11', name: 'Project reference', fields: [] },
  { term: 'BT-12', name: 'Contract reference', fields: ['contract_reference'] },
  {
    term: 'BT-13',
    name: 'Purchase order reference',
    fields: ['order_reference'],
  },
  { term: 'BT-14', name: 'Sales order reference', fields: [] },
  { term: 'BT-15', name: 'Receiving advice reference', fields: [] },
  { term: 'BT-16', name: 'Despatch advice reference', fields: [] },
  { term: 'BT-17', name: 'Tender or lot reference', fields: [] },
  { term: 'BT-18', name: 'Invoiced object identifier', fields: [] },
  { term: 'BT-19', name: 'Buyer accounting reference', fields: [] },
  { term: 'BT-20', name: 'Payment terms', fields: ['payment.terms'] },
  {
    term: 'BT-21',
    name: 'Invoice note subject code',
    fields: ['notes[].subject_code'],
  },
  { term: 'BT-22', name: 'Invoice note', fields: ['note', 'notes[].text'] },
  {
    term: 'BT-23',
    name: 'Business process type',
    fields: ['operation', 'operation_code'],
  },
  {
    term: 'BT-24',
    name: 'Specification identifier',
    fields: [],
    option: 'profile',
  },
  {
    term: 'BT-25',
    name: 'Preceding Invoice reference',
    fields: ['preceding_invoices[].number'],
  },
  {
    term: 'BT-26',
    name: 'Preceding Invoice issue date',
    fields: ['preceding_invoices[].issue_date'],
  },
  { term: 'BT-27', name: 'Seller name', fields: ['seller.name'] },
  {
    term: 'BT-28',
    name: 'Seller trading name',
    fields: ['seller.trading_name'],
  },
  { term: 'BT-29', name: 'Seller identifier', fields: ['seller.id'] },
  {
    term: 'BT-30',
    name: 'Seller legal registration identifier',
    fields: ['seller.legal_registration'],
  },
  { term: 'BT-31', name: 'Seller VAT identifier', fields: ['seller.vat_id'] },
  {
    term: 'BT-32',
    name: 'Seller tax registration identifier',
    fields: ['seller.tax_number'],
  },
  {
    term: 'BT-33',
    name: 'Seller additional legal information',
    fields: ['seller.legal_info'],
    en16931Only: true,
  },
  {
    term: 'BT-34',
    name: 'Seller electronic address',
    fields: ['seller.electronic_address'],
  },
  {
    term: 'BT-35',
    name: 'Seller address line 1',
    fields: ['seller.address.street'],
  },
  {
    term: 'BT-36',
    name: 'Seller address line 2',
    fields: ['seller.address.street2'],
  },
  { term: 'BT-37', name: 'Seller city', fields: ['seller.address.city'] },
  {
    term: 'BT-38',
    name: 'Seller post code',
    fields: ['seller.address.postcode'],
  },
  {
    term: 'BT-39',
    name: 'Seller country subdivision',
    fields: ['seller.address.subdivision'],
  },
  {
    term: 'BT-40',
    name: 'Seller country code',
    fields: ['seller.address.country'],
  },
  {
    term: 'BT-41',
    name: 'Seller contact point',
    fields: ['seller.contact.name'],
    en16931Only: true,
  },
  {
    term: 'BT-42',
    name: 'Seller contact telephone number',
    fields: ['seller.contact.phone'],
    en16931Only: true,
  },
  {
    term: 'BT-43',
    name: 'Seller contact email address',
    fields: ['seller.contact.email'],
    en16931Only: true,
  },
  { term: 'BT-44', name: 'Buyer name', fields: ['buyer.name'] },
  { term: 'BT-45', name: 'Buyer trading name', fields: ['buyer.trading_name'] },
  { term: 'BT-46', name: 'Buyer identifier', fields: ['buyer.id'] },
  {
    term: 'BT-47',
    name: 'Buyer legal registration identifier',
    fields: ['buyer.legal_registration', 'buyer.siren'],
  },
  { term: 'BT-48', name: 'Buyer VAT identifier', fields: ['buyer.vat_id'] },
  {
    term: 'BT-49',
    name: 'Buyer electronic address',
    fields: ['buyer.electronic_address'],
  },
  {
    term: 'BT-50',
    name: 'Buyer address line 1',
    fields: ['buyer.address.street'],
  },
  {
    term: 'BT-51',
    name: 'Buyer address line 2',
    fields: ['buyer.address.street2'],
  },
  { term: 'BT-52', name: 'Buyer city', fields: ['buyer.address.city'] },
  {
    term: 'BT-53',
    name: 'Buyer post code',
    fields: ['buyer.address.postcode'],
  },
  {
    term: 'BT-54',
    name: 'Buyer country subdivision',
    fields: ['buyer.address.subdivision'],
  },
  {
    term: 'BT-55',
    name: 'Buyer country code',
    fields: ['buyer.address.country'],
  },
  {
    term: 'BT-56',
    name: 'Buyer contact point',
    fields: ['buyer.contact.name'],
    en16931Only: true,
  },
  {
    term: 'BT-57',
    name: 'Buyer contact telephone number',
    fields: ['buyer.contact.phone'],
    en16931Only: true,
  },
  {
    term: 'BT-58',
    name: 'Buyer contact email address',
    fields: ['buyer.contact.email'],
    en16931Only: true,
  },
  { term: 'BT-59', name: 'Payee name', fields: [] },
  { term: 'BT-60', name: 'Payee identifier', fields: [] },
  { term: 'BT-61', name: 'Payee legal registration identifier', fields: [] },
  { term: 'BT-62', name: 'Seller tax representative name', fields: [] },
  {
    term: 'BT-63',
    name: 'Seller tax representative VAT identifier',
    fields: [],
  },
  { term: 'BT-64', name: 'Tax representative address line 1', fields: [] },
  { term: 'BT-65', name: 'Tax representative address line 2', fields: [] },
  { term: 'BT-66', name: 'Tax representative city', fields: [] },
  { term: 'BT-67', name: 'Tax representative post code', fields: [] },
  { term: 'BT-68', name: 'Tax representative country subdivision', fields: [] },
  { term: 'BT-69', name: 'Tax representative country code', fields: [] },
  { term: 'BT-70', name: 'Deliver to party name', fields: ['delivery.name'] },
  { term: 'BT-71', name: 'Deliver to location identifier', fields: [] },
  { term: 'BT-72', name: 'Actual delivery date', fields: ['delivery.date'] },
  {
    term: 'BT-73',
    name: 'Invoicing period start date',
    fields: ['period.start'],
  },
  { term: 'BT-74', name: 'Invoicing period end date', fields: ['period.end'] },
  {
    term: 'BT-75',
    name: 'Deliver to address line 1',
    fields: ['delivery.address.street'],
  },
  {
    term: 'BT-76',
    name: 'Deliver to address line 2',
    fields: ['delivery.address.street2'],
  },
  { term: 'BT-77', name: 'Deliver to city', fields: ['delivery.address.city'] },
  {
    term: 'BT-78',
    name: 'Deliver to post code',
    fields: ['delivery.address.postcode'],
  },
  {
    term: 'BT-79',
    name: 'Deliver to country subdivision',
    fields: ['delivery.address.subdivision'],
  },
  {
    term: 'BT-80',
    name: 'Deliver to country code',
    fields: ['delivery.address.country'],
  },
  {
    term: 'BT-81',
    name: 'Payment means type code',
    fields: ['payment.means_code'],
  },
  { term: 'BT-82', name: 'Payment means text', fields: [] },
  {
    term: 'BT-83',
    name: 'Remittance information',
    fields: ['payment.reference'],
  },
  {
    term: 'BT-84',
    name: 'Payment account identifier',
    fields: ['payment.iban'],
  },
  {
    term: 'BT-85',
    name: 'Payment account name',
    fields: ['payment.account_name'],
    en16931Only: true,
  },
  {
    term: 'BT-86',
    name: 'Payment service provider identifier',
    fields: ['payment.bic'],
    en16931Only: true,
  },
  { term: 'BT-87', name: 'Payment card primary account number', fields: [] },
  { term: 'BT-88', name: 'Payment card holder name', fields: [] },
  {
    term: 'BT-89',
    name: 'Mandate reference identifier',
    fields: ['payment.mandate_id'],
  },
  {
    term: 'BT-90',
    name: 'Bank assigned creditor identifier',
    fields: ['payment.creditor_id'],
  },
  {
    term: 'BT-91',
    name: 'Debited account identifier',
    fields: ['payment.debited_iban'],
  },
  {
    term: 'BT-92',
    name: 'Document level allowance amount',
    fields: ['allowances[].amount'],
  },
  {
    term: 'BT-93',
    name: 'Document level allowance base amount',
    fields: ['allowances[].base_amount'],
  },
  {
    term: 'BT-94',
    name: 'Document level allowance percentage',
    fields: ['allowances[].percent'],
  },
  {
    term: 'BT-95',
    name: 'Document level allowance VAT category code',
    fields: ['allowances[].tax.category'],
  },
  {
    term: 'BT-96',
    name: 'Document level allowance VAT rate',
    fields: ['allowances[].tax.rate'],
  },
  {
    term: 'BT-97',
    name: 'Document level allowance reason',
    fields: ['allowances[].reason'],
  },
  {
    term: 'BT-98',
    name: 'Document level allowance reason code',
    fields: ['allowances[].reason_code'],
  },
  {
    term: 'BT-99',
    name: 'Document level charge amount',
    fields: ['charges[].amount'],
  },
  {
    term: 'BT-100',
    name: 'Document level charge base amount',
    fields: ['charges[].base_amount'],
  },
  {
    term: 'BT-101',
    name: 'Document level charge percentage',
    fields: ['charges[].percent'],
  },
  {
    term: 'BT-102',
    name: 'Document level charge VAT category code',
    fields: ['charges[].tax.category'],
  },
  {
    term: 'BT-103',
    name: 'Document level charge VAT rate',
    fields: ['charges[].tax.rate'],
  },
  {
    term: 'BT-104',
    name: 'Document level charge reason',
    fields: ['charges[].reason'],
  },
  {
    term: 'BT-105',
    name: 'Document level charge reason code',
    fields: ['charges[].reason_code'],
  },
  {
    term: 'BT-106',
    name: 'Sum of Invoice line net amount',
    fields: ['totals.line_net'],
  },
  {
    term: 'BT-107',
    name: 'Sum of allowances on document level',
    fields: ['totals.allowances'],
  },
  {
    term: 'BT-108',
    name: 'Sum of charges on document level',
    fields: ['totals.charges'],
  },
  {
    term: 'BT-109',
    name: 'Invoice total amount without VAT',
    fields: ['totals.tax_basis'],
  },
  {
    term: 'BT-110',
    name: 'Invoice total VAT amount',
    fields: ['totals.tax_total'],
  },
  {
    term: 'BT-111',
    name: 'Invoice total VAT amount in accounting currency',
    fields: ['totals.tax_total_accounting'],
  },
  {
    term: 'BT-112',
    name: 'Invoice total amount with VAT',
    fields: ['totals.grand'],
  },
  { term: 'BT-113', name: 'Paid amount', fields: ['totals.prepaid'] },
  {
    term: 'BT-114',
    name: 'Rounding amount',
    fields: ['totals.rounding'],
    en16931Only: true,
  },
  { term: 'BT-115', name: 'Amount due for payment', fields: ['totals.due'] },
  {
    term: 'BT-116',
    name: 'VAT category taxable amount',
    fields: ['tax.breakdown[].basis'],
  },
  {
    term: 'BT-117',
    name: 'VAT category tax amount',
    fields: ['tax.breakdown[].amount'],
  },
  {
    term: 'BT-118',
    name: 'VAT category code',
    fields: ['tax.breakdown[].category'],
  },
  {
    term: 'BT-119',
    name: 'VAT category rate',
    fields: ['tax.breakdown[].rate'],
  },
  {
    term: 'BT-120',
    name: 'VAT exemption reason text',
    fields: ['tax.breakdown[].exemption_reason'],
  },
  {
    term: 'BT-121',
    name: 'VAT exemption reason code',
    fields: ['tax.breakdown[].exemption_reason_code'],
  },
  { term: 'BT-122', name: 'Supporting document reference', fields: [] },
  { term: 'BT-123', name: 'Supporting document description', fields: [] },
  { term: 'BT-124', name: 'External document location', fields: [] },
  { term: 'BT-125', name: 'Attached document', fields: [] },
  { term: 'BT-126', name: 'Invoice line identifier', fields: ['lines[].id'] },
  { term: 'BT-127', name: 'Invoice line note', fields: ['lines[].note'] },
  { term: 'BT-128', name: 'Invoice line object identifier', fields: [] },
  { term: 'BT-129', name: 'Invoiced quantity', fields: ['lines[].quantity'] },
  {
    term: 'BT-130',
    name: 'Invoiced quantity unit of measure code',
    fields: ['lines[].unit_code'],
  },
  {
    term: 'BT-131',
    name: 'Invoice line net amount',
    fields: ['lines[].net_amount'],
  },
  {
    term: 'BT-132',
    name: 'Referenced purchase order line reference',
    fields: ['lines[].order_line_reference'],
    en16931Only: true,
  },
  {
    term: 'BT-133',
    name: 'Invoice line Buyer accounting reference',
    fields: ['lines[].buyer_accounting_reference'],
    en16931Only: true,
  },
  {
    term: 'BT-134',
    name: 'Invoice line period start date',
    fields: ['lines[].period.start'],
  },
  {
    term: 'BT-135',
    name: 'Invoice line period end date',
    fields: ['lines[].period.end'],
  },
  {
    term: 'BT-136',
    name: 'Invoice line allowance amount',
    fields: ['lines[].allowances[].amount'],
  },
  {
    term: 'BT-137',
    name: 'Invoice line allowance base amount',
    fields: ['lines[].allowances[].base_amount'],
  },
  {
    term: 'BT-138',
    name: 'Invoice line allowance percentage',
    fields: ['lines[].allowances[].percent'],
  },
  {
    term: 'BT-139',
    name: 'Invoice line allowance reason',
    fields: ['lines[].allowances[].reason'],
  },
  {
    term: 'BT-140',
    name: 'Invoice line allowance reason code',
    fields: ['lines[].allowances[].reason_code'],
  },
  {
    term: 'BT-141',
    name: 'Invoice line charge amount',
    fields: ['lines[].charges[].amount'],
  },
  {
    term: 'BT-142',
    name: 'Invoice line charge base amount',
    fields: ['lines[].charges[].base_amount'],
  },
  {
    term: 'BT-143',
    name: 'Invoice line charge percentage',
    fields: ['lines[].charges[].percent'],
  },
  {
    term: 'BT-144',
    name: 'Invoice line charge reason',
    fields: ['lines[].charges[].reason'],
  },
  {
    term: 'BT-145',
    name: 'Invoice line charge reason code',
    fields: ['lines[].charges[].reason_code'],
  },
  { term: 'BT-146', name: 'Item net price', fields: ['lines[].net_price'] },
  { term: 'BT-147', name: 'Item price discount', fields: [] },
  { term: 'BT-148', name: 'Item gross price', fields: [] },
  {
    term: 'BT-149',
    name: 'Item price base quantity',
    fields: ['lines[].price_base_quantity'],
  },
  {
    term: 'BT-150',
    name: 'Item price base quantity unit of measure',
    fields: ['lines[].unit_code'],
  },
  {
    term: 'BT-151',
    name: 'Invoiced item VAT category code',
    fields: ['lines[].tax.category'],
  },
  {
    term: 'BT-152',
    name: 'Invoiced item VAT rate',
    fields: ['lines[].tax.rate'],
  },
  { term: 'BT-153', name: 'Item name', fields: ['lines[].name'] },
  {
    term: 'BT-154',
    name: 'Item description',
    fields: ['lines[].description'],
    en16931Only: true,
  },
  {
    term: 'BT-155',
    name: 'Item Sellers identifier',
    fields: ['lines[].seller_item_id'],
    en16931Only: true,
  },
  {
    term: 'BT-156',
    name: 'Item Buyers identifier',
    fields: ['lines[].buyer_item_id'],
    en16931Only: true,
  },
  {
    term: 'BT-157',
    name: 'Item standard identifier',
    fields: ['lines[].standard_item_id'],
  },
  { term: 'BT-158', name: 'Item classification identifier', fields: [] },
  { term: 'BT-159', name: 'Item country of origin', fields: [] },
  { term: 'BT-160', name: 'Item attribute name', fields: [] },
  { term: 'BT-161', name: 'Item attribute value', fields: [] },
  {
    term: 'BT-162',
    name: 'Seller address line 3',
    fields: ['seller.address.street3'],
  },
  {
    term: 'BT-163',
    name: 'Buyer address line 3',
    fields: ['buyer.address.street3'],
  },
  { term: 'BT-164', name: 'Tax representative address line 3', fields: [] },
  {
    term: 'BT-165',
    name: 'Deliver to address line 3',
    fields: ['delivery.address.street3'],
  },
];

/** Whether an e-invoice from the block can carry the term. */
export const carriesTerm = (term: EinvoiceTerm): boolean =>
  term.fields.length > 0 || term.option !== undefined;

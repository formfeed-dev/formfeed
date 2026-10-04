import type {
  Identifier,
  Invoice,
  InvoiceAddress,
  InvoiceAllowance,
  InvoiceParty,
  InvoiceTax,
} from './check';
import { withPlaces } from './decimal';
import type { EinvoiceProfile } from './schema';

/**
 * A checked invoice as Cross Industry Invoice XML, the syntax ZUGFeRD and Factur-X embed (spec 17
 * §3, §5). The element order is the schema's: the XSD of a profile is a sequence, and an element in
 * the wrong place fails before any business rule is looked at.
 *
 * The output is a function of the invoice and the profile alone. No date of writing, no generator
 * comment, no locale: two renders of the same data embed the same bytes, and the golden files in
 * `fixtures/` pin them.
 */

/** The identifier a document names its profile by (BT-24). */
export const CII_GUIDELINES: Record<EinvoiceProfile, string> = {
  basic: 'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic',
  en16931: 'urn:cen.eu:en16931:2017',
};

/** The name the XML has inside the PDF, under either of the specification's two names. */
export const EINVOICE_XML_NAME = 'factur-x.xml';

interface XmlElement {
  name: string;
  attributes?: Record<string, string>;
  text?: string;
  children?: XmlElement[];
}
type Child = XmlElement | undefined;

/** A leaf, or nothing when there is no value: the profiles' rules refuse empty elements. */
function leaf(
  name: string,
  text: string | undefined,
  attributes?: Record<string, string | undefined>,
): Child {
  if (text === undefined || text === '') return undefined;
  const kept = Object.entries(attributes ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return {
    name,
    text,
    ...(kept.length > 0 ? { attributes: Object.fromEntries(kept) } : {}),
  };
}

/** An element with whatever children exist, or nothing when none does. */
function group(name: string, children: Child[]): Child {
  const kept = children.filter((child): child is XmlElement => !!child);
  return kept.length > 0 ? { name, children: kept } : undefined;
}

const date = (name: string, value: string | undefined): Child =>
  value === undefined
    ? undefined
    : group(name, [
        leaf('udt:DateTimeString', value.replace(/-/g, ''), { format: '102' }),
      ]);

const amount = (
  name: string,
  value: string | undefined,
  attributes?: Record<string, string>,
): Child =>
  value === undefined
    ? undefined
    : leaf(name, withPlaces(value, 2), attributes);

const identifier = (
  plain: string,
  withScheme: string,
  id: Identifier | undefined,
): Child =>
  id === undefined
    ? undefined
    : id.scheme
      ? leaf(withScheme, id.value, { schemeID: id.scheme })
      : leaf(plain, id.value);

function address(value: InvoiceAddress | undefined): Child {
  if (!value) return undefined;
  return group('ram:PostalTradeAddress', [
    leaf('ram:PostcodeCode', value.postcode),
    leaf('ram:LineOne', value.street),
    leaf('ram:LineTwo', value.street2),
    leaf('ram:LineThree', value.street3),
    leaf('ram:CityName', value.city),
    leaf('ram:CountryID', value.country),
    leaf('ram:CountrySubDivisionName', value.subdivision),
  ]);
}

function party(
  name: string,
  value: InvoiceParty & { tax_number?: string; legal_info?: string },
  full: boolean,
): Child {
  return group(name, [
    identifier('ram:ID', 'ram:GlobalID', value.id),
    leaf('ram:Name', value.name),
    full ? leaf('ram:Description', value.legal_info) : undefined,
    group('ram:SpecifiedLegalOrganization', [
      value.legal_registration
        ? leaf('ram:ID', value.legal_registration.value, {
            schemeID: value.legal_registration.scheme,
          })
        : undefined,
      leaf('ram:TradingBusinessName', value.trading_name),
    ]),
    full && value.contact
      ? group('ram:DefinedTradeContact', [
          leaf('ram:PersonName', value.contact.name),
          group('ram:TelephoneUniversalCommunication', [
            leaf('ram:CompleteNumber', value.contact.phone),
          ]),
          group('ram:EmailURIUniversalCommunication', [
            leaf('ram:URIID', value.contact.email),
          ]),
        ])
      : undefined,
    address(value.address),
    value.electronic_address
      ? group('ram:URIUniversalCommunication', [
          leaf('ram:URIID', value.electronic_address.value, {
            schemeID: value.electronic_address.scheme,
          }),
        ])
      : undefined,
    group('ram:SpecifiedTaxRegistration', [
      leaf('ram:ID', value.vat_id, { schemeID: 'VA' }),
    ]),
    group('ram:SpecifiedTaxRegistration', [
      leaf('ram:ID', value.tax_number, { schemeID: 'FC' }),
    ]),
  ]);
}

/** Category and rate; a rate is left out where the category has none (O). */
const taxOf = (tax: InvoiceTax): Child[] => [
  leaf('ram:TypeCode', 'VAT'),
  leaf('ram:CategoryCode', tax.category),
  leaf('ram:RateApplicablePercent', tax.rate),
];

function allowanceOrCharge(
  value: InvoiceAllowance & { tax?: InvoiceTax },
  charge: boolean,
): Child {
  return group('ram:SpecifiedTradeAllowanceCharge', [
    group('ram:ChargeIndicator', [
      leaf('udt:Indicator', charge ? 'true' : 'false'),
    ]),
    leaf('ram:CalculationPercent', value.percent),
    amount('ram:BasisAmount', value.base_amount),
    amount('ram:ActualAmount', value.amount),
    leaf('ram:ReasonCode', value.reason_code),
    leaf('ram:Reason', value.reason),
    value.tax ? group('ram:CategoryTradeTax', taxOf(value.tax)) : undefined,
  ]);
}

const period = (value: { start?: string; end?: string } | undefined): Child =>
  value === undefined
    ? undefined
    : group('ram:BillingSpecifiedPeriod', [
        date('ram:StartDateTime', value.start),
        date('ram:EndDateTime', value.end),
      ]);

export function invoiceToCii(
  invoice: Invoice,
  options: { profile: EinvoiceProfile },
): string {
  const full = options.profile === 'en16931';
  const { totals, payment } = invoice;

  const lines = invoice.lines.map((line) =>
    group('ram:IncludedSupplyChainTradeLineItem', [
      group('ram:AssociatedDocumentLineDocument', [
        leaf('ram:LineID', line.id),
        group('ram:IncludedNote', [leaf('ram:Content', line.note)]),
      ]),
      group('ram:SpecifiedTradeProduct', [
        line.standard_item_id
          ? leaf('ram:GlobalID', line.standard_item_id.value, {
              schemeID: line.standard_item_id.scheme,
            })
          : undefined,
        full ? leaf('ram:SellerAssignedID', line.seller_item_id) : undefined,
        full ? leaf('ram:BuyerAssignedID', line.buyer_item_id) : undefined,
        leaf('ram:Name', line.name),
        full ? leaf('ram:Description', line.description) : undefined,
      ]),
      group('ram:SpecifiedLineTradeAgreement', [
        full
          ? group('ram:BuyerOrderReferencedDocument', [
              leaf('ram:LineID', line.order_line_reference),
            ])
          : undefined,
        group('ram:NetPriceProductTradePrice', [
          leaf('ram:ChargeAmount', withPlaces(line.net_price, 2)),
          leaf('ram:BasisQuantity', line.price_base_quantity, {
            unitCode: line.unit_code,
          }),
        ]),
      ]),
      group('ram:SpecifiedLineTradeDelivery', [
        leaf('ram:BilledQuantity', line.quantity, { unitCode: line.unit_code }),
      ]),
      group('ram:SpecifiedLineTradeSettlement', [
        group('ram:ApplicableTradeTax', taxOf(line.tax)),
        period(line.period),
        ...line.allowances.map((a) => allowanceOrCharge(a, false)),
        ...line.charges.map((c) => allowanceOrCharge(c, true)),
        group('ram:SpecifiedTradeSettlementLineMonetarySummation', [
          amount('ram:LineTotalAmount', line.net_amount),
        ]),
        full
          ? group('ram:ReceivableSpecifiedTradeAccountingAccount', [
              leaf('ram:ID', line.buyer_accounting_reference),
            ])
          : undefined,
      ]),
    ]),
  );

  const agreement = group('ram:ApplicableHeaderTradeAgreement', [
    leaf('ram:BuyerReference', invoice.buyer_reference),
    party('ram:SellerTradeParty', invoice.seller, full),
    party('ram:BuyerTradeParty', invoice.buyer, full),
    group('ram:BuyerOrderReferencedDocument', [
      leaf('ram:IssuerAssignedID', invoice.order_reference),
    ]),
    group('ram:ContractReferencedDocument', [
      leaf('ram:IssuerAssignedID', invoice.contract_reference),
    ]),
  ]);

  // the schema asks for the element even when the invoice says nothing about the delivery
  const shipTo = invoice.delivery;
  const delivery: XmlElement = group('ram:ApplicableHeaderTradeDelivery', [
    group('ram:ShipToTradeParty', [
      leaf('ram:Name', shipTo?.name),
      address(shipTo?.address),
    ]),
    group('ram:ActualDeliverySupplyChainEvent', [
      date('ram:OccurrenceDateTime', shipTo?.date),
    ]),
  ]) ?? { name: 'ram:ApplicableHeaderTradeDelivery' };

  const settlement = group('ram:ApplicableHeaderTradeSettlement', [
    leaf('ram:CreditorReferenceID', payment?.creditor_id),
    leaf('ram:PaymentReference', payment?.reference),
    leaf('ram:TaxCurrencyCode', invoice.accounting_currency),
    leaf('ram:InvoiceCurrencyCode', invoice.currency),
    payment?.means_code
      ? group('ram:SpecifiedTradeSettlementPaymentMeans', [
          leaf('ram:TypeCode', payment.means_code),
          group('ram:PayerPartyDebtorFinancialAccount', [
            leaf('ram:IBANID', payment.debited_iban),
          ]),
          group('ram:PayeePartyCreditorFinancialAccount', [
            leaf('ram:IBANID', payment.iban),
            full ? leaf('ram:AccountName', payment.account_name) : undefined,
          ]),
          full
            ? group('ram:PayeeSpecifiedCreditorFinancialInstitution', [
                leaf('ram:BICID', payment.bic),
              ])
            : undefined,
        ])
      : undefined,
    ...invoice.breakdown.map((row) =>
      group('ram:ApplicableTradeTax', [
        amount('ram:CalculatedAmount', row.amount),
        leaf('ram:TypeCode', 'VAT'),
        leaf('ram:ExemptionReason', row.exemption_reason),
        amount('ram:BasisAmount', row.basis),
        leaf('ram:CategoryCode', row.category),
        leaf('ram:ExemptionReasonCode', row.exemption_reason_code),
        // France: VAT owed on invoicing rather than on payment is the code for "date of the
        // invoice" (BT-8). Nothing is written for the default, which the specifications leave unsaid.
        invoice.seller.vat_on_debits
          ? leaf('ram:DueDateTypeCode', '5')
          : undefined,
        leaf('ram:RateApplicablePercent', row.rate),
      ]),
    ),
    period(invoice.period),
    ...invoice.allowances.map((a) => allowanceOrCharge(a, false)),
    ...invoice.charges.map((c) => allowanceOrCharge(c, true)),
    group('ram:SpecifiedTradePaymentTerms', [
      leaf('ram:Description', payment?.terms),
      date('ram:DueDateDateTime', payment?.due_date),
      leaf('ram:DirectDebitMandateID', payment?.mandate_id),
    ]),
    group('ram:SpecifiedTradeSettlementHeaderMonetarySummation', [
      amount('ram:LineTotalAmount', totals.line_net),
      amount('ram:ChargeTotalAmount', totals.charges),
      amount('ram:AllowanceTotalAmount', totals.allowances),
      amount('ram:TaxBasisTotalAmount', totals.tax_basis),
      amount('ram:TaxTotalAmount', totals.tax_total, {
        currencyID: invoice.currency,
      }),
      invoice.accounting_currency
        ? amount('ram:TaxTotalAmount', totals.tax_total_accounting, {
            currencyID: invoice.accounting_currency,
          })
        : undefined,
      full ? amount('ram:RoundingAmount', totals.rounding) : undefined,
      amount('ram:GrandTotalAmount', totals.grand),
      amount('ram:TotalPrepaidAmount', totals.prepaid),
      amount('ram:DuePayableAmount', totals.due),
    ]),
    ...invoice.preceding_invoices.map((reference) =>
      group('ram:InvoiceReferencedDocument', [
        leaf('ram:IssuerAssignedID', reference.number),
        reference.issue_date
          ? group('ram:FormattedIssueDateTime', [
              leaf(
                'qdt:DateTimeString',
                reference.issue_date.replace(/-/g, ''),
                { format: '102' },
              ),
            ])
          : undefined,
      ]),
    ),
  ]);

  const root: XmlElement = {
    name: 'rsm:CrossIndustryInvoice',
    attributes: {
      'xmlns:rsm':
        'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
      'xmlns:qdt': 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100',
      'xmlns:ram':
        'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
      'xmlns:udt':
        'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
    },
    children: [
      group('rsm:ExchangedDocumentContext', [
        group('ram:BusinessProcessSpecifiedDocumentContextParameter', [
          leaf('ram:ID', invoice.business_process),
        ]),
        group('ram:GuidelineSpecifiedDocumentContextParameter', [
          leaf('ram:ID', CII_GUIDELINES[options.profile]),
        ]),
      ]),
      group('rsm:ExchangedDocument', [
        leaf('ram:ID', invoice.number),
        leaf('ram:TypeCode', invoice.type_code),
        date('ram:IssueDateTime', invoice.issue_date),
        ...invoice.notes.map((note) =>
          group('ram:IncludedNote', [
            leaf('ram:Content', note.text),
            leaf('ram:SubjectCode', note.subject_code),
          ]),
        ),
      ]),
      group('rsm:SupplyChainTradeTransaction', [
        ...lines,
        agreement,
        delivery,
        settlement,
      ]),
    ].filter((child): child is XmlElement => !!child),
  };

  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialise(root, 0)}`;
}

/**
 * What XML 1.0 can carry: tab, line feed, carriage return, and everything from the space on except
 * surrogates on their own and the two noncharacters. A control character pasted into a note must
 * not break the file, so the rest is dropped. Written as code points, because an escape for one of
 * these in source text is one more thing to get wrong.
 */
const xmlCharacter = (code: number): boolean =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 &&
    !(code >= 0xd800 && code <= 0xdfff) &&
    code !== 0xfffe &&
    code !== 0xffff);

function carried(text: string): string {
  let out = '';
  for (const character of text)
    if (xmlCharacter(character.codePointAt(0) ?? 0)) out += character;
  return out;
}

const escapeText = (text: string): string =>
  carried(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const escapeAttribute = (text: string): string =>
  escapeText(text).replace(/"/g, '&quot;');

function serialise(element: XmlElement, depth: number): string {
  const indent = '  '.repeat(depth);
  const attributes = Object.entries(element.attributes ?? {})
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  if (element.children === undefined) {
    return element.text === undefined
      ? `${indent}<${element.name}${attributes}/>\n`
      : `${indent}<${element.name}${attributes}>${escapeText(element.text)}</${element.name}>\n`;
  }
  const children = element.children
    .map((child) => serialise(child, depth + 1))
    .join('');
  return `${indent}<${element.name}${attributes}>\n${children}${indent}</${element.name}>\n`;
}

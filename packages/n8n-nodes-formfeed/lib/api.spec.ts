import { checkInvoice } from '@formfeed/engine/einvoice';
import {
  baseUrl,
  channelOptions,
  convertFields,
  downloadName,
  einvoiceOptions,
  formValue,
  invoiceBlock,
  isoDay,
  libraryName,
  mergeData,
  nestData,
  pdfNameFor,
  renderBody,
  schemaFields,
  type InvoiceFields,
} from './api';

describe('baseUrl', () => {
  it('maps the region to a host', () => {
    expect(baseUrl({ apiKey: 'k', region: 'eu' })).toBe(
      'https://api-eu.formfeed.dev/v1',
    );
    expect(baseUrl({ apiKey: 'k', region: 'us' })).toBe(
      'https://api-us.formfeed.dev/v1',
    );
  });

  it('lets a custom base URL win and trims the trailing slash', () => {
    expect(
      baseUrl({
        apiKey: 'k',
        region: 'eu',
        baseUrl: 'http://127.0.0.1:8787/v1/',
      }),
    ).toBe('http://127.0.0.1:8787/v1');
  });
});

describe('renderBody', () => {
  it('sends only what the user filled in and tags the source', () => {
    expect(
      renderBody({ source: 'template', template: 'invoice-de', output: 'pdf' }),
    ).toEqual({
      template: 'invoice-de',
      output: 'pdf',
      meta: { source: 'n8n' },
    });
  });

  it('carries the engine with raw HTML and the queue flag for async', () => {
    const body = renderBody({
      source: 'html',
      html: '<h1>Hi</h1>',
      engine: 'liquid',
      mode: 'async',
      webhookUrl: 'https://example.com/hook',
      data: { a: 1 },
    });
    expect(body).toMatchObject({
      html: '<h1>Hi</h1>',
      engine: 'liquid',
      mode: 'async',
      webhook_url: 'https://example.com/hook',
      data: { a: 1 },
    });
  });

  it('leaves empty data and settings out', () => {
    const body = renderBody({
      source: 'url',
      url: 'https://example.com',
      data: {},
      settings: {},
    });
    expect(body).toEqual({
      url: 'https://example.com',
      meta: { source: 'n8n' },
    });
  });

  it('names a release channel or version number, and leaves the default published out', () => {
    expect(
      renderBody({
        source: 'template',
        template: 'invoice-de',
        version: 'staging',
      }),
    ).toMatchObject({ version: 'staging' });
    expect(
      renderBody({ source: 'template', template: 'invoice-de', version: '8' }),
    ).toMatchObject({ version: '8' });
    expect(
      renderBody({
        source: 'template',
        template: 'invoice-de',
        version: 'published',
      }),
    ).not.toHaveProperty('version');
    // a version belongs to a template, never to raw HTML
    expect(
      renderBody({ source: 'html', html: '<p/>', version: 'staging' }),
    ).not.toHaveProperty('version');
  });
});

describe('channelOptions', () => {
  it('lists published and the channels with the version each renders', () => {
    expect(
      channelOptions([
        { name: 'published', version: 3, canary: { version: 4, percent: 10 } },
        { name: 'staging', version: 4, canary: null },
        { name: 'beta', version: null },
      ]),
    ).toEqual([
      {
        name: 'Published (v3, canary v4 at 10 %)',
        value: 'published',
        description: 'The published version, the default',
      },
      {
        name: 'staging (v4)',
        value: 'staging',
        description: 'The release channel staging',
      },
      {
        name: 'beta (nothing published yet)',
        value: 'beta',
        description: 'The release channel beta',
      },
    ]);
  });
});

describe('schemaFields', () => {
  const schema = {
    type: 'object',
    required: ['invoice'],
    properties: {
      invoice: {
        type: 'object',
        required: ['number'],
        properties: {
          number: { type: 'string', description: 'Invoice number' },
          total: { type: 'integer' },
          lines: { type: 'array', items: { type: 'object' } },
        },
      },
      paid: { type: 'boolean' },
    },
  };

  it('flattens nested objects into dot paths and keeps arrays whole', () => {
    expect(schemaFields(schema)).toEqual([
      {
        path: 'invoice.number',
        type: 'string',
        required: true,
        description: 'Invoice number',
      },
      { path: 'invoice.total', type: 'number', required: false },
      { path: 'invoice.lines', type: 'array', required: false },
      { path: 'paid', type: 'boolean', required: false },
    ]);
  });

  it('returns nothing for a schema without properties', () => {
    expect(schemaFields(null)).toEqual([]);
    expect(schemaFields({ type: 'object' })).toEqual([]);
  });
});

describe('nestData', () => {
  it('turns dot paths back into the nested data object', () => {
    expect(
      nestData({ 'invoice.number': '42', 'invoice.total': 10, paid: true }),
    ).toEqual({
      invoice: { number: '42', total: 10 },
      paid: true,
    });
  });

  it('drops values the user left empty', () => {
    expect(nestData({ 'invoice.number': '', paid: undefined })).toEqual({});
  });
});

describe('mergeData', () => {
  it('merges the JSON field into the mapped fields per leaf', () => {
    expect(
      mergeData(
        { invoice: { number: '42' } },
        { invoice: { lines: [{ qty: 2 }] } },
      ),
    ).toEqual({ invoice: { number: '42', lines: [{ qty: 2 }] } });
  });

  it('lets the override win on a leaf and replaces arrays whole', () => {
    expect(mergeData({ a: 1, list: [1, 2] }, { a: 2, list: [3] })).toEqual({
      a: 2,
      list: [3],
    });
  });
});

describe('downloadName', () => {
  it('gives the chosen name the extension of what was rendered', () => {
    expect(downloadName('offer', 'rnd_1', 'docx')).toBe('offer.docx');
    expect(downloadName('offer.pdf', 'rnd_1', 'docx')).toBe('offer.docx');
    expect(downloadName('slides.PPTX', 'rnd_1', 'pdf')).toBe('slides.pdf');
    expect(downloadName('report.v2', 'rnd_1', 'pdf')).toBe('report.v2.pdf');
  });

  it('names the file after the render without a chosen name', () => {
    expect(downloadName('', 'rnd_1', 'pptx')).toBe('rnd_1.pptx');
    expect(downloadName(undefined, 'rnd_1', undefined)).toBe('rnd_1.pdf');
  });
});

describe('convertFields', () => {
  it('names a render as the source, or only the options for an upload', () => {
    expect(
      convertFields({ renderId: ' rnd_docx ', pageRanges: '1-2' }),
    ).toEqual({
      source: 'rnd_docx',
      page_ranges: '1-2',
      meta: { source: 'n8n' },
    });
    expect(
      convertFields({
        landscape: true,
        singlePageSheets: false,
        filename: 'report',
      }),
    ).toEqual({
      landscape: true,
      filename: 'report.pdf',
      meta: { source: 'n8n' },
    });
  });

  it('names the PDF after the converted file', () => {
    expect(pdfNameFor('report.xlsx')).toBe('report.pdf');
    expect(pdfNameFor('Q3 plan.v2.odt')).toBe('Q3 plan.v2.pdf');
    expect(pdfNameFor('')).toBe('document.pdf');
    expect(convertFields({ filename: 'slides.pptx' })['filename']).toBe(
      'slides.pdf',
    );
  });

  it('writes form fields the way the API reads them', () => {
    expect(formValue('1-2')).toBe('1-2');
    expect(formValue(true)).toBe('true');
    expect(formValue({ source: 'n8n' })).toBe('{"source":"n8n"}');
  });
});

describe('libraryName', () => {
  it('keeps a valid typed name, folders included, and refuses an invalid one', () => {
    expect(libraryName('brand/logo.png', 'whatever.png')).toBe(
      'brand/logo.png',
    );
    expect(libraryName('../etc/passwd', 'x.png')).toBeNull();
    expect(libraryName('with space.png', 'x.png')).toBeNull();
  });

  it('cleans up the binary file name when nothing is typed', () => {
    expect(libraryName('', 'Logo Final (2).png')).toBe('Logo-Final-2-.png');
    expect(libraryName(undefined, 'brand\\logo.png')).toBe('brand/logo.png');
    expect(libraryName(undefined, '')).toBeNull();
  });
});

describe('invoiceBlock', () => {
  const fields: InvoiceFields = {
    number: ' RE-2026-0042 ',
    issueDate: '2026-10-09T00:00:00.000+02:00',
    currency: 'eur',
    typeCode: '380',
    buyerReference: 'PO-0000',
    seller: {
      name: 'Fennlor Studio GmbH',
      street: 'Musterstraße 1',
      postcode: '12345',
      city: 'Musterstadt',
      country: 'de',
      vatId: 'DE000000000',
      legalInfo: 'Amtsgericht Musterstadt, HRB 00000',
      electronicAddress: 'rechnung@fennlor.example',
      contactName: 'Erika Mustermann',
    },
    buyer: {
      name: 'Olvarest GmbH',
      street: 'Beispielweg 2',
      postcode: '54321',
      city: 'Beispielstadt',
      country: 'DE',
      electronicAddress: 'eingang@olvarest.example',
    },
    lines: [
      {
        name: 'Consulting',
        quantity: 8,
        unitCode: 'HUR',
        netPrice: 120,
        netAmount: 960,
        vatCategory: 'S',
        vatRate: 19,
      },
    ],
    breakdown: [{ vatCategory: 'S', vatRate: 19, basis: 960, amount: 182.4 }],
    totals: {
      lineNet: 960,
      taxBasis: 960,
      taxTotal: 182.4,
      grand: 1142.4,
      due: 1142.4,
    },
    payment: {
      meansCode: '58',
      iban: 'DE36 0000 0000 0000 0000 00',
      dueDate: '2026-10-23',
    },
  };

  it('builds the _invoice block the API documents, with the lines numbered in order', () => {
    expect(invoiceBlock(fields)).toEqual({
      number: 'RE-2026-0042',
      issue_date: '2026-10-09',
      type_code: '380',
      currency: 'EUR',
      buyer_reference: 'PO-0000',
      seller: {
        name: 'Fennlor Studio GmbH',
        vat_id: 'DE000000000',
        legal_info: 'Amtsgericht Musterstadt, HRB 00000',
        electronic_address: 'rechnung@fennlor.example',
        address: {
          street: 'Musterstraße 1',
          postcode: '12345',
          city: 'Musterstadt',
          country: 'DE',
        },
        contact: { name: 'Erika Mustermann' },
      },
      buyer: {
        name: 'Olvarest GmbH',
        electronic_address: 'eingang@olvarest.example',
        address: {
          street: 'Beispielweg 2',
          postcode: '54321',
          city: 'Beispielstadt',
          country: 'DE',
        },
      },
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
        iban: 'DE36 0000 0000 0000 0000 00',
        due_date: '2026-10-23',
      },
    });
  });

  it('passes the check the API runs before it renders, so its field names are those of the engine', () => {
    expect(checkInvoice(invoiceBlock(fields)).problems).toEqual([]);
  });

  it('leaves out what was not filled in, and the rate of a category without VAT', () => {
    expect(
      invoiceBlock({
        number: 'R-1',
        note: '',
        seller: { name: 'Fennlor Studio GmbH', street: '' },
        lines: [
          { name: 'Fee', vatCategory: 'O', vatRate: 0 },
          { name: 'Book', vatCategory: 'S', vatRate: 7 },
        ],
      }),
    ).toEqual({
      number: 'R-1',
      seller: { name: 'Fennlor Studio GmbH' },
      lines: [
        { id: '1', name: 'Fee', tax: { category: 'O' } },
        { id: '2', name: 'Book', tax: { category: 'S', rate: 7 } },
      ],
    });
  });
});

describe('isoDay', () => {
  it('takes the date of a timestamp and leaves a date or anything else as it is', () => {
    expect(isoDay('2026-10-09T00:00:00.000+02:00')).toBe('2026-10-09');
    expect(isoDay('2026-10-09')).toBe('2026-10-09');
    expect(isoDay('09.10.2026')).toBe('09.10.2026');
    expect(isoDay('  ')).toBeUndefined();
    expect(isoDay(undefined)).toBeUndefined();
  });
});

describe('einvoiceOptions', () => {
  it('leaves the defaults unsaid and names what was chosen', () => {
    expect(
      einvoiceOptions({ profile: 'en16931', flavour: 'factur-x' }),
    ).toEqual({});
    expect(
      einvoiceOptions({
        profile: 'basic',
        flavour: 'zugferd',
        storeXml: true,
        strictDisplayCheck: true,
      }),
    ).toEqual({
      profile: 'basic',
      flavour: 'zugferd',
      xml: 'both',
      display_check: 'strict',
    });
  });

  it('goes into the render as post.einvoice, an empty object asking for the defaults', () => {
    expect(
      renderBody({
        source: 'template',
        template: 'rechnung',
        data: { _invoice: { number: 'R-1' } },
        output: 'pdf',
        post: { einvoice: einvoiceOptions({}) },
      }),
    ).toEqual({
      template: 'rechnung',
      data: { _invoice: { number: 'R-1' } },
      output: 'pdf',
      post: { einvoice: {} },
      meta: { source: 'n8n' },
    });
  });
});

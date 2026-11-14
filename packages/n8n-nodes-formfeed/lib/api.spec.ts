import { checkInvoice } from '@formfeed/engine/einvoice';
import {
  baseUrl,
  channelOptions,
  compressFields,
  convertFields,
  downloadName,
  einvoiceOptions,
  fillFields,
  fillValues,
  formValue,
  infoFields,
  invoiceBlock,
  isoDay,
  libraryName,
  linkName,
  PDF_TOOLS,
  redactFields,
  splitFields,
  toImageFields,
  mergeData,
  nestData,
  pdfNameFor,
  problemOf,
  renderBody,
  schemaFields,
  type InvoiceFields,
} from './api';

describe('problemOf', () => {
  // the shape n8n's request helper throws for a 422, as a workflow stored it (2026-10-24)
  const refused = Object.assign(
    new Error(
      'Your request is invalid or could not be processed by the service',
    ),
    {
      httpCode: '422',
      description: 'Request failed with status code 422',
      context: {
        data: {
          type: 'https://docs.formfeed.dev/errors/einvoice-data-invalid',
          title: 'E-invoice data invalid',
          status: 422,
          detail:
            '_invoice.lines[0].tax.rate is 0: category S is standard rated and needs a rate above 0; a rate of 0 is category Z or E (BR-S-05)',
          code: 'einvoice_data_invalid',
          errors: [
            {
              path: 'data._invoice.lines[0].tax.rate',
              message: '_invoice.lines[0].tax.rate is 0 (BR-S-05)',
              rule: 'BR-S-05',
            },
          ],
        },
      },
    },
  );

  it('reads the problem the API answered with', () => {
    const problem = problemOf(refused);
    expect(problem?.code).toBe('einvoice_data_invalid');
    expect(problem?.detail).toContain('BR-S-05');
    expect(problem?.errors?.[0]?.rule).toBe('BR-S-05');
  });

  it('finds nothing in an error that is no API answer', () => {
    expect(problemOf(new Error('socket hang up'))).toBeUndefined();
    expect(
      problemOf(Object.assign(new Error('x'), { context: { data: 'text' } })),
    ).toBeUndefined();
    expect(
      problemOf(Object.assign(new Error('x'), { context: { data: {} } })),
    ).toBeUndefined();
    expect(problemOf(undefined)).toBeUndefined();
    expect(problemOf('failed')).toBeUndefined();
  });
});

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

describe('the PDF tools (plan 30)', () => {
  it('names a stored source, the result and the caller, and info only the source', () => {
    expect(
      compressFields({ source: ' rnd_1 ', filename: 'small.pdf' }),
    ).toEqual({
      source: 'rnd_1',
      filename: 'small.pdf',
      meta: { source: 'n8n' },
    });
    // an upload carries no source; the item's binary goes as the file
    expect(compressFields({})).toEqual({ meta: { source: 'n8n' } });
    expect(infoFields({ source: 'terms.pdf' })).toEqual({
      source: 'terms.pdf',
    });
    expect(infoFields({})).toEqual({});
    expect(PDF_TOOLS.toImage).toBe('/pdf/to-image');
  });

  it('splits every N pages, or by one page selection per line', () => {
    expect(splitFields({ every: 2 })).toMatchObject({ every: 2 });
    expect(
      splitFields({ ranges: ['1-3,5', '', ' 6- '].join('\n') }),
    ).toMatchObject({
      ranges: ['1-3,5', '6-'],
    });
    expect(() => splitFields({ ranges: '' })).toThrow(/at least one/);
    expect(() => splitFields({ ranges: 'first page' })).toThrow(
      /no page selection/,
    );
  });

  it('draws pages in a format, and sends the JPEG quality only for JPEG', () => {
    expect(
      toImageFields({ pages: '1', format: 'jpg', dpi: 72, quality: 80 }),
    ).toMatchObject({
      pages: '1',
      format: 'jpg',
      dpi: 72,
      quality: 80,
    });
    expect(toImageFields({ format: 'png', quality: 80 })).not.toHaveProperty(
      'quality',
    );
    expect(() => toImageFields({ pages: 'all' })).toThrow(/no page selection/);
  });

  it('redacts rectangles and texts, black by default, in a colour or with no box', () => {
    const rectangle = { page: 1, x: 52, y: 88, width: 200, height: 16 };
    expect(
      redactFields({
        rectangles: [rectangle],
        texts: ['Max Mustermann', 'DE36 0000 0000 0000 0000 00'].join('\n'),
        wholeWords: true,
      }),
    ).toEqual({
      regions: [rectangle],
      text: ['Max Mustermann', 'DE36 0000 0000 0000 0000 00'],
      whole_words: true,
      meta: { source: 'n8n' },
    });
    // n8n's colour field holds black until someone picks another
    expect(
      redactFields({ texts: 'x', boxColour: '#000000' }),
    ).not.toHaveProperty('fill');
    expect(redactFields({ texts: 'x', boxColour: '#ff0000' })).toMatchObject({
      fill: '#ff0000',
    });
    expect(
      redactFields({ texts: 'x', drawBox: false, boxColour: '#ff0000' }),
    ).toMatchObject({ fill: null });
    expect(() => redactFields({ texts: '  ' })).toThrow(
      /rectangle or one text/,
    );
  });

  it('fills by name: true and false for check boxes, a JSON list for a list box, else text', () => {
    const values = fillValues([
      { name: 'customer.name', value: 'Max Mustermann' },
      { name: 'newsletter', value: 'true' },
      { name: 'tags', value: '["a", "b"]' },
      // text that only looks like a list stays text
      { name: 'note', value: '[draft' },
      { name: 'customer.name', value: 'Erika Mustermann' },
      { name: '', value: 'ignored' },
    ]);
    expect(values).toEqual({
      'customer.name': 'Erika Mustermann',
      newsletter: true,
      tags: ['a', 'b'],
      note: '[draft',
    });
    expect(fillFields({ values, flatten: true, lenient: true })).toMatchObject({
      fields: values,
      flatten: true,
      strict: false,
    });
    // flatten alone takes no values
    expect(fillFields({ values: {}, flatten: true })).not.toHaveProperty(
      'fields',
    );
    expect(() => fillFields({ values: {} })).toThrow(/at least one field/);
  });

  it('goes as form fields in a multipart request, a box of none as null', () => {
    expect(formValue(['1', '2-'])).toBe('["1","2-"]');
    expect(formValue(null)).toBe('null');
    expect(formValue(true)).toBe('true');
  });

  it("names a result after its link, and a chosen name keeps the result's extension", () => {
    expect(
      linkName(
        'https://cdn.test/o/eu/ws/2026/11/rnd_1/contract-3.png?exp=1&sig=2',
      ),
    ).toBe('contract-3.png');
    expect(
      linkName(
        'https://cdn.test/o/eu/ws/2026/11/rnd_1/Antrag%20Mustermann.pdf',
      ),
    ).toBe('Antrag Mustermann.pdf');
    expect(linkName(undefined)).toBeUndefined();
    expect(downloadName('parts.zip', 'rnd_1', 'zip')).toBe('parts.zip');
    expect(downloadName('parts', 'rnd_1', 'zip')).toBe('parts.zip');
  });
});

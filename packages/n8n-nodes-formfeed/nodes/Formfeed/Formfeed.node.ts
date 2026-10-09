import type {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodeProperties,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  JsonObject,
} from 'n8n-workflow';
import {
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow';
import {
  baseUrl,
  channelOptions,
  convertFields,
  downloadName,
  einvoiceOptions,
  formValue,
  invoiceBlock,
  libraryName,
  pdfNameFor,
  mergeData,
  nestData,
  renderBody,
  schemaFields,
  type ChannelSummary,
  type FormfeedCredentials,
  type InvoiceBreakdownFields,
  type InvoiceFields,
  type InvoiceLineFields,
  type InvoicePartyFields,
  type OutputFormat,
} from '../../lib/api';

/** Shows a field for the Create E-Invoice operation only. */
const EINVOICE = {
  show: { resource: ['render'], operation: ['createEinvoice'] },
};

/** The VAT categories of EN 16931 (UNCL 5305), ordered by name as n8n's verification wants. */
const VAT_CATEGORY: INodeProperties = {
  displayName: 'VAT Category',
  name: 'vatCategory',
  type: 'options',
  default: 'S',
  options: [
    { name: 'Exempt (E)', value: 'E' },
    { name: 'Export Outside the EU (G)', value: 'G' },
    { name: 'Intra-Community Supply (K)', value: 'K' },
    { name: 'Not Subject to VAT (O)', value: 'O' },
    { name: 'Reverse Charge (AE)', value: 'AE' },
    { name: 'Standard Rate (S)', value: 'S' },
    { name: 'Zero Rated (Z)', value: 'Z' },
  ],
};

const VAT_RATE: INodeProperties = {
  displayName: 'VAT Rate',
  name: 'vatRate',
  type: 'number',
  typeOptions: { numberPrecision: 2 },
  default: 19,
  description: 'Percent, 19 for 19 %; left out for category O',
};

/**
 * The fields of a seller or a buyer, ordered by name as n8n's verification wants; only the seller
 * states its further legal information.
 */
function party(seller: boolean): INodeProperties[] {
  return [
    { displayName: 'City', name: 'city', type: 'string', default: '' },
    {
      displayName: 'Contact Email',
      name: 'contactEmail',
      type: 'string',
      default: '',
      placeholder: 'name@email.com',
    },
    {
      displayName: 'Contact Name',
      name: 'contactName',
      type: 'string',
      default: '',
    },
    {
      displayName: 'Contact Phone',
      name: 'contactPhone',
      type: 'string',
      default: '',
    },
    {
      displayName: 'Country Code',
      name: 'country',
      type: 'string',
      default: '',
      placeholder: 'DE',
      description: 'ISO 3166-1, two letters',
    },
    {
      displayName: 'Electronic Address',
      name: 'electronicAddress',
      type: 'string',
      default: '',
      description: 'Where the party receives e-invoices, as an e-mail address',
    },
    ...(seller
      ? [
          {
            displayName: 'Legal Information',
            name: 'legalInfo',
            type: 'string',
            default: '',
            description:
              'What the invoice states besides: register court, managing directors, capital',
          } satisfies INodeProperties,
        ]
      : []),
    { displayName: 'Name', name: 'name', type: 'string', default: '' },
    { displayName: 'Postcode', name: 'postcode', type: 'string', default: '' },
    {
      displayName: 'Register Entry',
      name: 'legalRegistration',
      type: 'string',
      default: '',
      description: 'A company number such as HRB 00000, or a SIREN',
    },
    { displayName: 'Street', name: 'street', type: 'string', default: '' },
    {
      displayName: 'VAT ID',
      name: 'vatId',
      type: 'string',
      default: '',
      placeholder: 'DE000000000',
    },
  ];
}

/** One of the totals EN 16931 asks for, as the source system states it. */
function total(displayName: string, name: string): INodeProperties {
  return {
    displayName,
    name,
    type: 'number',
    typeOptions: { numberPrecision: 2 },
    displayOptions: EINVOICE,
    default: 0,
    required: true,
  };
}

/**
 * Formfeed node: renders documents and reads templates, renders and jobs (spec 10 §2).
 * Requests go through n8n's HTTP helper so credentials, proxies and retries behave as users expect.
 */
export class Formfeed implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Formfeed',
    name: 'formfeed',
    icon: {
      light: 'file:../../icons/formfeed.svg',
      dark: 'file:../../icons/formfeed.dark.svg',
    },
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description:
      'Generate PDFs, images and Word or PowerPoint documents from templates, and convert office files to PDF',
    defaults: { name: 'Formfeed' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    // lets n8n's AI Agent node call every operation as a tool; n8n builds the tool from this description
    usableAsTool: true,
    credentials: [{ name: 'formfeedApi', required: true }],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'render',
        // n8n's verification wants every option list in alphabetical order
        options: [
          { name: 'File', value: 'file' },
          { name: 'Job', value: 'job' },
          { name: 'PDF', value: 'pdf' },
          { name: 'Render', value: 'render' },
          { name: 'Template', value: 'template' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['pdf'] } },
        default: 'convert',
        options: [
          {
            name: 'Convert Office Document',
            value: 'convert',
            description:
              'Turn a Word, Excel, PowerPoint, OpenDocument or RTF file into a PDF (Starter plan and above)',
            action: 'Convert an office document to PDF',
          },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['render'] } },
        default: 'create',
        // five options and more are checked for alphabetical order by n8n's scan
        options: [
          {
            name: 'Create',
            value: 'create',
            description: 'Render a document',
            action: 'Render a document',
          },
          {
            name: 'Create E-Invoice',
            value: 'createEinvoice',
            description:
              'Render a ZUGFeRD / Factur-X invoice: a PDF/A-3 that carries the invoice as XML, validated before it is delivered (Starter plan and above)',
            // n8n's sentence case turns the hyphen of "e-invoice" into a space
            action: 'Create an electronic invoice',
          },
          {
            name: 'Delete Outputs',
            value: 'deleteOutputs',
            description: 'Remove the stored files',
            action: 'Delete render outputs',
          },
          {
            name: 'Get',
            value: 'get',
            description: 'Read one render',
            action: 'Get a render',
          },
          {
            name: 'Get Many',
            value: 'getAll',
            description: 'List renders',
            action: 'Get many renders',
          },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['template'] } },
        default: 'getAll',
        options: [
          {
            name: 'Get Many',
            value: 'getAll',
            description: 'List templates',
            action: 'Get many templates',
          },
          {
            name: 'Get',
            value: 'get',
            description: 'Read one template',
            action: 'Get a template',
          },
          {
            name: 'Get Schema',
            value: 'getSchema',
            description: 'Read the data schema',
            action: 'Get a template schema',
          },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['job'] } },
        default: 'get',
        options: [
          {
            name: 'Get',
            value: 'get',
            description: 'Read a batch job',
            action: 'Get a job',
          },
        ],
      },

      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['file'] } },
        default: 'upload',
        options: [
          {
            name: 'Upload',
            value: 'upload',
            description: 'Upload an image or PDF to the file library',
            action: 'Upload a file',
          },
          {
            name: 'Get Many',
            value: 'getAll',
            description: 'List the file library',
            action: 'Get many files',
          },
          {
            name: 'Delete',
            value: 'delete',
            description: 'Remove a file from the library',
            action: 'Delete a file',
          },
        ],
      },

      // --- file ------------------------------------------------------------------------------
      {
        displayName: 'Input Binary Field',
        name: 'binaryPropertyName',
        type: 'string',
        displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
        default: 'data',
        required: true,
        description:
          'The binary field of the incoming item that holds the image or PDF',
      },
      {
        displayName: 'Name in Library',
        name: 'fileName',
        type: 'string',
        displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
        default: '',
        placeholder: 'brand/logo.png',
        description:
          "The name templates use with asset(). Leave empty to use the binary's file name. Uploading a name again replaces that file.",
      },
      {
        displayName: 'Prefix',
        name: 'prefix',
        type: 'string',
        displayOptions: { show: { resource: ['file'], operation: ['getAll'] } },
        default: '',
        placeholder: 'brand/',
        description: 'Only files whose name starts with this',
      },
      {
        displayName: 'File ID',
        name: 'fileId',
        type: 'string',
        displayOptions: { show: { resource: ['file'], operation: ['delete'] } },
        default: '',
        required: true,
        placeholder: 'fil_…',
      },

      // --- pdf: convert ---------------------------------------------------------------------
      {
        displayName: 'Document',
        name: 'convertSource',
        type: 'options',
        displayOptions: { show: { resource: ['pdf'], operation: ['convert'] } },
        default: 'binary',
        options: [
          {
            name: 'Binary Field of the Item',
            value: 'binary',
            description:
              'An uploaded document of up to 20 MB; it is converted and not kept',
          },
          {
            name: 'Render of a Word or PowerPoint Template',
            value: 'render',
            description: 'A render whose output is DOCX or PPTX',
          },
        ],
      },
      {
        displayName: 'Input Binary Field',
        name: 'convertBinaryPropertyName',
        type: 'string',
        displayOptions: {
          show: {
            resource: ['pdf'],
            operation: ['convert'],
            convertSource: ['binary'],
          },
        },
        default: 'data',
        required: true,
        description:
          'The binary field of the incoming item that holds the document',
      },
      {
        displayName: 'Render ID',
        name: 'convertRenderId',
        type: 'string',
        displayOptions: {
          show: {
            resource: ['pdf'],
            operation: ['convert'],
            convertSource: ['render'],
          },
        },
        default: '',
        required: true,
        placeholder: 'rnd_…',
      },
      {
        displayName: 'Download File',
        name: 'convertDownload',
        type: 'boolean',
        displayOptions: { show: { resource: ['pdf'], operation: ['convert'] } },
        default: true,
        description:
          'Whether to attach the PDF as binary data instead of returning only the URL',
      },
      {
        displayName: 'Options',
        name: 'convertOptions',
        type: 'collection',
        placeholder: 'Add option',
        displayOptions: { show: { resource: ['pdf'], operation: ['convert'] } },
        default: {},
        options: [
          {
            displayName: 'Filename',
            name: 'filename',
            type: 'string',
            default: '',
            description: 'Name of the PDF',
          },
          {
            displayName: 'Landscape',
            name: 'landscape',
            type: 'boolean',
            default: false,
            description:
              'Whether spreadsheets and documents without their own page setup are converted in landscape',
          },
          {
            displayName: 'Page Ranges',
            name: 'pageRanges',
            type: 'string',
            default: '',
            placeholder: '1-3,5',
          },
          {
            displayName: 'Single Page Sheets',
            name: 'singlePageSheets',
            type: 'boolean',
            default: false,
            description: 'Whether each spreadsheet sheet is put on one page',
          },
        ],
      },

      // --- render: create -------------------------------------------------------------------
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        displayOptions: {
          show: { resource: ['render'], operation: ['create'] },
        },
        default: 'template',
        options: [
          { name: 'Template', value: 'template' },
          { name: 'HTML', value: 'html' },
          { name: 'URL', value: 'url' },
        ],
      },
      {
        displayName: 'Template Name or ID',
        name: 'template',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getTemplates' },
        displayOptions: {
          show: {
            resource: ['render'],
            operation: ['create'],
            source: ['template'],
          },
        },
        default: '',
        required: true,
        description:
          'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
      },
      {
        displayName: 'Fields',
        name: 'fields',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        displayOptions: {
          show: {
            resource: ['render'],
            operation: ['create'],
            source: ['template'],
          },
        },
        default: {},
        description:
          'Values for the template fields; the names come from the template data schema',
        options: [
          {
            name: 'field',
            displayName: 'Field',
            values: [
              {
                displayName: 'Field Name or ID',
                name: 'path',
                type: 'options',
                typeOptions: {
                  loadOptionsMethod: 'getTemplateFields',
                  loadOptionsDependsOn: ['template'],
                },
                default: '',
                description:
                  'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
              },
              {
                displayName: 'Value',
                name: 'value',
                type: 'string',
                default: '',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Data (JSON)',
        name: 'dataJson',
        type: 'json',
        displayOptions: {
          show: { resource: ['render'], operation: ['create'] },
        },
        default: '{}',
        description:
          'Merged with the mapped fields; use it for lists and nested objects',
      },
      {
        displayName: 'HTML',
        name: 'html',
        type: 'string',
        typeOptions: { rows: 6 },
        displayOptions: {
          show: {
            resource: ['render'],
            operation: ['create'],
            source: ['html'],
          },
        },
        default: '',
        required: true,
      },
      {
        displayName: 'Engine',
        name: 'engine',
        type: 'options',
        displayOptions: {
          show: {
            resource: ['render'],
            operation: ['create'],
            source: ['html'],
          },
        },
        default: 'jinja2',
        options: [
          { name: 'Jinja2', value: 'jinja2' },
          { name: 'Liquid', value: 'liquid' },
          { name: 'Handlebars', value: 'handlebars' },
        ],
      },
      {
        displayName: 'URL',
        name: 'url',
        type: 'string',
        displayOptions: {
          show: {
            resource: ['render'],
            operation: ['create'],
            source: ['url'],
          },
        },
        default: '',
        required: true,
        placeholder: 'https://example.com/invoice/42',
      },
      {
        displayName: 'Output',
        name: 'output',
        type: 'options',
        displayOptions: {
          show: { resource: ['render'], operation: ['create'] },
        },
        default: '',
        description:
          'The format of the file. As the Template renders PDF, the image format of an image template, or the default output of a Word or PowerPoint template; HTML and URLs render PDF. Word templates render DOCX or PDF, PowerPoint templates PPTX or PDF.',
        options: [
          { name: 'As the Template', value: '' },
          { name: 'JPG', value: 'jpg' },
          { name: 'PDF', value: 'pdf' },
          { name: 'PNG', value: 'png' },
          { name: 'PowerPoint (PPTX)', value: 'pptx' },
          { name: 'WebP', value: 'webp' },
          { name: 'Word (DOCX)', value: 'docx' },
        ],
      },
      {
        displayName: 'Download File',
        name: 'download',
        type: 'boolean',
        displayOptions: {
          show: { resource: ['render'], operation: ['create'] },
        },
        default: true,
        description:
          'Whether to attach the rendered document as binary data instead of returning only the URL',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        displayOptions: {
          show: { resource: ['render'], operation: ['create'] },
        },
        default: {},
        options: [
          {
            displayName: 'Filename',
            name: 'filename',
            type: 'string',
            default: '',
          },
          {
            displayName: 'Locale',
            name: 'locale',
            type: 'string',
            default: '',
            placeholder: 'de-DE',
          },
          {
            displayName: 'Mode',
            name: 'mode',
            type: 'options',
            default: 'sync',
            options: [
              { name: 'Wait for the Document', value: 'sync' },
              { name: 'Queue and Return Immediately', value: 'async' },
            ],
          },
          {
            displayName: 'Settings (JSON)',
            name: 'settingsJson',
            type: 'json',
            default: '{}',
          },
          {
            displayName: 'Version Name or ID',
            name: 'version',
            type: 'options',
            typeOptions: {
              loadOptionsMethod: 'getTemplateVersions',
              loadOptionsDependsOn: ['template'],
            },
            default: 'published',
            // n8n's verification wants exactly this sentence under a list it loads; ours goes in the hint
            description:
              'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
            hint: 'The release channel to render, or a version number',
          },
          {
            displayName: 'Webhook URL',
            name: 'webhookUrl',
            type: 'string',
            default: '',
          },
        ],
      },

      // --- render: create e-invoice (spec 17) ------------------------------------------------
      // The template prints the same `_invoice` block the XML is built from, so every value is
      // mapped once. Nothing is computed: totals and the VAT breakdown are the source system's.
      {
        displayName: 'Template Name or ID',
        name: 'template',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getTemplates' },
        displayOptions: EINVOICE,
        default: '',
        required: true,
        description:
          'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
        hint: 'A PDF template that prints the _invoice block, such as the E-invoice example of the gallery in the Formfeed app',
      },
      {
        displayName: 'Invoice Number',
        name: 'invoiceNumber',
        type: 'string',
        displayOptions: EINVOICE,
        default: '',
        required: true,
      },
      {
        displayName: 'Issue Date',
        name: 'issueDate',
        type: 'dateTime',
        displayOptions: EINVOICE,
        default: '',
        required: true,
      },
      {
        displayName: 'Currency',
        name: 'currency',
        type: 'string',
        displayOptions: EINVOICE,
        default: 'EUR',
        description: 'ISO 4217, for example EUR',
      },
      {
        displayName: 'Seller',
        name: 'seller',
        type: 'fixedCollection',
        placeholder: 'Add Seller',
        displayOptions: EINVOICE,
        default: {},
        options: [
          { name: 'details', displayName: 'Seller', values: party(true) },
        ],
      },
      {
        displayName: 'Buyer',
        name: 'buyer',
        type: 'fixedCollection',
        placeholder: 'Add Buyer',
        displayOptions: EINVOICE,
        default: {},
        options: [
          { name: 'details', displayName: 'Buyer', values: party(false) },
        ],
      },
      {
        displayName: 'Lines',
        name: 'lines',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        placeholder: 'Add Line',
        displayOptions: EINVOICE,
        default: {},
        options: [
          {
            name: 'line',
            displayName: 'Line',
            // ordered by name, as n8n's verification wants
            values: [
              {
                displayName: 'Description',
                name: 'description',
                type: 'string',
                default: '',
              },
              {
                displayName: 'Name',
                name: 'name',
                type: 'string',
                default: '',
              },
              {
                displayName: 'Net Amount',
                name: 'netAmount',
                type: 'number',
                typeOptions: { numberPrecision: 2 },
                default: 0,
                description:
                  'Quantity times net price, as the source system states it',
              },
              {
                displayName: 'Net Price',
                name: 'netPrice',
                type: 'number',
                typeOptions: { numberPrecision: 2 },
                default: 0,
              },
              {
                displayName: 'Quantity',
                name: 'quantity',
                type: 'number',
                default: 1,
              },
              {
                displayName: 'Unit Code',
                name: 'unitCode',
                type: 'string',
                default: 'C62',
                description:
                  'UN/ECE Recommendation 20: C62 a piece, HUR an hour, DAY a day, KGM a kilogram',
              },
              VAT_CATEGORY,
              VAT_RATE,
            ],
          },
        ],
      },
      {
        displayName: 'VAT Breakdown',
        name: 'vatBreakdown',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        placeholder: 'Add VAT Rate',
        displayOptions: EINVOICE,
        default: {},
        description:
          'One entry per VAT category and rate, with the amounts the source system states',
        options: [
          {
            name: 'entry',
            displayName: 'Entry',
            values: [
              {
                displayName: 'Exemption Reason',
                name: 'exemptionReason',
                type: 'string',
                default: '',
                description:
                  'Why no VAT is charged; required for the categories that charge none except zero rated',
              },
              {
                displayName: 'Taxable Amount',
                name: 'basis',
                type: 'number',
                typeOptions: { numberPrecision: 2 },
                default: 0,
              },
              {
                displayName: 'VAT Amount',
                name: 'amount',
                type: 'number',
                typeOptions: { numberPrecision: 2 },
                default: 0,
              },
              VAT_CATEGORY,
              VAT_RATE,
            ],
          },
        ],
      },
      total('Sum of Line Net Amounts', 'lineNet'),
      total('Total Without VAT', 'taxBasis'),
      total('VAT Total', 'taxTotal'),
      total('Total With VAT', 'grandTotal'),
      total('Amount Due', 'amountDue'),
      {
        displayName: 'Payment',
        name: 'payment',
        type: 'collection',
        placeholder: 'Add Payment Field',
        displayOptions: EINVOICE,
        default: {},
        options: [
          { displayName: 'BIC', name: 'bic', type: 'string', default: '' },
          {
            displayName: 'Due Date',
            name: 'dueDate',
            type: 'dateTime',
            default: '',
          },
          {
            displayName: 'IBAN',
            name: 'iban',
            type: 'string',
            default: '',
            placeholder: 'DE36 0000 0000 0000 0000 00',
          },
          {
            displayName: 'Payment Means',
            name: 'meansCode',
            type: 'options',
            default: '58',
            options: [
              { name: 'Credit Transfer (30)', value: '30' },
              { name: 'Payment Card (48)', value: '48' },
              { name: 'SEPA Credit Transfer (58)', value: '58' },
              { name: 'SEPA Direct Debit (59)', value: '59' },
            ],
          },
          {
            displayName: 'Payment Reference',
            name: 'reference',
            type: 'string',
            default: '',
            description:
              'What the payer quotes with the payment, often the invoice number',
          },
          {
            displayName: 'Payment Terms',
            name: 'terms',
            type: 'string',
            default: '',
          },
        ],
      },
      {
        displayName: 'Invoice (JSON)',
        name: 'invoiceJson',
        type: 'json',
        displayOptions: EINVOICE,
        default: '{}',
        description:
          'Merged over the fields above, for what they do not offer: credit notes, allowances and charges, the delivery, a direct debit mandate, French invoices. The fields are those of the _invoice block in the Formfeed documentation.',
      },
      {
        displayName: 'Download File',
        name: 'download',
        type: 'boolean',
        displayOptions: EINVOICE,
        default: true,
        description:
          'Whether to attach the e-invoice as binary data instead of returning only the URL',
      },
      {
        displayName: 'Options',
        name: 'einvoiceOptions',
        type: 'collection',
        placeholder: 'Add option',
        displayOptions: EINVOICE,
        default: {},
        options: [
          {
            displayName: 'Buyer Reference',
            name: 'buyerReference',
            type: 'string',
            default: '',
            description:
              "The buyer's reference, such as the Leitweg-ID a German authority asks for",
          },
          {
            displayName: 'Document Type',
            name: 'typeCode',
            type: 'options',
            default: '380',
            options: [
              { name: 'Credit Note', value: '381' },
              { name: 'Invoice', value: '380' },
            ],
          },
          {
            displayName: 'Filename',
            name: 'filename',
            type: 'string',
            default: '',
          },
          {
            displayName: 'Locale',
            name: 'locale',
            type: 'string',
            default: '',
            placeholder: 'de-DE',
          },
          { displayName: 'Note', name: 'note', type: 'string', default: '' },
          {
            displayName: 'Order Reference',
            name: 'orderReference',
            type: 'string',
            default: '',
          },
          {
            displayName: 'Paid Amount',
            name: 'prepaid',
            type: 'number',
            typeOptions: { numberPrecision: 2 },
            default: 0,
            description:
              'What was paid in advance; the amount due is the total less it',
          },
          {
            displayName: 'Profile',
            name: 'profile',
            type: 'options',
            default: 'en16931',
            options: [
              {
                name: 'Basic',
                value: 'basic',
                description:
                  'The smallest profile that is an invoice on its own; not for France',
              },
              {
                name: 'EN 16931',
                value: 'en16931',
                description:
                  'Every field of the European standard, the default',
              },
            ],
          },
          {
            displayName: 'Specification Name',
            name: 'flavour',
            type: 'options',
            default: 'factur-x',
            description:
              'One specification under two names; the file is the same',
            options: [
              { name: 'Factur-X', value: 'factur-x' },
              { name: 'ZUGFeRD', value: 'zugferd' },
            ],
          },
          {
            displayName: 'Store XML Separately',
            name: 'storeXml',
            type: 'boolean',
            default: false,
            description:
              'Whether to also store the XML as a file of its own, linked as einvoice.xml_url',
          },
          {
            displayName: 'Strict Display Check',
            name: 'strictDisplayCheck',
            type: 'boolean',
            default: false,
            description:
              'Whether to fail the render when the PDF does not show a value of the XML, such as the total, instead of reporting it',
          },
          {
            displayName: 'Version Name or ID',
            name: 'version',
            type: 'options',
            typeOptions: {
              loadOptionsMethod: 'getTemplateVersions',
              loadOptionsDependsOn: ['template'],
            },
            default: 'published',
            description:
              'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
            hint: 'The release channel to render, or a version number',
          },
        ],
      },

      // --- ids -------------------------------------------------------------------------------
      {
        displayName: 'Render ID',
        name: 'renderId',
        type: 'string',
        displayOptions: {
          show: { resource: ['render'], operation: ['get', 'deleteOutputs'] },
        },
        default: '',
        required: true,
      },
      {
        displayName: 'Job ID',
        name: 'jobId',
        type: 'string',
        displayOptions: { show: { resource: ['job'], operation: ['get'] } },
        default: '',
        required: true,
      },
      {
        displayName: 'Template Name or ID',
        name: 'templateId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getTemplates' },
        displayOptions: {
          show: { resource: ['template'], operation: ['get', 'getSchema'] },
        },
        default: '',
        required: true,
        description:
          'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
      },
      {
        displayName: 'Return All',
        name: 'returnAll',
        type: 'boolean',
        displayOptions: {
          show: {
            resource: ['render', 'template', 'file'],
            operation: ['getAll'],
          },
        },
        default: false,
        description:
          'Whether to return all results or only up to a given limit',
      },
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 100 },
        displayOptions: {
          show: {
            resource: ['render', 'template', 'file'],
            operation: ['getAll'],
            returnAll: [false],
          },
        },
        // n8n's convention for a limit, which its verification holds nodes to
        default: 50,
        description: 'Max number of results to return',
      },
    ],
  };

  methods = {
    loadOptions: {
      async getTemplates(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const page = (await request(this, 'GET', '/templates?limit=100')) as {
          data?: Array<{ slug: string; name: string; kind: string }>;
        };
        return (page.data ?? []).map((template) => ({
          name: `${template.name} (${template.kind})`,
          value: template.slug,
        }));
      },

      async getTemplateVersions(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const template = this.getNodeParameter('template', '') as string;
        const published = [
          {
            name: 'Published',
            value: 'published',
            description: 'The published version, the default',
          },
        ];
        if (!template) return published;
        try {
          const channels = (await request(
            this,
            'GET',
            `/templates/${encodeURIComponent(template)}/channels`,
          )) as { data?: ChannelSummary[] };
          return channelOptions(channels.data ?? []);
        } catch {
          return published;
        }
      },

      async getTemplateFields(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const template = this.getNodeParameter('template', '') as string;
        if (!template) return [];
        try {
          const schema = await request(
            this,
            'GET',
            `/templates/${encodeURIComponent(template)}/schema`,
          );
          return schemaFields(schema).map((field) => ({
            name: `${field.path}${field.required ? ' *' : ''} (${field.type})`,
            value: field.path,
            description: field.description ?? '',
          }));
        } catch {
          // no stored schema: the user maps with the JSON field instead
          return [];
        }
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        const resource = this.getNodeParameter('resource', i) as string;
        const operation = this.getNodeParameter('operation', i) as string;

        if (resource === 'render' && operation === 'create') {
          const source = this.getNodeParameter('source', i) as
            'template' | 'html' | 'url';
          const options = this.getNodeParameter(
            'options',
            i,
            {},
          ) as IDataObject;
          const mapped = this.getNodeParameter('fields.field', i, []) as Array<{
            path: string;
            value: string;
          }>;
          const json = parseJson(
            this,
            i,
            this.getNodeParameter('dataJson', i, '{}'),
          );
          const settings = parseJson(
            this,
            i,
            (options['settingsJson'] as string) ?? '{}',
          );

          const body = renderBody({
            source,
            template:
              source === 'template'
                ? (this.getNodeParameter('template', i) as string)
                : undefined,
            html:
              source === 'html'
                ? (this.getNodeParameter('html', i) as string)
                : undefined,
            engine:
              source === 'html'
                ? (this.getNodeParameter('engine', i) as 'jinja2')
                : undefined,
            url:
              source === 'url'
                ? (this.getNodeParameter('url', i) as string)
                : undefined,
            data: mergeData(
              nestData(
                Object.fromEntries(mapped.map((f) => [f.path, f.value])),
              ),
              json,
            ),
            output:
              (this.getNodeParameter('output', i, '') as OutputFormat | '') ||
              undefined,
            filename: options['filename'] as string,
            locale: options['locale'] as string,
            version:
              source === 'template'
                ? (options['version'] as string)
                : undefined,
            mode: options['mode'] as 'sync' | 'async',
            webhookUrl: options['webhookUrl'] as string,
            settings,
          });

          out.push(
            await renderItem(this, i, body, options['filename'] as string),
          );
          continue;
        }

        if (resource === 'render' && operation === 'createEinvoice') {
          const options = this.getNodeParameter(
            'einvoiceOptions',
            i,
            {},
          ) as IDataObject;
          const fields: InvoiceFields = {
            number: this.getNodeParameter('invoiceNumber', i) as string,
            issueDate: this.getNodeParameter('issueDate', i) as string,
            currency: this.getNodeParameter('currency', i, 'EUR') as string,
            typeCode: options['typeCode'] as string,
            buyerReference: options['buyerReference'] as string,
            orderReference: options['orderReference'] as string,
            note: options['note'] as string,
            seller: this.getNodeParameter(
              'seller.details',
              i,
              {},
            ) as InvoicePartyFields,
            buyer: this.getNodeParameter(
              'buyer.details',
              i,
              {},
            ) as InvoicePartyFields,
            lines: this.getNodeParameter(
              'lines.line',
              i,
              [],
            ) as InvoiceLineFields[],
            breakdown: this.getNodeParameter(
              'vatBreakdown.entry',
              i,
              [],
            ) as InvoiceBreakdownFields[],
            totals: {
              lineNet: this.getNodeParameter('lineNet', i) as number,
              taxBasis: this.getNodeParameter('taxBasis', i) as number,
              taxTotal: this.getNodeParameter('taxTotal', i) as number,
              grand: this.getNodeParameter('grandTotal', i) as number,
              due: this.getNodeParameter('amountDue', i) as number,
              prepaid: options['prepaid'] as number | undefined,
            },
            payment: this.getNodeParameter(
              'payment',
              i,
              {},
            ) as InvoiceFields['payment'],
          };
          // the JSON field wins per leaf, for what the fields do not offer
          const invoice = mergeData(
            invoiceBlock(fields),
            parseJson(this, i, this.getNodeParameter('invoiceJson', i, '{}')),
          );
          const body = renderBody({
            source: 'template',
            template: this.getNodeParameter('template', i) as string,
            version: options['version'] as string,
            data: { _invoice: invoice },
            output: 'pdf',
            filename: options['filename'] as string,
            locale: options['locale'] as string,
            post: {
              einvoice: einvoiceOptions({
                profile: options['profile'] as string,
                flavour: options['flavour'] as string,
                storeXml: options['storeXml'] as boolean,
                strictDisplayCheck: options['strictDisplayCheck'] as boolean,
              }),
            },
          });
          out.push(
            await renderItem(this, i, body, options['filename'] as string),
          );
          continue;
        }

        if (resource === 'pdf' && operation === 'convert') {
          const options = this.getNodeParameter(
            'convertOptions',
            i,
            {},
          ) as IDataObject;
          const fromRender =
            this.getNodeParameter('convertSource', i, 'binary') === 'render';
          const fields = convertFields({
            renderId: fromRender
              ? (this.getNodeParameter('convertRenderId', i) as string)
              : undefined,
            pageRanges: options['pageRanges'] as string,
            landscape: options['landscape'] as boolean,
            singlePageSheets: options['singlePageSheets'] as boolean,
            filename: options['filename'] as string,
          });
          let body: unknown = fields;
          if (!fromRender) {
            const property = this.getNodeParameter(
              'convertBinaryPropertyName',
              i,
            ) as string;
            const binary = this.helpers.assertBinaryData(i, property);
            const bytes = await this.helpers.getBinaryDataBuffer(i, property);
            const fileName = binary.fileName || 'document';
            // the uploaded name, as a PDF, unless one was chosen
            fields['filename'] ??= pdfNameFor(fileName);
            const form = new FormData();
            form.append(
              'file',
              new Blob([new Uint8Array(bytes)], { type: binary.mimeType }),
              fileName,
            );
            for (const [key, value] of Object.entries(fields))
              form.append(key, formValue(value));
            body = form;
          }
          const render = (await request(
            this,
            'POST',
            '/pdf/convert',
            body,
          )) as IDataObject & { download_url?: string };
          const item: INodeExecutionData = {
            json: render,
            pairedItem: { item: i },
          };
          if (
            this.getNodeParameter('convertDownload', i, true) &&
            render.download_url
          ) {
            const name =
              (fields['filename'] as string | undefined) ??
              `${render['id'] as string}.pdf`;
            item.binary = {
              data: await downloadBinary(this, render.download_url, name),
            };
          }
          out.push(item);
          continue;
        }

        if (resource === 'render' && operation === 'get') {
          const id = this.getNodeParameter('renderId', i) as string;
          out.push({
            json: (await request(
              this,
              'GET',
              `/renders/${encodeURIComponent(id)}`,
            )) as IDataObject,
            pairedItem: { item: i },
          });
          continue;
        }

        if (resource === 'render' && operation === 'deleteOutputs') {
          const id = this.getNodeParameter('renderId', i) as string;
          await request(
            this,
            'DELETE',
            `/renders/${encodeURIComponent(id)}/outputs`,
          );
          out.push({ json: { id, deleted: true }, pairedItem: { item: i } });
          continue;
        }

        if (resource === 'file' && operation === 'upload') {
          const property = this.getNodeParameter(
            'binaryPropertyName',
            i,
          ) as string;
          const binary = this.helpers.assertBinaryData(i, property);
          const name = libraryName(
            this.getNodeParameter('fileName', i, '') as string,
            binary.fileName,
          );
          if (!name)
            throw new NodeOperationError(
              this.getNode(),
              'The name is not a library file name: letters, digits, dot, dash, underscore and / for folders',
              { itemIndex: i },
            );
          const bytes = await this.helpers.getBinaryDataBuffer(i, property);
          const form = new FormData();
          form.append(
            'file',
            new Blob([new Uint8Array(bytes)], { type: binary.mimeType }),
            name.split('/').pop(),
          );
          form.append('name', name);
          out.push({
            json: (await request(this, 'POST', '/files', form)) as IDataObject,
            pairedItem: { item: i },
          });
          continue;
        }

        if (resource === 'file' && operation === 'delete') {
          const id = this.getNodeParameter('fileId', i) as string;
          await request(this, 'DELETE', `/files/${encodeURIComponent(id)}`);
          out.push({ json: { id, deleted: true }, pairedItem: { item: i } });
          continue;
        }

        if (
          (resource === 'render' ||
            resource === 'template' ||
            resource === 'file') &&
          operation === 'getAll'
        ) {
          const prefix =
            resource === 'file'
              ? (this.getNodeParameter('prefix', i, '') as string)
              : '';
          const path =
            resource === 'render'
              ? '/renders'
              : resource === 'template'
                ? '/templates'
                : '/files';
          const returnAll = this.getNodeParameter(
            'returnAll',
            i,
            false,
          ) as boolean;
          const limit = returnAll
            ? 100
            : (this.getNodeParameter('limit', i, 25) as number);
          let cursor: string | null = null;
          do {
            const query = `?limit=${limit}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
            const page = (await request(this, 'GET', `${path}${query}`)) as {
              data?: IDataObject[];
              next_cursor?: string | null;
            };
            for (const row of page.data ?? [])
              out.push({ json: row, pairedItem: { item: i } });
            cursor = returnAll ? (page.next_cursor ?? null) : null;
          } while (cursor);
          continue;
        }

        if (resource === 'template' && operation === 'get') {
          const id = this.getNodeParameter('templateId', i) as string;
          out.push({
            json: (await request(
              this,
              'GET',
              `/templates/${encodeURIComponent(id)}`,
            )) as IDataObject,
            pairedItem: { item: i },
          });
          continue;
        }

        if (resource === 'template' && operation === 'getSchema') {
          const id = this.getNodeParameter('templateId', i) as string;
          const schema = await request(
            this,
            'GET',
            `/templates/${encodeURIComponent(id)}/schema`,
          );
          out.push({
            json: { schema, fields: schemaFields(schema) } as IDataObject,
            pairedItem: { item: i },
          });
          continue;
        }

        if (resource === 'job' && operation === 'get') {
          const id = this.getNodeParameter('jobId', i) as string;
          out.push({
            json: (await request(
              this,
              'GET',
              `/jobs/${encodeURIComponent(id)}`,
            )) as IDataObject,
            pairedItem: { item: i },
          });
          continue;
        }

        throw new NodeOperationError(
          this.getNode(),
          `Unsupported operation ${resource}.${operation}`,
          { itemIndex: i },
        );
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({
            json: { error: (error as Error).message },
            pairedItem: { item: i },
          });
          continue;
        }
        // Both constructors hand back an error that already is of their class, so an API error keeps
        // its HTTP details and our own NodeOperationError stays as it was; anything else is wrapped.
        throw error instanceof NodeApiError
          ? new NodeApiError(this.getNode(), error as unknown as JsonObject, {
              itemIndex: i,
            })
          : new NodeOperationError(this.getNode(), error as Error, {
              itemIndex: i,
            });
      }
    }

    return [out];
  }
}

/** One request against the workspace's API host, with the credential's key. */
async function request(
  context: IExecuteFunctions | ILoadOptionsFunctions,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const credentials = (await context.getCredentials(
    'formfeedApi',
  )) as unknown as FormfeedCredentials;
  // A FormData body is a file upload: the HTTP helper sets the multipart boundary itself.
  const isForm = body instanceof FormData;
  return context.helpers.httpRequestWithAuthentication.call(
    context,
    'formfeedApi',
    {
      method,
      url: `${baseUrl(credentials)}${path}`,
      json: !isForm,
      ...(body === undefined ? {} : { body: body as IDataObject }),
    },
  );
}

/** Renders, and attaches the document as binary data where the item asks for it. */
async function renderItem(
  context: IExecuteFunctions,
  i: number,
  body: Record<string, unknown>,
  filename: string | undefined,
): Promise<INodeExecutionData> {
  const render = (await request(
    context,
    'POST',
    '/renders',
    body,
  )) as IDataObject & { download_url?: string; output?: string };
  const item: INodeExecutionData = { json: render, pairedItem: { item: i } };
  if (context.getNodeParameter('download', i, true) && render.download_url)
    item.binary = {
      data: await downloadBinary(
        context,
        render.download_url,
        downloadName(filename, render['id'] as string, render.output),
      ),
    };
  return item;
}

/** Downloads a stored output (a signed URL, no key needed) as n8n binary data. */
async function downloadBinary(
  context: IExecuteFunctions,
  url: string,
  name: string,
) {
  const file = (await context.helpers.httpRequest({
    method: 'GET',
    url,
    encoding: 'arraybuffer',
    returnFullResponse: false,
  })) as ArrayBuffer;
  return context.helpers.prepareBinaryData(Buffer.from(file), name);
}

function parseJson(
  context: IExecuteFunctions,
  itemIndex: number,
  value: unknown,
): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    throw new NodeOperationError(
      context.getNode(),
      'The JSON field is not valid JSON',
      { itemIndex },
    );
  }
}

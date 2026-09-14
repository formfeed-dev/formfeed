import type {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import {
  baseUrl,
  libraryName,
  mergeData,
  nestData,
  renderBody,
  schemaFields,
  type FormfeedCredentials,
} from '../../lib/api';

/**
 * Formfeed node: renders documents and reads templates, renders and jobs (spec 10 §2).
 * Requests go through n8n's HTTP helper so credentials, proxies and retries behave as users expect.
 */
export class Formfeed implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Formfeed',
    name: 'formfeed',
    icon: 'file:formfeed.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: 'Generate PDFs and images from templates',
    defaults: { name: 'Formfeed' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'formfeedApi', required: true }],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'render',
        options: [
          { name: 'Render', value: 'render' },
          { name: 'Template', value: 'template' },
          { name: 'Job', value: 'job' },
          { name: 'File', value: 'file' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['render'] } },
        default: 'create',
        options: [
          { name: 'Create', value: 'create', description: 'Render a document', action: 'Render a document' },
          { name: 'Get', value: 'get', description: 'Read one render', action: 'Get a render' },
          { name: 'Get Many', value: 'getAll', description: 'List renders', action: 'Get many renders' },
          { name: 'Delete Outputs', value: 'deleteOutputs', description: 'Remove the stored files', action: 'Delete render outputs' },
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
          { name: 'Get Many', value: 'getAll', description: 'List templates', action: 'Get many templates' },
          { name: 'Get', value: 'get', description: 'Read one template', action: 'Get a template' },
          { name: 'Get Schema', value: 'getSchema', description: 'Read the data schema', action: 'Get a template schema' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['job'] } },
        default: 'get',
        options: [{ name: 'Get', value: 'get', description: 'Read a batch job', action: 'Get a job' }],
      },

      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['file'] } },
        default: 'upload',
        options: [
          { name: 'Upload', value: 'upload', description: 'Upload an image or PDF to the file library', action: 'Upload a file' },
          { name: 'Get Many', value: 'getAll', description: 'List the file library', action: 'Get many files' },
          { name: 'Delete', value: 'delete', description: 'Remove a file from the library', action: 'Delete a file' },
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
        description: 'The binary field of the incoming item that holds the image or PDF',
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

      // --- render: create -------------------------------------------------------------------
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        displayOptions: { show: { resource: ['render'], operation: ['create'] } },
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
        displayOptions: { show: { resource: ['render'], operation: ['create'], source: ['template'] } },
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
        displayOptions: { show: { resource: ['render'], operation: ['create'], source: ['template'] } },
        default: {},
        description: 'Values for the template fields; the names come from the template data schema',
        options: [
          {
            name: 'field',
            displayName: 'Field',
            values: [
              {
                displayName: 'Field Name or ID',
                name: 'path',
                type: 'options',
                typeOptions: { loadOptionsMethod: 'getTemplateFields', loadOptionsDependsOn: ['template'] },
                default: '',
                description:
                  'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
              },
              { displayName: 'Value', name: 'value', type: 'string', default: '' },
            ],
          },
        ],
      },
      {
        displayName: 'Data (JSON)',
        name: 'dataJson',
        type: 'json',
        displayOptions: { show: { resource: ['render'], operation: ['create'] } },
        default: '{}',
        description: 'Merged with the mapped fields; use it for lists and nested objects',
      },
      {
        displayName: 'HTML',
        name: 'html',
        type: 'string',
        typeOptions: { rows: 6 },
        displayOptions: { show: { resource: ['render'], operation: ['create'], source: ['html'] } },
        default: '',
        required: true,
      },
      {
        displayName: 'Engine',
        name: 'engine',
        type: 'options',
        displayOptions: { show: { resource: ['render'], operation: ['create'], source: ['html'] } },
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
        displayOptions: { show: { resource: ['render'], operation: ['create'], source: ['url'] } },
        default: '',
        required: true,
        placeholder: 'https://example.com/invoice/42',
      },
      {
        displayName: 'Output',
        name: 'output',
        type: 'options',
        displayOptions: { show: { resource: ['render'], operation: ['create'] } },
        default: '',
        description: 'The format of the file. As the Template renders PDF, or the image format of an image template; HTML and URLs render PDF.',
        options: [
          { name: 'As the Template', value: '' },
          { name: 'PDF', value: 'pdf' },
          { name: 'PNG', value: 'png' },
          { name: 'JPG', value: 'jpg' },
          { name: 'WebP', value: 'webp' },
        ],
      },
      {
        displayName: 'Download File',
        name: 'download',
        type: 'boolean',
        displayOptions: { show: { resource: ['render'], operation: ['create'] } },
        default: true,
        description: 'Whether to attach the rendered document as binary data instead of returning only the URL',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        displayOptions: { show: { resource: ['render'], operation: ['create'] } },
        default: {},
        options: [
          { displayName: 'Filename', name: 'filename', type: 'string', default: '' },
          { displayName: 'Locale', name: 'locale', type: 'string', default: '', placeholder: 'de-DE' },
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
          { displayName: 'Webhook URL', name: 'webhookUrl', type: 'string', default: '' },
          { displayName: 'Settings (JSON)', name: 'settingsJson', type: 'json', default: '{}' },
        ],
      },

      // --- ids -------------------------------------------------------------------------------
      {
        displayName: 'Render ID',
        name: 'renderId',
        type: 'string',
        displayOptions: { show: { resource: ['render'], operation: ['get', 'deleteOutputs'] } },
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
        displayOptions: { show: { resource: ['template'], operation: ['get', 'getSchema'] } },
        default: '',
        required: true,
        description:
          'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
      },
      {
        displayName: 'Return All',
        name: 'returnAll',
        type: 'boolean',
        displayOptions: { show: { resource: ['render', 'template', 'file'], operation: ['getAll'] } },
        default: false,
        description: 'Whether to return all results or only up to a given limit',
      },
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 100 },
        displayOptions: { show: { resource: ['render', 'template', 'file'], operation: ['getAll'], returnAll: [false] } },
        default: 25,
        description: 'Max number of results to return',
      },
    ],
  };

  methods = {
    loadOptions: {
      async getTemplates(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const page = (await request(this, 'GET', '/templates?limit=100')) as {
          data?: Array<{ slug: string; name: string; kind: string }>;
        };
        return (page.data ?? []).map((template) => ({
          name: `${template.name} (${template.kind})`,
          value: template.slug,
        }));
      },

      async getTemplateFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const template = this.getNodeParameter('template', '') as string;
        if (!template) return [];
        try {
          const schema = await request(this, 'GET', `/templates/${encodeURIComponent(template)}/schema`);
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
          const source = this.getNodeParameter('source', i) as 'template' | 'html' | 'url';
          const options = this.getNodeParameter('options', i, {}) as IDataObject;
          const mapped = this.getNodeParameter('fields.field', i, []) as Array<{ path: string; value: string }>;
          const json = parseJson(this, i, this.getNodeParameter('dataJson', i, '{}'));
          const settings = parseJson(this, i, (options['settingsJson'] as string) ?? '{}');

          const body = renderBody({
            source,
            template: source === 'template' ? (this.getNodeParameter('template', i) as string) : undefined,
            html: source === 'html' ? (this.getNodeParameter('html', i) as string) : undefined,
            engine: source === 'html' ? (this.getNodeParameter('engine', i) as 'jinja2') : undefined,
            url: source === 'url' ? (this.getNodeParameter('url', i) as string) : undefined,
            data: mergeData(nestData(Object.fromEntries(mapped.map((f) => [f.path, f.value]))), json),
            output: (this.getNodeParameter('output', i, '') as 'pdf' | '') || undefined,
            filename: options['filename'] as string,
            locale: options['locale'] as string,
            mode: options['mode'] as 'sync' | 'async',
            webhookUrl: options['webhookUrl'] as string,
            settings,
          });

          const render = (await request(this, 'POST', '/renders', body)) as IDataObject & {
            download_url?: string;
            output?: string;
          };
          const item: INodeExecutionData = { json: render, pairedItem: { item: i } };

          if (this.getNodeParameter('download', i, true) && render.download_url) {
            const file = (await this.helpers.httpRequest({
              method: 'GET',
              url: render.download_url,
              encoding: 'arraybuffer',
              returnFullResponse: false,
            })) as ArrayBuffer;
            const name = (options['filename'] as string) || `${render['id'] as string}.${render.output ?? 'pdf'}`;
            item.binary = {
              data: await this.helpers.prepareBinaryData(Buffer.from(file), name),
            };
          }
          out.push(item);
          continue;
        }

        if (resource === 'render' && operation === 'get') {
          const id = this.getNodeParameter('renderId', i) as string;
          out.push({ json: (await request(this, 'GET', `/renders/${encodeURIComponent(id)}`)) as IDataObject, pairedItem: { item: i } });
          continue;
        }

        if (resource === 'render' && operation === 'deleteOutputs') {
          const id = this.getNodeParameter('renderId', i) as string;
          await request(this, 'DELETE', `/renders/${encodeURIComponent(id)}/outputs`);
          out.push({ json: { id, deleted: true }, pairedItem: { item: i } });
          continue;
        }

        if (resource === 'file' && operation === 'upload') {
          const property = this.getNodeParameter('binaryPropertyName', i) as string;
          const binary = this.helpers.assertBinaryData(i, property);
          const name = libraryName(this.getNodeParameter('fileName', i, '') as string, binary.fileName);
          if (!name)
            throw new NodeOperationError(
              this.getNode(),
              'The name is not a library file name: letters, digits, dot, dash, underscore and / for folders',
              { itemIndex: i },
            );
          const bytes = await this.helpers.getBinaryDataBuffer(i, property);
          const form = new FormData();
          form.append('file', new Blob([new Uint8Array(bytes)], { type: binary.mimeType }), name.split('/').pop());
          form.append('name', name);
          out.push({ json: (await request(this, 'POST', '/files', form)) as IDataObject, pairedItem: { item: i } });
          continue;
        }

        if (resource === 'file' && operation === 'delete') {
          const id = this.getNodeParameter('fileId', i) as string;
          await request(this, 'DELETE', `/files/${encodeURIComponent(id)}`);
          out.push({ json: { id, deleted: true }, pairedItem: { item: i } });
          continue;
        }

        if ((resource === 'render' || resource === 'template' || resource === 'file') && operation === 'getAll') {
          const prefix = resource === 'file' ? (this.getNodeParameter('prefix', i, '') as string) : '';
          const path = resource === 'render' ? '/renders' : resource === 'template' ? '/templates' : '/files';
          const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
          const limit = returnAll ? 100 : (this.getNodeParameter('limit', i, 25) as number);
          let cursor: string | null = null;
          do {
            const query = `?limit=${limit}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
            const page = (await request(this, 'GET', `${path}${query}`)) as {
              data?: IDataObject[];
              next_cursor?: string | null;
            };
            for (const row of page.data ?? []) out.push({ json: row, pairedItem: { item: i } });
            cursor = returnAll ? (page.next_cursor ?? null) : null;
          } while (cursor);
          continue;
        }

        if (resource === 'template' && operation === 'get') {
          const id = this.getNodeParameter('templateId', i) as string;
          out.push({ json: (await request(this, 'GET', `/templates/${encodeURIComponent(id)}`)) as IDataObject, pairedItem: { item: i } });
          continue;
        }

        if (resource === 'template' && operation === 'getSchema') {
          const id = this.getNodeParameter('templateId', i) as string;
          const schema = await request(this, 'GET', `/templates/${encodeURIComponent(id)}/schema`);
          out.push({ json: { schema, fields: schemaFields(schema) } as IDataObject, pairedItem: { item: i } });
          continue;
        }

        if (resource === 'job' && operation === 'get') {
          const id = this.getNodeParameter('jobId', i) as string;
          out.push({ json: (await request(this, 'GET', `/jobs/${encodeURIComponent(id)}`)) as IDataObject, pairedItem: { item: i } });
          continue;
        }

        throw new NodeOperationError(this.getNode(), `Unsupported operation ${resource}.${operation}`, { itemIndex: i });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
          continue;
        }
        throw error;
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
  const credentials = (await context.getCredentials('formfeedApi')) as unknown as FormfeedCredentials;
  // A FormData body is a file upload: the HTTP helper sets the multipart boundary itself.
  const isForm = body instanceof FormData;
  return context.helpers.httpRequestWithAuthentication.call(context, 'formfeedApi', {
    method,
    url: `${baseUrl(credentials)}${path}`,
    json: !isForm,
    ...(body === undefined ? {} : { body: body as IDataObject }),
  });
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
    throw new NodeOperationError(context.getNode(), 'The JSON field is not valid JSON', { itemIndex });
  }
}

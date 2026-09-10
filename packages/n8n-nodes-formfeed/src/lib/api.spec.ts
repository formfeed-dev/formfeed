import { baseUrl, mergeData, nestData, renderBody, schemaFields } from './api';

describe('baseUrl', () => {
  it('maps the region to a host', () => {
    expect(baseUrl({ apiKey: 'k', region: 'eu' })).toBe('https://api-eu.formfeed.dev/v1');
    expect(baseUrl({ apiKey: 'k', region: 'us' })).toBe('https://api-us.formfeed.dev/v1');
  });

  it('lets a custom base URL win and trims the trailing slash', () => {
    expect(baseUrl({ apiKey: 'k', region: 'eu', baseUrl: 'http://127.0.0.1:8787/v1/' })).toBe(
      'http://127.0.0.1:8787/v1',
    );
  });
});

describe('renderBody', () => {
  it('sends only what the user filled in and tags the source', () => {
    expect(renderBody({ source: 'template', template: 'invoice-de', output: 'pdf' })).toEqual({
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
    const body = renderBody({ source: 'url', url: 'https://example.com', data: {}, settings: {} });
    expect(body).toEqual({ url: 'https://example.com', meta: { source: 'n8n' } });
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
      { path: 'invoice.number', type: 'string', required: true, description: 'Invoice number' },
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
    expect(nestData({ 'invoice.number': '42', 'invoice.total': 10, paid: true })).toEqual({
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
      mergeData({ invoice: { number: '42' } }, { invoice: { lines: [{ qty: 2 }] } }),
    ).toEqual({ invoice: { number: '42', lines: [{ qty: 2 }] } });
  });

  it('lets the override win on a leaf and replaces arrays whole', () => {
    expect(mergeData({ a: 1, list: [1, 2] }, { a: 2, list: [3] })).toEqual({ a: 2, list: [3] });
  });
});

import { toSVG } from 'bwip-js';
import { epcPayload, qrSvg, svgDataUri, type EpcInput, type QrOptions } from '../codes';
import type { HelperDefinition } from '../types';

type BarcodeOptions = {
  type?: string;
  height?: number;
  width?: number;
  text?: boolean;
  scale?: number;
};

/** Aligns spec names with bwip-js symbology ids. */
const barcodeTypes: Record<string, string> = {
  code128: 'code128',
  ean13: 'ean13',
  ean8: 'ean8',
  upc: 'upca',
  upca: 'upca',
  itf14: 'itf14',
  code39: 'code39',
  qrcode: 'qrcode',
  datamatrix: 'datamatrix',
  pdf417: 'pdf417',
};

export const codeHelpers: HelperDefinition[] = [
  {
    name: 'qrcode',
    aliases: ['qr'],
    doc: {
      signature:
        "qrcode(value, { size = 160, ecc = 'M', margin = 1, color, background })",
      description: 'QR code as an SVG data URI for an <img> src.',
      examples: {
        jinja2: '<img src="{{ qrcode(order.url, { size: 120 }) }}">',
        liquid: '<img src="{{ order.url | qrcode: size: 120 }}">',
        handlebars: '<img src="{{qrcode order.url size=120}}">',
      },
      category: 'code',
    },
    fn: (ctx, value, options?) => {
      const o = (options ?? {}) as QrOptions;
      const svg = qrSvg(String(value ?? ''), o);
      // office templates get a picture of the code's size, not a data URI as text (spec 22 §4.4)
      // the SVG carries the default size; only a size the template asks for is fixed (slides fit the rest)
      if (ctx.drawing) return ctx.drawing({ kind: 'svg', svg, width: o.size, height: o.size, alt: 'QR code' });
      return svgDataUri(svg);
    },
  },
  {
    name: 'barcode',
    doc: {
      signature:
        "barcode(value, { type = 'code128', height = 12, width, text = true, scale = 2 })",
      description:
        'Barcode (code128, ean13, ean8, upc, itf14, code39, datamatrix, pdf417) as an SVG data URI.',
      examples: {
        jinja2: `<img src="{{ barcode(item.sku, { type: 'code128' }) }}">`,
        liquid: `<img src="{{ item.sku | barcode: type: 'code128' }}">`,
        handlebars: `<img src="{{barcode item.sku type='code128'}}">`,
      },
      category: 'code',
    },
    fn: (ctx, value, options?) => {
      const o = (options ?? {}) as BarcodeOptions;
      const bcid =
        barcodeTypes[String(o.type ?? 'code128').toLowerCase()] ?? 'code128';
      const svg = toSVG({
        bcid,
        text: String(value ?? ''),
        height: o.height ?? 12,
        ...(o.width === undefined ? {} : { width: o.width }),
        scale: o.scale ?? 2,
        includetext: o.text !== false,
        textxalign: 'center',
      });
      if (ctx.drawing) return ctx.drawing({ kind: 'svg', svg, alt: `Barcode ${String(value ?? '')}` });
      return svgDataUri(svg);
    },
  },
  {
    name: 'epcQr',
    aliases: ['epc_qr', 'girocode'],
    doc: {
      signature:
        'epcQr({ name, iban, bic?, amount?, reference?, text? }, { size })',
      description:
        'SEPA credit transfer QR code (EPC069-12 / GiroCode) that banking apps scan to prefill a payment.',
      examples: {
        jinja2: '<img src="{{ epcQr({ name: company.name, iban: company.iban, amount: invoice.total, reference: invoice.number }) }}">',
        liquid: '<img src="{{ company.iban | epcQr: name: company.name, amount: invoice.total, reference: invoice.number }}">',
        handlebars: '<img src="{{epcQr name=company.name iban=company.iban amount=invoice.total reference=invoice.number}}">',
      },
      category: 'code',
    },
    // Payment fields and QR options may arrive together: Jinja2 passes two objects, Handlebars one
    // hash (`{{epcQr name=… iban=… size=200}}`), and Liquid, which cannot build an object literal,
    // keyword arguments (`{{ company.iban | epcQr: name: company.name, amount: invoice.total }}`,
    // where a string input is the IBAN). They are merged and split by field name.
    fn: (ctx, input, options?) => {
      const fields: Record<string, unknown> = {
        ...(input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : typeof input === 'string' && input
            ? { iban: input }
            : {}),
        ...((options ?? {}) as Record<string, unknown>),
      };
      const payment: Record<string, unknown> = {};
      const qr: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields))
        (EPC_FIELDS.has(key) ? payment : qr)[key] = value;
      const o = { ecc: 'M', ...(qr as QrOptions) } as QrOptions;
      const svg = qrSvg(epcPayload(payment as EpcInput), o);
      if (ctx.drawing) return ctx.drawing({ kind: 'svg', svg, width: o.size, height: o.size, alt: 'GiroCode' });
      return svgDataUri(svg);
    },
  },
];

const EPC_FIELDS = new Set(['name', 'iban', 'bic', 'amount', 'reference', 'text', 'purpose']);

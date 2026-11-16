/**
 * What the engine needs of a browser and a bare V8 isolate lacks (plan 27 §5.1): base64, UTF-8, the
 * timers, the console, a clock and a structured copy. They are written here in plain JavaScript and
 * become part of the isolate's snapshot. None of them may ever be a function of the host: a host
 * function hands a template the host's `Function`, which is what the sandbox exists to keep out.
 *
 * Each is installed only where the global is missing, so the same bundle runs unchanged in the
 * editor's frame, which has the browser's own.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

if (typeof g.btoa !== 'function')
  g.btoa = (input: unknown): string => {
    const text = String(input);
    let out = '';
    for (let i = 0; i < text.length; i += 3) {
      const a = text.charCodeAt(i);
      const b = text.charCodeAt(i + 1);
      const c = text.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255)
        throw new Error('btoa: the string holds a character outside Latin-1');
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out +=
        BASE64[(n >> 18) & 63]! +
        BASE64[(n >> 12) & 63]! +
        (i + 1 < text.length ? BASE64[(n >> 6) & 63]! : '=') +
        (i + 2 < text.length ? BASE64[n & 63]! : '=');
    }
    return out;
  };

if (typeof g.atob !== 'function')
  g.atob = (input: unknown): string => {
    const text = String(input).replace(/[\t\n\f\r ]/g, '');
    if (text.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(text))
      throw new Error('atob: the string is not valid base64');
    let out = '';
    let buffer = 0;
    let bits = 0;
    for (const char of text.replace(/=+$/, '')) {
      buffer = (buffer << 6) | BASE64.indexOf(char);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buffer >> bits) & 255);
      }
    }
    return out;
  };

if (typeof g.TextEncoder !== 'function') {
  class TextEncoder {
    readonly encoding = 'utf-8';
    encode(input = ''): Uint8Array {
      const text = String(input);
      const out: number[] = [];
      for (let i = 0; i < text.length; i++) {
        let code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
          const next = text.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
            i++;
          } else code = 0xfffd;
        } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
        if (code < 0x80) out.push(code);
        else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
        else if (code < 0x10000)
          out.push(
            0xe0 | (code >> 12),
            0x80 | ((code >> 6) & 63),
            0x80 | (code & 63),
          );
        else
          out.push(
            0xf0 | (code >> 18),
            0x80 | ((code >> 12) & 63),
            0x80 | ((code >> 6) & 63),
            0x80 | (code & 63),
          );
      }
      return new Uint8Array(out);
    }
  }
  g.TextEncoder = TextEncoder;
}

if (typeof g.TextDecoder !== 'function') {
  class TextDecoder {
    readonly encoding: string;
    constructor(label = 'utf-8') {
      const name = String(label).toLowerCase();
      if (name !== 'utf-8' && name !== 'utf8')
        throw new RangeError(
          `TextDecoder: only UTF-8 is available, not ${label}`,
        );
      this.encoding = 'utf-8';
    }
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      const bytes =
        input instanceof Uint8Array
          ? input
          : ArrayBuffer.isView(input)
            ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
            : new Uint8Array(input);
      let out = '';
      let chunk: number[] = [];
      const flush = () => {
        out += String.fromCharCode(...chunk);
        chunk = [];
      };
      let i =
        bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
      while (i < bytes.length) {
        const a = bytes[i]!;
        let code = 0xfffd;
        let size = 1;
        if (a < 0x80) code = a;
        else if (a >= 0xc2 && a < 0xe0 && i + 1 < bytes.length) {
          const b = bytes[i + 1]!;
          if ((b & 0xc0) === 0x80) {
            code = ((a & 31) << 6) | (b & 63);
            size = 2;
          }
        } else if (a >= 0xe0 && a < 0xf0 && i + 2 < bytes.length) {
          const b = bytes[i + 1]!;
          const c = bytes[i + 2]!;
          const value = ((a & 15) << 12) | ((b & 63) << 6) | (c & 63);
          if (
            (b & 0xc0) === 0x80 &&
            (c & 0xc0) === 0x80 &&
            value >= 0x800 &&
            (value < 0xd800 || value > 0xdfff)
          ) {
            code = value;
            size = 3;
          }
        } else if (a >= 0xf0 && a < 0xf5 && i + 3 < bytes.length) {
          const b = bytes[i + 1]!;
          const c = bytes[i + 2]!;
          const d = bytes[i + 3]!;
          const value =
            ((a & 7) << 18) | ((b & 63) << 12) | ((c & 63) << 6) | (d & 63);
          if (
            (b & 0xc0) === 0x80 &&
            (c & 0xc0) === 0x80 &&
            (d & 0xc0) === 0x80 &&
            value >= 0x10000 &&
            value <= 0x10ffff
          ) {
            code = value;
            size = 4;
          }
        }
        if (code >= 0x10000) {
          code -= 0x10000;
          chunk.push(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
        } else chunk.push(code);
        if (chunk.length >= 8192) flush();
        i += size;
      }
      flush();
      return out;
    }
  }
  g.TextDecoder = TextDecoder;
}

/**
 * Timers on the microtask queue: inside the isolate nothing waits for time, and the engines use a
 * timer only to defer a callback (Nunjucks' `asap`), never to wait.
 */
if (typeof g.setTimeout !== 'function') {
  let next = 1;
  const pending = new Set<number>();
  g.setTimeout = (callback: unknown, _ms?: number, ...args: unknown[]) => {
    const id = next++;
    pending.add(id);
    Promise.resolve().then(() => {
      if (!pending.delete(id)) return;
      if (typeof callback === 'function') callback(...args);
    });
    return id;
  };
  g.clearTimeout = (id: number) => {
    pending.delete(id);
  };
  g.setImmediate = (callback: unknown, ...args: unknown[]) =>
    g.setTimeout(callback, 0, ...args);
  g.clearImmediate = g.clearTimeout;
  // Nunjucks' `asap` sets an interval beside its timeout as a fallback and clears both when either
  // fires. The timeout always fires here, so an interval is registered and never fires: on the
  // microtask queue it would fire on every turn and never let a render end.
  g.setInterval = () => next++;
  g.clearInterval = () => undefined;
}

if (typeof g.queueMicrotask !== 'function')
  g.queueMicrotask = (callback: () => void) => {
    Promise.resolve().then(callback);
  };

if (typeof g.console !== 'object' || !g.console) {
  const quiet = () => undefined;
  g.console = {
    log: quiet,
    info: quiet,
    warn: quiet,
    error: quiet,
    debug: quiet,
    trace: quiet,
  };
}

if (typeof g.performance !== 'object' || !g.performance) {
  const origin = Date.now();
  g.performance = { now: () => Date.now() - origin, timeOrigin: origin };
}

if (typeof g.structuredClone !== 'function')
  g.structuredClone = (value: unknown) => copy(value, new Map());

function copy(value: unknown, seen: Map<unknown, unknown>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol')
      throw new Error('structuredClone: the value cannot be copied');
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as Uint8Array;
    return new (view.constructor as Uint8ArrayConstructor)(view);
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value) out.set(copy(k, seen), copy(v, seen));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const v of value) out.add(copy(v, seen));
    return out;
  }
  const out: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? []
    : {};
  seen.set(value, out);
  for (const key of Object.keys(value))
    (out as Record<string, unknown>)[key] = copy(
      (value as Record<string, unknown>)[key],
      seen,
    );
  return out;
}

if (typeof g.self === 'undefined') g.self = g;

export {};

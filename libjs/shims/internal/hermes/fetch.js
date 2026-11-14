'use strict';

// fetch(), Headers, Request and Response for hermes-node.
//
// Node implements these with undici on top of WHATWG streams, Blob and
// structuredClone, which hermes-node does not have yet. This is a smaller
// implementation on top of the http/https/zlib modules that covers the common
// surface: request bodies (string, Buffer/TypedArray/ArrayBuffer/DataView,
// URLSearchParams, Node readable streams), headers, redirects, gzip/deflate/br
// decoding, AbortSignal, and response bodies via text()/json()/arrayBuffer()/
// bytes().
//
// Differences from Node:
// - Response.body (and Request.body) is a Node Readable, not a WHATWG
//   ReadableStream. It is async-iterable either way.
// - blob() and formData() are not supported (no Blob/FormData yet).
// - No HTTP/2, no data:/file: URLs, no CORS/mode/credentials semantics.

const { Readable } = require('stream');

const kHeaders = Symbol('headers');
const kGuard = Symbol('guard');
const kBody = Symbol('body');
const kBodyUsed = Symbol('bodyUsed');
const kStream = Symbol('stream');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const MAX_REDIRECTS = 20;

function normalizeName(name) {
  name = String(name);
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new TypeError(`Invalid header name: "${name}"`);
  }
  return name.toLowerCase();
}

function normalizeValue(value) {
  return String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
}

class Headers {
  constructor(init = undefined) {
    // Map of lowercased name -> array of values (kept separate for set-cookie).
    this[kHeaders] = new Map();
    this[kGuard] = 'none';
    if (init == null) {
      return;
    }
    if (init instanceof Headers) {
      for (const [name, values] of init[kHeaders]) {
        this[kHeaders].set(name, values.slice());
      }
    } else if (typeof init[Symbol.iterator] === 'function') {
      for (const pair of init) {
        const entry = Array.from(pair);
        if (entry.length !== 2) {
          throw new TypeError('Header pairs must contain exactly two items');
        }
        this.append(entry[0], entry[1]);
      }
    } else if (typeof init === 'object') {
      for (const name of Object.keys(init)) {
        this.append(name, init[name]);
      }
    } else {
      throw new TypeError('Headers init must be an object or an iterable');
    }
  }

  append(name, value) {
    const key = normalizeName(name);
    const list = this[kHeaders].get(key);
    if (list) {
      list.push(normalizeValue(value));
    } else {
      this[kHeaders].set(key, [normalizeValue(value)]);
    }
  }

  set(name, value) {
    this[kHeaders].set(normalizeName(name), [normalizeValue(value)]);
  }

  get(name) {
    const list = this[kHeaders].get(normalizeName(name));
    if (!list) {
      return null;
    }
    return list.join(', ');
  }

  getSetCookie() {
    return (this[kHeaders].get('set-cookie') || []).slice();
  }

  has(name) {
    return this[kHeaders].has(normalizeName(name));
  }

  delete(name) {
    this[kHeaders].delete(normalizeName(name));
  }

  forEach(callback, thisArg = undefined) {
    for (const [name, value] of this) {
      callback.call(thisArg, value, name, this);
    }
  }

  *entries() {
    const names = Array.from(this[kHeaders].keys()).sort();
    for (const name of names) {
      if (name === 'set-cookie') {
        for (const value of this[kHeaders].get(name)) {
          yield [name, value];
        }
      } else {
        yield [name, this.get(name)];
      }
    }
  }

  *keys() {
    for (const [name] of this.entries()) {
      yield name;
    }
  }

  *values() {
    for (const [, value] of this.entries()) {
      yield value;
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  get [Symbol.toStringTag]() {
    return 'Headers';
  }
}

function isAbortSignal(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function'
  );
}

/// Turns a BodyInit into { body: Buffer | Readable | null, contentType }.
function extractBody(init) {
  if (init == null) {
    return { body: null, contentType: null };
  }
  if (typeof init === 'string') {
    return { body: Buffer.from(init, 'utf8'), contentType: 'text/plain;charset=UTF-8' };
  }
  if (init instanceof URLSearchParams) {
    return {
      body: Buffer.from(init.toString(), 'utf8'),
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  if (Buffer.isBuffer(init)) {
    return { body: init, contentType: null };
  }
  if (ArrayBuffer.isView(init)) {
    return {
      body: Buffer.from(init.buffer, init.byteOffset, init.byteLength),
      contentType: null,
    };
  }
  if (init instanceof ArrayBuffer) {
    return { body: Buffer.from(init), contentType: null };
  }
  if (init instanceof Readable || typeof init[Symbol.asyncIterator] === 'function') {
    return { body: init instanceof Readable ? init : Readable.from(init), contentType: null };
  }
  return { body: Buffer.from(String(init), 'utf8'), contentType: 'text/plain;charset=UTF-8' };
}

async function consume(source, stream) {
  if (source[kBodyUsed]) {
    throw new TypeError('Body is unusable: Body has already been read');
  }
  source[kBodyUsed] = true;
  const body = source[kBody];
  if (body == null) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  const chunks = [];
  for await (const chunk of stream || body) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

class Body {
  get bodyUsed() {
    return this[kBodyUsed];
  }

  get body() {
    const body = this[kBody];
    if (body == null) {
      return null;
    }
    if (!this[kStream]) {
      this[kStream] = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    }
    return this[kStream];
  }

  async arrayBuffer() {
    const buf = await consume(this, this[kStream]);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  async bytes() {
    const buf = await consume(this, this[kStream]);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async text() {
    return (await consume(this, this[kStream])).toString('utf8');
  }

  async json() {
    return JSON.parse(await this.text());
  }

  async blob() {
    throw new TypeError('Body.blob() is not supported in hermes-node');
  }

  async formData() {
    throw new TypeError('Body.formData() is not supported in hermes-node');
  }
}

class Request extends Body {
  constructor(input, init = {}) {
    super();
    const base = input instanceof Request ? input : null;
    const url = base ? base.url : String(input instanceof URL ? input.href : input);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError(`Failed to parse URL from ${url}`);
    }
    if (parsed.username || parsed.password) {
      throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`);
    }
    this.url = parsed.href;
    this.method = String(init.method || (base && base.method) || 'GET').toUpperCase();
    this.headers = new Headers(init.headers || (base && base.headers) || undefined);
    this.redirect = init.redirect || (base && base.redirect) || 'follow';
    this.signal = init.signal !== undefined ? init.signal : base ? base.signal : null;
    if (this.signal != null && !isAbortSignal(this.signal)) {
      throw new TypeError('Failed to construct Request: member signal is not of type AbortSignal');
    }
    this[kBodyUsed] = false;

    let bodyInit = init.body !== undefined ? init.body : base ? base[kBody] : null;
    if (bodyInit != null && (this.method === 'GET' || this.method === 'HEAD')) {
      throw new TypeError('Request with GET/HEAD method cannot have body.');
    }
    const { body, contentType } = extractBody(bodyInit);
    this[kBody] = body;
    if (contentType && !this.headers.has('content-type')) {
      this.headers.set('content-type', contentType);
    }
  }

  clone() {
    if (this[kBodyUsed]) {
      throw new TypeError('Request.clone: Body has already been consumed.');
    }
    if (this[kBody] != null && !Buffer.isBuffer(this[kBody])) {
      throw new TypeError('Request.clone() is not supported for streaming bodies in hermes-node');
    }
    return new Request(this);
  }

  get [Symbol.toStringTag]() {
    return 'Request';
  }
}

class Response extends Body {
  constructor(body = null, init = {}) {
    super();
    const status = init.status === undefined ? 200 : Number(init.status);
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw new RangeError(`init["status"] must be in the range of 200 to 599, inclusive.`);
    }
    this.status = status;
    this.statusText = init.statusText === undefined ? '' : String(init.statusText);
    this.headers = new Headers(init.headers);
    this.type = 'default';
    this.url = '';
    this.redirected = false;
    this[kBodyUsed] = false;
    const extracted = extractBody(body);
    this[kBody] = extracted.body;
    if (extracted.contentType && !this.headers.has('content-type')) {
      this.headers.set('content-type', extracted.contentType);
    }
  }

  get ok() {
    return this.status >= 200 && this.status <= 299;
  }

  clone() {
    if (this[kBodyUsed]) {
      throw new TypeError('Response.clone: Body has already been consumed.');
    }
    if (this[kBody] != null && !Buffer.isBuffer(this[kBody])) {
      throw new TypeError('Response.clone() is not supported for streaming bodies in hermes-node');
    }
    const copy = new Response(this[kBody], {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
    });
    copy.type = this.type;
    copy.url = this.url;
    copy.redirected = this.redirected;
    return copy;
  }

  static json(data, init = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return new Response(JSON.stringify(data), { ...init, headers });
  }

  static error() {
    const response = new Response(null, { status: 200 });
    response.status = 0;
    response.type = 'error';
    return response;
  }

  static redirect(url, status = 302) {
    if (!REDIRECT_STATUSES.has(status)) {
      throw new RangeError(`Invalid status code ${status}`);
    }
    const response = new Response(null, { status, headers: { location: new URL(url).href } });
    return response;
  }

  get [Symbol.toStringTag]() {
    return 'Response';
  }
}

function abortReason(signal) {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

function fetchError(message, cause) {
  const err = new TypeError(message);
  if (cause !== undefined) {
    err.cause = cause;
  }
  return err;
}

function decode(res, encoding) {
  const zlib = require('zlib');
  const codings = String(encoding || '')
    .toLowerCase()
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c && c !== 'identity')
    .reverse();
  let stream = res;
  for (const coding of codings) {
    if (coding === 'gzip' || coding === 'x-gzip') {
      stream = stream.pipe(
        zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH })
      );
    } else if (coding === 'deflate') {
      stream = stream.pipe(zlib.createInflate());
    } else if (coding === 'br') {
      stream = stream.pipe(zlib.createBrotliDecompress());
    } else {
      // Unknown coding: hand back the raw bytes, like Node does.
      return res;
    }
  }
  return stream;
}

function fetch(input, init = undefined) {
  let request;
  try {
    request = new Request(input, init || {});
  } catch (err) {
    return Promise.reject(err);
  }
  const signal = request.signal;
  if (signal && signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise((resolve, reject) => {
    let currentReq = null;
    let settled = false;
    let responseStream = null;

    const onAbort = () => {
      const reason = abortReason(signal);
      if (currentReq) {
        currentReq.destroy(reason);
      }
      if (responseStream) {
        responseStream.destroy(reason);
      }
      if (!settled) {
        settled = true;
        reject(reason);
      }
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    // Request bodies that are streams can only be sent once, so they can't
    // follow a redirect that preserves the body (307/308).
    let body = request[kBody];
    request[kBodyUsed] = body != null;

    const send = (url, method, headers, redirects) => {
      const parsed = new URL(url);
      let transport;
      if (parsed.protocol === 'https:') {
        transport = require('https');
      } else if (parsed.protocol === 'http:') {
        transport = require('http');
      } else {
        settled = true;
        cleanup();
        reject(fetchError(`fetch failed`, new Error(`unsupported protocol ${parsed.protocol}`)));
        return;
      }

      const outgoing = {};
      for (const [name, value] of headers) {
        if (name === 'set-cookie') {
          continue;
        }
        outgoing[name] = value;
      }
      if (!('accept' in outgoing)) {
        outgoing['accept'] = '*/*';
      }
      if (!('accept-language' in outgoing)) {
        outgoing['accept-language'] = '*';
      }
      if (!('accept-encoding' in outgoing)) {
        outgoing['accept-encoding'] = 'gzip, deflate, br';
      }
      if (!('user-agent' in outgoing)) {
        outgoing['user-agent'] = 'node';
      }
      if (Buffer.isBuffer(body)) {
        outgoing['content-length'] = String(body.length);
      } else if (body == null && (method === 'POST' || method === 'PUT')) {
        outgoing['content-length'] = '0';
      }

      const req = transport.request(parsed, { method, headers: outgoing });
      currentReq = req;

      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(fetchError('fetch failed', err));
        }
      });

      req.on('response', (res) => {
        const status = res.statusCode;
        const location = res.headers.location;
        if (REDIRECT_STATUSES.has(status) && location && request.redirect !== 'manual') {
          res.resume();
          if (request.redirect === 'error') {
            settled = true;
            cleanup();
            reject(fetchError('fetch failed', new Error('unexpected redirect')));
            return;
          }
          if (redirects >= MAX_REDIRECTS) {
            settled = true;
            cleanup();
            reject(fetchError('fetch failed', new Error('redirect count exceeded')));
            return;
          }
          let next;
          try {
            next = new URL(location, url).href;
          } catch (err) {
            settled = true;
            cleanup();
            reject(fetchError('fetch failed', err));
            return;
          }
          let nextMethod = method;
          const nextHeaders = new Headers(headers);
          if (status === 303 ? method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST') {
            nextMethod = 'GET';
            body = null;
            for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) {
              nextHeaders.delete(name);
            }
          } else if (body != null && !Buffer.isBuffer(body)) {
            settled = true;
            cleanup();
            reject(fetchError('fetch failed', new Error('cannot follow redirect with a streaming body')));
            return;
          }
          if (new URL(next).origin !== parsed.origin) {
            nextHeaders.delete('authorization');
            nextHeaders.delete('cookie');
          }
          send(next, nextMethod, nextHeaders, redirects + 1);
          return;
        }

        const responseHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          try {
            responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          } catch {
            // Ignore headers Headers can't represent.
          }
        }
        const nullBody = method === 'HEAD' || NULL_BODY_STATUSES.has(status);
        if (nullBody) {
          res.resume();
        }
        responseStream = nullBody ? null : decode(res, res.headers['content-encoding']);
        if (responseStream && responseStream !== res) {
          res.on('error', (err) => responseStream.destroy(err));
        }
        if (responseStream) {
          responseStream.on('end', cleanup);
          responseStream.on('close', cleanup);
        } else {
          cleanup();
        }

        const response = Object.create(Response.prototype);
        response.status = status;
        response.statusText = res.statusMessage || '';
        response.headers = responseHeaders;
        response.type = 'basic';
        response.url = url;
        response.redirected = redirects > 0;
        response[kBodyUsed] = false;
        response[kBody] = responseStream;
        settled = true;
        resolve(response);
      });

      if (body == null) {
        req.end();
      } else if (Buffer.isBuffer(body)) {
        req.end(body);
      } else {
        body.on('error', (err) => req.destroy(err));
        body.pipe(req);
      }
    };

    send(request.url, request.method, request.headers, 0);
  });
}

module.exports = { fetch, Headers, Request, Response };

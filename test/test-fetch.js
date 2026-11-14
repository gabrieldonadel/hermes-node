// RUN: %hermes-node %s | %FileCheck %s
// Global fetch/Headers/Request/Response against a local server. The same
// script passes on Node.

'use strict';
const http = require('http');
const zlib = require('zlib');

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, 'http://x');
    switch (url.pathname) {
      case '/json':
        res.setHeader('content-type', 'application/json');
        res.setHeader('X-Custom', 'a');
        res.end(JSON.stringify({ hello: 'world' }));
        break;
      case '/echo':
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          method: req.method,
          body,
          type: req.headers['content-type'] || null,
          auth: req.headers['authorization'] || null,
        }));
        break;
      case '/redirect':
        res.statusCode = 302;
        res.setHeader('location', '/json');
        res.end();
        break;
      case '/see-other':
        res.statusCode = 303;
        res.setHeader('location', '/echo');
        res.end();
        break;
      case '/gzip':
        res.setHeader('content-encoding', 'gzip');
        res.end(zlib.gzipSync('compressed body'));
        break;
      case '/missing':
        res.statusCode = 404;
        res.statusMessage = 'Not Found';
        res.end('nope');
        break;
      case '/slow':
        setTimeout(() => res.end('late'), 2000);
        break;
      case '/no-content':
        res.statusCode = 204;
        res.end();
        break;
      default:
        res.end();
    }
  });
});

async function main(base) {
  let res = await fetch(`${base}/json`);
  console.log('json', res.status, res.ok, res.headers.get('x-custom'),
              res.headers.get('Content-Type'), JSON.stringify(await res.json()));
  // CHECK: json 200 true a application/json {"hello":"world"}
  try {
    await res.text();
  } catch (e) {
    console.log('reuse', e.name, res.bodyUsed);
  }
  // CHECK-NEXT: reuse TypeError true

  res = await fetch(new Request(`${base}/echo`, {
    method: 'post',
    headers: { Authorization: 'Bearer t' },
    body: JSON.stringify({ a: 1 }),
  }));
  console.log('post', JSON.stringify(await res.json()));
  // CHECK-NEXT: post {"method":"POST","body":"{\"a\":1}","type":"text/plain;charset=UTF-8","auth":"Bearer t"}

  res = await fetch(`${base}/echo`, {
    method: 'POST',
    body: new URLSearchParams({ q: 'a b' }),
  });
  const form = await res.json();
  console.log('form', form.body, form.type);
  // CHECK-NEXT: form q=a+b application/x-www-form-urlencoded;charset=UTF-8

  res = await fetch(`${base}/redirect`);
  console.log('redirect', res.status, res.redirected, res.url.endsWith('/json'));
  // CHECK-NEXT: redirect 200 true true
  await res.arrayBuffer();

  res = await fetch(`${base}/see-other`, { method: 'POST', body: 'x' });
  console.log('303', (await res.json()).method);
  // CHECK-NEXT: 303 GET

  res = await fetch(`${base}/redirect`, { redirect: 'manual' });
  console.log('manual', res.status, res.headers.get('location'));
  // CHECK-NEXT: manual 302 /json
  await res.text();

  res = await fetch(`${base}/gzip`);
  console.log('gzip', await res.text());
  // CHECK-NEXT: gzip compressed body

  res = await fetch(`${base}/missing`);
  console.log('404', res.status, res.ok, res.statusText, await res.text());
  // CHECK-NEXT: 404 404 false Not Found nope

  res = await fetch(`${base}/no-content`);
  console.log('204', res.status, res.body, await res.text() === '');
  // CHECK-NEXT: 204 204 null true

  res = await fetch(`${base}/json`);
  let streamed = '';
  for await (const chunk of res.body) {
    streamed += Buffer.from(chunk).toString();
  }
  console.log('stream', streamed);
  // CHECK-NEXT: stream {"hello":"world"}

  try {
    await fetch(`${base}/slow`, { signal: AbortSignal.timeout(50) });
  } catch (e) {
    console.log('timeout', e.name);
  }
  // CHECK-NEXT: timeout TimeoutError

  const ac = new AbortController();
  const pending = fetch(`${base}/slow`, { signal: ac.signal });
  ac.abort();
  try {
    await pending;
  } catch (e) {
    console.log('abort', e.name);
  }
  // CHECK-NEXT: abort AbortError

  try {
    await fetch('http://127.0.0.1:1/');
  } catch (e) {
    console.log('refused', e.name, e.message, typeof e.cause);
  }
  // CHECK-NEXT: refused TypeError fetch failed object

  const h = new Headers([['A', '1'], ['b', '2']]);
  h.append('a', '3');
  h.append('Set-Cookie', 'x=1');
  h.append('Set-Cookie', 'y=2');
  console.log('headers', [...h].map(([k, v]) => `${k}:${v}`).join('|'), h.getSetCookie().length);
  // CHECK-NEXT: headers a:1, 3|b:2|set-cookie:x=1|set-cookie:y=2 2

  const r = Response.json({ ok: 1 }, { status: 201 });
  console.log('Response.json', r.status, r.headers.get('content-type'),
              await r.clone().text());
  // CHECK-NEXT: Response.json 201 application/json {"ok":1}

  console.log('PASS');
  // CHECK-NEXT: PASS
}

server.listen(0, '127.0.0.1', () => {
  main(`http://127.0.0.1:${server.address().port}`)
    .catch((e) => console.log('FAIL', e && e.stack))
    .finally(() => server.close());
});

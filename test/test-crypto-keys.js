// RUN: %hermes-node %s | %FileCheck %s
// HKDF, Ed25519/X25519 keys, one-shot sign/verify, diffieHellman, ciphers and
// randomUUID. The expected values are the output of Node 24 for the same calls.

'use strict';
const assert = require('assert');
const crypto = require('crypto');

assert.match(
  crypto.randomUUID(),
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

// hkdfSync returns an ArrayBuffer, as in Node.
const okm = crypto.hkdfSync('sha512', Buffer.from('ikm'), Buffer.alloc(64), 'info', 42);
assert(okm instanceof ArrayBuffer);
assert.strictEqual(
  Buffer.from(okm).toString('hex'),
  '3a602ee52593d4f927d57495b18ea66a5f4cf7dfdb1a7ddaf22459db5d3da2945996e622e2e15e5411f9');
assert.strictEqual(
  Buffer.from(crypto.hkdfSync('sha256', Buffer.from('k'), Buffer.alloc(0), Buffer.alloc(0), 16))
    .toString('hex'),
  'e4993d66ff42f5306afa8c1ebaf61c73');
assert.throws(() => crypto.hkdfSync('nope', 'k', '', '', 16));

// Ed25519 from a PKCS#8 DER seed.
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const edPrivate = crypto.createPrivateKey({
  key: Buffer.concat([ED25519_PKCS8, Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8',
});
const edPublic = crypto.createPublicKey(edPrivate);
assert.strictEqual(edPrivate.type, 'private');
assert.strictEqual(edPublic.type, 'public');
assert.strictEqual(edPrivate.asymmetricKeyType, 'ed25519');
assert.deepStrictEqual(edPublic.export({ format: 'jwk' }), {
  crv: 'Ed25519',
  x: '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw',
  kty: 'OKP',
});
assert.strictEqual(
  edPublic.export({ format: 'der', type: 'spki' }).toString('hex'),
  '302a300506032b6570032100ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c');
const pem = edPrivate.export({ format: 'pem', type: 'pkcs8' });
assert.strictEqual(
  pem,
  '-----BEGIN PRIVATE KEY-----\n' +
    'MC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n' +
    '-----END PRIVATE KEY-----\n');
assert(crypto.createPrivateKey(pem).equals(edPrivate));
assert(crypto.createPublicKey(pem).equals(edPublic));

const signature = crypto.sign(null, Buffer.from('message'), edPrivate);
assert.strictEqual(
  signature.toString('hex'),
  '9e46ad095242486ab68b0b6664ade0909c98e02de019d98810c448d7e58d4319' +
    'c8ae941a474f6ef64ea9dd22106c5c52196e4728f9a3464737bbac84df2fab0a');
const rawPublic = Buffer.from(edPublic.export({ format: 'jwk' }).x, 'base64url');
const spki = crypto.createPublicKey({
  key: Buffer.concat([ED25519_SPKI, rawPublic]),
  format: 'der',
  type: 'spki',
});
assert.strictEqual(crypto.verify(null, Buffer.from('message'), spki, signature), true);
assert.strictEqual(crypto.verify(null, Buffer.from('other'), spki, signature), false);
assert.throws(() => crypto.sign(null, Buffer.from('message'), edPublic));
assert.throws(() => crypto.createPublicKey({ key: Buffer.from('00'), format: 'der', type: 'spki' }));

// X25519 key agreement.
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const x25519 = (byte) => crypto.createPrivateKey({
  key: Buffer.concat([X25519_PKCS8, Buffer.alloc(32, byte)]),
  format: 'der',
  type: 'pkcs8',
});
const a = x25519(1);
const b = x25519(2);
const shared = crypto.diffieHellman({ privateKey: a, publicKey: crypto.createPublicKey(b) });
assert.strictEqual(
  shared.toString('hex'),
  '2ed76ab549b1e73c031eb49c9448f0798aea81b698279a0c3dc3e49fbfc4b953');
assert(shared.equals(
  crypto.diffieHellman({ privateKey: b, publicKey: crypto.createPublicKey(a) })));

// ChaCha20-Poly1305 (AEAD).
assert(crypto.getCiphers().includes('chacha20-poly1305'));
assert(crypto.getCiphers().includes('aes-256-gcm'));
const key = Buffer.alloc(32, 3);
const nonce = Buffer.alloc(12, 4);
const aad = Buffer.from('aad');
const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
cipher.setAAD(aad, { plaintextLength: 5 });
const sealed = Buffer.concat([cipher.update(Buffer.from('hello')), cipher.final()]);
assert.strictEqual(sealed.toString('hex'), '1ba5b419a0');
assert.strictEqual(cipher.getAuthTag().toString('hex'), '4aa70a3968a8ed2db48a77583ad05486');
const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
decipher.setAAD(aad, { plaintextLength: 5 });
decipher.setAuthTag(cipher.getAuthTag());
assert.strictEqual(Buffer.concat([decipher.update(sealed), decipher.final()]).toString(), 'hello');
const forged = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
forged.setAuthTag(Buffer.alloc(16));
forged.update(sealed);
assert.throws(() => forged.final(), /unable to authenticate data/);

// AES-CBC (block cipher with padding).
const cbc = crypto.createCipheriv('aes-256-cbc', key, Buffer.alloc(16, 5));
const cbcOut = Buffer.concat([
  cbc.update('some plaintext longer than a block', 'utf8'),
  cbc.final(),
]);
assert.strictEqual(
  cbcOut.toString('hex'),
  '0ed1e459a4d78017d6ac451fe9e4d32182689b0fa28e0dbb7c3a94784e4b50a1' +
    'dc827c5d7cb426af697df391feb4d88d');
const cbcBack = crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16, 5));
assert.strictEqual(
  cbcBack.update(cbcOut, undefined, 'utf8') + cbcBack.final('utf8'),
  'some plaintext longer than a block');
assert.throws(
  () => crypto.createCipheriv('aes-256-cbc', Buffer.alloc(5), Buffer.alloc(16)),
  /Invalid key length/);
assert.throws(() => crypto.createCipheriv('nope', key, nonce), /Unknown cipher/);

console.log('PASS');
// CHECK: PASS

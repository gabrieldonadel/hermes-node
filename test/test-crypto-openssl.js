// RUN: %hermes-node %s | %FileCheck %s
// Hash/Hmac are backed by OpenSSL: every digest Node offers, same outputs.

'use strict';
const crypto = require('crypto');

const data = Buffer.from('The quick brown fox jumps over the lazy dog');
for (const algo of ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512',
                    'sha512-256', 'sha3-256', 'RSA-SHA256', 'SHA256',
                    'ripemd160', 'blake2b512']) {
  console.log(algo, crypto.createHash(algo).update(data).digest('hex'));
}
// CHECK: md5 9e107d9d372bb6826bd81d3542a419d6
// CHECK-NEXT: sha1 2fd4e1c67a2d28fced849ee1bb76e7391b93eb12
// CHECK-NEXT: sha224 730e109bd7a8a32b1cb9d9a09aa2325d2430587ddbc0c38bad911525
// CHECK-NEXT: sha256 d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592
// CHECK-NEXT: sha384 ca737f1014a48f4c0b6dd43cb177b0afd9e5169367544c494011e3317dbf9a509cb1e5dc1e85a941bbee3d7f2afbc9b1
// CHECK-NEXT: sha512 07e547d9586f6a73f73fbac0435ed76951218fb7d0c8d788a309d785436bbb642e93a252a954f23912547d1e8a3b5ed6e1bfd7097821233fa0538f3db854fee6
// CHECK-NEXT: sha512-256 dd9d67b371519c339ed8dbd25af90e976a1eeefd4ad3d889005e532fc5bef04d
// CHECK-NEXT: sha3-256 69070dda01975c8c120c3aada1b282394e7f032fa9cf32f4cb2259a0897dfc04
// CHECK-NEXT: RSA-SHA256 d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592
// CHECK-NEXT: SHA256 d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592
// CHECK-NEXT: ripemd160 37f332f68db77bd9d7edd4969571ad671cf9dd3b
// CHECK-NEXT: blake2b512 a8add4bdddfd93e4877d2746e62817b116364a1fa7bc148d95090bc7333b3673f82401cf7aa2e4cb1ecd90296e3f14cb5413f8ed77be73045b13914cdcd6a918

console.log('hmac', crypto.createHmac('sha256', 'key').update(data).digest('hex'));
// CHECK-NEXT: hmac f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8
console.log('hmac empty key', crypto.createHmac('sha1', '').update('').digest('hex'));
// CHECK-NEXT: hmac empty key fbdb1d1b18aa6c08324b7d64b71fb76370690e1d
console.log('hmac long key', crypto.createHmac('sha512', Buffer.alloc(200, 1)).update('x').digest('base64'));
// CHECK-NEXT: hmac long key {{[A-Za-z0-9+/]+=*}}

const h = crypto.createHash('sha256').update('The quick brown fox ');
const c = h.copy();
console.log('copy', h.update('jumps over the lazy dog').digest('hex') ===
            c.update('jumps over the lazy dog').digest('hex'));
// CHECK-NEXT: copy true

console.log('typed', crypto.createHash('md5').update(new Uint16Array([1, 2])).digest('hex') ===
            crypto.createHash('md5').update(Buffer.from([1, 0, 2, 0])).digest('hex'));
// CHECK-NEXT: typed true

for (const bad of [() => crypto.createHash('nope'), () => crypto.createHmac('nope', 'k')]) {
  try {
    bad();
  } catch (e) {
    console.log('unknown', e.name);
  }
}
// CHECK-NEXT: unknown Error
// CHECK-NEXT: unknown TypeError

const hashes = crypto.getHashes();
console.log('getHashes', hashes.includes('sha256'), hashes.includes('sha512'), hashes.includes('sha3-256'));
// CHECK-NEXT: getHashes true true true
console.log('openssl', /^\d+\.\d+\.\d+/.test(process.versions.openssl));
// CHECK-NEXT: openssl true

const { Readable } = require('stream');
Readable.from([Buffer.from('ab'), Buffer.from('c')])
  .pipe(crypto.createHash('sha1'))
  .on('data', (d) => {
    console.log('pipe', d.toString('hex'));
    // CHECK-NEXT: pipe a9993e364706816aba3e25717850c26c9cd0d89d
    console.log('PASS');
    // CHECK-NEXT: PASS
  });

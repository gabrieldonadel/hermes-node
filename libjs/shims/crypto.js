// Copyright (c) Tzvetan Mikov.
// Minimal crypto shim: Hash and Hmac (every OpenSSL digest), randomness,
// timingSafeEqual, HKDF, asymmetric keys (KeyObject, one-shot sign/verify,
// diffieHellman) and ciphers (createCipheriv/createDecipheriv).

'use strict';

var {
  Hash: _Hash,
  Hmac: _Hmac,
  getHashes,
  timingSafeEqual,
  randomFillSync: _randomFillSync,
  hkdf: _hkdf,
  keyParse: _keyParse,
  keyType: _keyType,
  keyExport: _keyExport,
  signOneShot: _signOneShot,
  verifyOneShot: _verifyOneShot,
  diffieHellman: _diffieHellman,
  getCiphers,
  Cipher: _Cipher,
} = internalBinding('crypto');

var { Transform } = require('stream');
var { Buffer } = require('buffer');
var { validateBoolean, validateObject } = require('internal/validators');
var { StringDecoder } = require('string_decoder');

// Hash class (extends Transform for .pipe() compatibility).
function Hash(algorithm, options) {
  if (!(this instanceof Hash))
    return new Hash(algorithm, options);
  Transform.call(this, options);
  this._hash = new _Hash(algorithm);
  this._finalized = false;
}

Object.setPrototypeOf(Hash.prototype, Transform.prototype);
Object.setPrototypeOf(Hash, Transform);

Hash.prototype.update = function update(data, inputEncoding) {
  if (this._finalized)
    throw new Error('Digest already called');
  if (typeof data === 'string')
    data = Buffer.from(data, inputEncoding || 'utf8');
  this._hash.update(data);
  return this;
};

Hash.prototype.digest = function digest(outputEncoding) {
  if (this._finalized)
    throw new Error('Digest already called');
  this._finalized = true;
  var buf = Buffer.from(this._hash.digest());
  if (outputEncoding && outputEncoding !== 'buffer')
    return buf.toString(outputEncoding);
  return buf;
};

Hash.prototype.copy = function copy(options) {
  if (this._finalized)
    throw new Error('Digest already called');
  var h = new Hash('md5', options); // dummy algo, overwritten by native copy
  h._hash = this._hash.copy();
  h._finalized = false;
  return h;
};

Hash.prototype._transform = function _transform(chunk, encoding, callback) {
  this.update(chunk, encoding);
  callback();
};

Hash.prototype._flush = function _flush(callback) {
  this.push(this.digest());
  callback();
};

// Hmac class (extends Transform for .pipe() compatibility).
function Hmac(algorithm, key, options) {
  if (!(this instanceof Hmac))
    return new Hmac(algorithm, key, options);
  Transform.call(this, options);
  if (typeof key === 'string')
    key = Buffer.from(key, 'utf8');
  this._hmac = new _Hmac();
  this._hmac.init(algorithm, key);
  this._finalized = false;
}

Object.setPrototypeOf(Hmac.prototype, Transform.prototype);
Object.setPrototypeOf(Hmac, Transform);

Hmac.prototype.update = function update(data, inputEncoding) {
  if (this._finalized)
    throw new Error('Digest already called');
  if (typeof data === 'string')
    data = Buffer.from(data, inputEncoding || 'utf8');
  this._hmac.update(data);
  return this;
};

Hmac.prototype.digest = function digest(outputEncoding) {
  if (this._finalized)
    throw new Error('Digest already called');
  this._finalized = true;
  var buf = Buffer.from(this._hmac.digest());
  if (outputEncoding && outputEncoding !== 'buffer')
    return buf.toString(outputEncoding);
  return buf;
};

Hmac.prototype._transform = function _transform(chunk, encoding, callback) {
  this.update(chunk, encoding);
  callback();
};

Hmac.prototype._flush = function _flush(callback) {
  this.push(this.digest());
  callback();
};

// One-shot hash function.
function hash(algorithm, data, outputEncoding) {
  if (typeof data === 'string')
    data = Buffer.from(data, 'utf8');
  var h = new Hash(algorithm);
  h.update(data);
  return h.digest(outputEncoding || 'hex');
}

function createHash(algorithm, options) {
  return new Hash(algorithm, options);
}

function createHmac(algorithm, key, options) {
  return new Hmac(algorithm, key, options);
}

function randomFillSync(buf, offset, size) {
  if (typeof buf !== 'object' || buf === null)
    throw new TypeError('buf must be a Buffer, TypedArray, or DataView');
  var byteLength = buf.byteLength;
  if (offset === undefined) offset = 0;
  if (size === undefined) size = byteLength - offset;
  if (offset < 0 || offset > byteLength)
    throw new RangeError('offset is out of range');
  if (size < 0 || offset + size > byteLength)
    throw new RangeError('size is out of range');
  if (size === 0) return buf;
  // Native expects a TypedArray/Buffer.
  var target = buf;
  if (buf instanceof ArrayBuffer)
    target = new Uint8Array(buf);
  else if (ArrayBuffer.isView(buf) && !(buf instanceof Uint8Array))
    target = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  _randomFillSync(target, offset, size);
  return buf;
}

function randomBytes(size, callback) {
  if (typeof size !== 'number' || size < 0 || size !== (size >>> 0))
    throw new RangeError('size must be a non-negative uint32');
  var buf = Buffer.alloc(size);
  if (callback === undefined) {
    randomFillSync(buf, 0, size);
    return buf;
  }
  if (typeof callback !== 'function')
    throw new TypeError('callback must be a function');
  try {
    randomFillSync(buf, 0, size);
    process.nextTick(callback, null, buf);
  } catch (e) {
    process.nextTick(callback, e);
  }
}

function randomInt(min, max, callback) {
  // Supports randomInt(max), randomInt(min, max), randomInt(min, max, cb).
  if (max === undefined || typeof max === 'function') {
    callback = max;
    max = min;
    min = 0;
  }
  if (!Number.isSafeInteger(min)) throw new TypeError('min must be a safe integer');
  if (!Number.isSafeInteger(max)) throw new TypeError('max must be a safe integer');
  if (max <= min) throw new RangeError('max must be greater than min');
  var range = max - min;
  if (range > 0xFFFFFFFFFFFF)
    throw new RangeError('max - min must be <= 2^48 - 1');
  // Use rejection sampling for uniform distribution.
  var buf = Buffer.alloc(6);
  var RAND_MAX = 0xFFFFFFFFFFFF;
  var randLimit = RAND_MAX - (RAND_MAX % range);
  while (true) {
    randomFillSync(buf);
    var x = buf.readUIntBE(0, 6);
    if (x < randLimit) {
      var n = (x % range) + min;
      if (callback) { process.nextTick(callback, null, n); return; }
      return n;
    }
  }
}

// An RFC 4122 version 4 random UUID, ported from Node's
// lib/internal/crypto/random.js.
//
// Entropy is drawn in batches of kBatchSize UUIDs and each call consumes 16
// bytes of the batch, because one randomFillSync per UUID is the expensive
// way to do this. Node uses a secureBuffer (zero-filled, kept out of core
// dumps) for the batch; Buffer.alloc is what this layer has, and the
// difference is the memory protection, not the randomness.
var kBatchSize = 128;
var uuidData;
var uuidNotBuffered;
var uuidBatch = 0;

var hexBytesCache;
function getHexBytes() {
  if (hexBytesCache === undefined) {
    hexBytesCache = new Array(256);
    for (var i = 0; i < hexBytesCache.length; i++)
      hexBytesCache[i] = i.toString(16).padStart(2, '0');
  }
  return hexBytesCache;
}

function serializeUUID(buf, offset) {
  var kHexBytes = getHexBytes();
  if (offset === undefined) offset = 0;
  // xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx, where M is the version (4) and the
  // top bits of N are the variant. Those are the only two nibbles the RFC
  // fixes; everything else is straight from the generator.
  return kHexBytes[buf[offset]] +
    kHexBytes[buf[offset + 1]] +
    kHexBytes[buf[offset + 2]] +
    kHexBytes[buf[offset + 3]] +
    '-' +
    kHexBytes[buf[offset + 4]] +
    kHexBytes[buf[offset + 5]] +
    '-' +
    kHexBytes[(buf[offset + 6] & 0x0f) | 0x40] +
    kHexBytes[buf[offset + 7]] +
    '-' +
    kHexBytes[(buf[offset + 8] & 0x3f) | 0x80] +
    kHexBytes[buf[offset + 9]] +
    '-' +
    kHexBytes[buf[offset + 10]] +
    kHexBytes[buf[offset + 11]] +
    kHexBytes[buf[offset + 12]] +
    kHexBytes[buf[offset + 13]] +
    kHexBytes[buf[offset + 14]] +
    kHexBytes[buf[offset + 15]];
}

function getBufferedUUID() {
  if (uuidData === undefined)
    uuidData = Buffer.alloc(16 * kBatchSize);
  // The refill happens before the counter moves, so the slice handed out when
  // the counter wraps to 0 is the last one of the batch that is still live,
  // and the next call is what re-randomizes. Each fill therefore yields
  // kBatchSize distinct slices and no slice is served twice.
  if (uuidBatch === 0) randomFillSync(uuidData);
  uuidBatch = (uuidBatch + 1) % kBatchSize;
  return serializeUUID(uuidData, uuidBatch * 16);
}

function getUnbufferedUUID() {
  if (uuidNotBuffered === undefined)
    uuidNotBuffered = Buffer.alloc(16);
  randomFillSync(uuidNotBuffered);
  return serializeUUID(uuidNotBuffered);
}

function randomUUID(options) {
  if (options !== undefined)
    validateObject(options, 'options');
  var disableEntropyCache = false;
  if (options !== undefined && options.disableEntropyCache !== undefined)
    disableEntropyCache = options.disableEntropyCache;
  validateBoolean(disableEntropyCache, 'options.disableEntropyCache');
  return disableEntropyCache ? getUnbufferedUUID() : getBufferedUUID();
}

// The binding returns plain Uint8Arrays.
function asBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// Buffer, TypedArray, DataView or ArrayBuffer (or a string) as a Buffer.
function toBuffer(value, name, encoding) {
  if (typeof value === 'string')
    return Buffer.from(value, encoding || 'utf8');
  if (value instanceof ArrayBuffer)
    return Buffer.from(value);
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(
    'The "' + name + '" argument must be a string, Buffer, TypedArray, DataView or ArrayBuffer');
}

// HKDF. Like Node, hkdfSync returns an ArrayBuffer.
function hkdfSync(digest, ikm, salt, info, keylen) {
  if (typeof digest !== 'string')
    throw new TypeError('The "digest" argument must be a string');
  if (ikm instanceof KeyObject)
    throw new Error('hkdf with a KeyObject is not implemented');
  if (typeof keylen !== 'number' || keylen < 0 || keylen !== (keylen >>> 0))
    throw new RangeError('The "keylen" argument is out of range');
  var out = asBuffer(_hkdf(digest, toBuffer(ikm, 'ikm'), toBuffer(salt, 'salt'),
                           toBuffer(info, 'info'), keylen));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function hkdf(digest, ikm, salt, info, keylen, callback) {
  if (typeof callback !== 'function')
    throw new TypeError('callback must be a function');
  var out = hkdfSync(digest, ikm, salt, info, keylen);
  process.nextTick(callback, null, out);
}

// Asymmetric keys. Secret keys (createSecretKey) are not implemented.
var kKeyCurves = {
  ed25519: 'Ed25519', ed448: 'Ed448', x25519: 'X25519', x448: 'X448',
};

function KeyObject(type, handle) {
  if (type !== 'public' && type !== 'private')
    throw new TypeError('KeyObject type must be "public" or "private"');
  this.type = type;
  this._handle = handle;
}

Object.defineProperty(KeyObject.prototype, 'asymmetricKeyType', {
  get: function() { return _keyType(this._handle); },
  configurable: true,
  enumerable: true,
});

KeyObject.prototype.export = function(options) {
  options = options || {};
  var isPrivate = this.type === 'private';
  if (options.format === 'jwk') {
    var crv = kKeyCurves[this.asymmetricKeyType];
    if (!crv)
      throw new Error('JWK export is only implemented for OKP keys');
    var jwk = {
      crv: crv,
      x: asBuffer(_keyExport(this._handle, false, 'raw')).toString('base64url'),
      kty: 'OKP',
    };
    if (isPrivate)
      jwk.d = asBuffer(_keyExport(this._handle, true, 'raw')).toString('base64url');
    return jwk;
  }
  if (options.cipher || options.passphrase)
    throw new Error('Encrypted key export is not implemented');
  var expected = isPrivate ? 'pkcs8' : 'spki';
  if (options.type !== undefined && options.type !== expected)
    throw new Error('Key export type "' + options.type + '" is not implemented');
  if (options.format === 'pem')
    return asBuffer(_keyExport(this._handle, isPrivate, 'pem')).toString('latin1');
  if (options.format === 'der')
    return asBuffer(_keyExport(this._handle, isPrivate, 'der'));
  throw new TypeError('The "options.format" property must be "pem", "der" or "jwk"');
};

KeyObject.prototype.equals = function(other) {
  return other instanceof KeyObject && other.type === this.type &&
    this.export({ format: 'der' }).equals(other.export({ format: 'der' }));
};

function parseKey(key, isPrivate) {
  var format = 'pem';
  var encoding;
  if (key !== null && typeof key === 'object' && !ArrayBuffer.isView(key) &&
      !(key instanceof ArrayBuffer)) {
    if (key.passphrase !== undefined)
      throw new Error('Encrypted keys are not implemented');
    format = key.format || 'pem';
    encoding = key.encoding;
    var expected = isPrivate ? 'pkcs8' : 'spki';
    if (format !== 'pem' && format !== 'der')
      throw new Error('Key format "' + format + '" is not implemented');
    if (format === 'der' && key.type !== expected)
      throw new Error('Key type "' + key.type + '" is not implemented');
    key = key.key;
  }
  return _keyParse(toBuffer(key, 'key', encoding), format, isPrivate);
}

function createPrivateKey(key) {
  return new KeyObject('private', parseKey(key, true));
}

function createPublicKey(key) {
  // A private key also holds its public key.
  if (key instanceof KeyObject)
    return new KeyObject('public', key._handle);
  if (key !== null && typeof key === 'object' && key.key instanceof KeyObject)
    return new KeyObject('public', key.key._handle);
  try {
    return new KeyObject('public', parseKey(key, false));
  } catch (e) {
    // Node also accepts a PEM private key here.
    try {
      return new KeyObject('public', parseKey(key, true));
    } catch (_) {
      throw e;
    }
  }
}

function toKeyObject(key, isPrivate) {
  if (key instanceof KeyObject) {
    if (isPrivate && key.type !== 'private')
      throw new TypeError('Invalid key object type public, expected private.');
    return key;
  }
  if (key !== null && typeof key === 'object' && key.key instanceof KeyObject)
    return toKeyObject(key.key, isPrivate);
  return isPrivate ? createPrivateKey(key) : createPublicKey(key);
}

// The signature options of a `{ key, ... }` argument are not implemented.
// Signatures are DER-encoded (ECDSA) with the default padding (RSA).
function checkSignOptions(key) {
  if (key === null || typeof key !== 'object' || key instanceof KeyObject)
    return;
  if (key.dsaEncoding !== undefined && key.dsaEncoding !== 'der')
    throw new Error('dsaEncoding "' + key.dsaEncoding + '" is not implemented');
  if (key.padding !== undefined || key.saltLength !== undefined)
    throw new Error('The padding and saltLength options are not implemented');
}

// With a callback, the result or the error goes to the callback.
function callOrReturn(fn, callback) {
  if (typeof callback !== 'function')
    return fn();
  var result;
  try {
    result = fn();
  } catch (e) {
    process.nextTick(callback, e);
    return;
  }
  process.nextTick(callback, null, result);
}

// One-shot sign/verify. `algorithm` is a digest name, or null/undefined for
// keys that fix their own (Ed25519, Ed448).
function sign(algorithm, data, key, callback) {
  return callOrReturn(function() {
    checkSignOptions(key);
    return asBuffer(_signOneShot(
      toKeyObject(key, true)._handle, algorithm == null ? null : algorithm,
      toBuffer(data, 'data')));
  }, callback);
}

function verify(algorithm, data, key, signature, callback) {
  return callOrReturn(function() {
    checkSignOptions(key);
    return _verifyOneShot(
      toKeyObject(key, false)._handle, algorithm == null ? null : algorithm,
      toBuffer(data, 'data'), toBuffer(signature, 'signature'));
  }, callback);
}

function diffieHellman(options) {
  if (options === null || typeof options !== 'object')
    throw new TypeError('The "options" argument must be an object');
  var privateKey = options.privateKey;
  var publicKey = options.publicKey;
  if (!(privateKey instanceof KeyObject) || privateKey.type !== 'private')
    throw new TypeError('The "options.privateKey" property must be a private KeyObject');
  if (!(publicKey instanceof KeyObject))
    throw new TypeError('The "options.publicKey" property must be a KeyObject');
  return asBuffer(_diffieHellman(privateKey._handle, publicKey._handle));
}

// Cipheriv and Decipheriv (extend Transform for .pipe() compatibility).
function CipherBase(algorithm, key, iv, options, encrypt) {
  Transform.call(this, options);
  if (typeof algorithm !== 'string')
    throw new TypeError('The "cipher" argument must be a string');
  if (key instanceof KeyObject)
    throw new Error('Ciphers with a KeyObject are not implemented');
  var authTagLength = options && options.authTagLength;
  this._cipher = new _Cipher(
    algorithm, toBuffer(key, 'key'),
    iv === null ? Buffer.alloc(0) : toBuffer(iv, 'iv'), encrypt,
    authTagLength === undefined ? 16 : authTagLength);
}

Object.setPrototypeOf(CipherBase.prototype, Transform.prototype);
Object.setPrototypeOf(CipherBase, Transform);

// One decoder for each cipher: a character or a base64 group can start in one
// call and end in the next one.
function decodeOutput(self, out, outputEncoding, isFinal) {
  if (!outputEncoding || outputEncoding === 'buffer')
    return out;
  if (!self._decoder)
    self._decoder = new StringDecoder(outputEncoding);
  return isFinal ? self._decoder.end(out) : self._decoder.write(out);
}

CipherBase.prototype.update = function update(data, inputEncoding, outputEncoding) {
  var out = asBuffer(this._cipher.update(toBuffer(data, 'data', inputEncoding)));
  return decodeOutput(this, out, outputEncoding, false);
};

CipherBase.prototype.final = function final(outputEncoding) {
  var out = asBuffer(this._cipher.final());
  return decodeOutput(this, out, outputEncoding, true);
};

CipherBase.prototype.setAAD = function setAAD(buffer) {
  this._cipher.setAAD(toBuffer(buffer, 'buffer'));
  return this;
};

CipherBase.prototype.setAutoPadding = function setAutoPadding(autoPadding) {
  this._cipher.setAutoPadding(autoPadding !== false);
  return this;
};

CipherBase.prototype._transform = function _transform(chunk, encoding, callback) {
  this.push(this.update(chunk, encoding));
  callback();
};

CipherBase.prototype._flush = function _flush(callback) {
  try {
    this.push(this.final());
  } catch (e) {
    callback(e);
    return;
  }
  callback();
};

function Cipheriv(algorithm, key, iv, options) {
  if (!(this instanceof Cipheriv))
    return new Cipheriv(algorithm, key, iv, options);
  CipherBase.call(this, algorithm, key, iv, options, true);
}

Object.setPrototypeOf(Cipheriv.prototype, CipherBase.prototype);
Object.setPrototypeOf(Cipheriv, CipherBase);

Cipheriv.prototype.getAuthTag = function getAuthTag() {
  return asBuffer(this._cipher.getAuthTag());
};

function Decipheriv(algorithm, key, iv, options) {
  if (!(this instanceof Decipheriv))
    return new Decipheriv(algorithm, key, iv, options);
  CipherBase.call(this, algorithm, key, iv, options, false);
}

Object.setPrototypeOf(Decipheriv.prototype, CipherBase.prototype);
Object.setPrototypeOf(Decipheriv, CipherBase);

Decipheriv.prototype.setAuthTag = function setAuthTag(buffer, encoding) {
  this._cipher.setAuthTag(toBuffer(buffer, 'buffer', encoding));
  return this;
};

function createCipheriv(algorithm, key, iv, options) {
  return new Cipheriv(algorithm, key, iv, options);
}

function createDecipheriv(algorithm, key, iv, options) {
  return new Decipheriv(algorithm, key, iv, options);
}

module.exports = {
  Hash,
  Hmac,
  KeyObject,
  Cipheriv,
  Decipheriv,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  getHashes,
  getCiphers,
  timingSafeEqual,
  hash,
  hkdf,
  hkdfSync,
  sign,
  verify,
  diffieHellman,
  randomBytes,
  randomFillSync,
  randomInt,
  randomUUID,
  constants: {},
};

/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <hermes/node-compat/bindings/node_crypto.h>
#include <hermes/node-compat/runtime/runtime_state.h>
#include <node_api.h>
#include <openssl/core_names.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/params.h>
#include <openssl/pem.h>
#include <openssl/x509.h>
#include <uv.h>

#include <algorithm>
#include <cctype>
#include <cstring>
#include <string>
#include <vector>

namespace hermes {
namespace node_compat {

// ---------------------------------------------------------------------------
// Digests (OpenSSL EVP)
// ---------------------------------------------------------------------------
//
// Hash and Hmac use OpenSSL, which hermes-node links for TLS anyway: it has
// every digest Node exposes and uses the CPU's SHA instructions, which makes
// it several times faster than a portable implementation on large inputs.

/// Look up a digest by Node-style name ("sha256", "SHA256", "RSA-SHA256",
/// "sha512-256", ...). Returns nullptr if unknown. The caller owns the result.
static EVP_MD *fetchDigest(const char *name) {
  if (EVP_MD *md = EVP_MD_fetch(nullptr, name, nullptr))
    return md;
  // Legacy aliases such as "RSA-SHA256" are only known to the name table.
  if (const EVP_MD *legacy = EVP_get_digestbyname(name))
    return EVP_MD_fetch(nullptr, EVP_MD_get0_name(legacy), nullptr);
  return nullptr;
}

static void throwUnsupportedDigest(napi_env env) {
  napi_throw_error(
      env, "ERR_CRYPTO_INVALID_DIGEST", "Digest method not supported");
}

/// Read a Buffer/TypedArray/DataView argument. Returns false (with a pending
/// TypeError) if it is none of those.
static bool getBytes(
    napi_env env,
    napi_value value,
    const char *what,
    const unsigned char **data,
    size_t *len) {
  bool isTypedArray = false;
  napi_is_typedarray(env, value, &isTypedArray);
  if (isTypedArray) {
    napi_typedarray_type type;
    size_t length = 0;
    void *ptr = nullptr;
    napi_get_typedarray_info(
        env, value, &type, &length, &ptr, nullptr, nullptr);
    size_t elementSize = 1;
    switch (type) {
      case napi_int16_array:
      case napi_uint16_array:
        elementSize = 2;
        break;
      case napi_int32_array:
      case napi_uint32_array:
      case napi_float32_array:
        elementSize = 4;
        break;
      case napi_float64_array:
      case napi_bigint64_array:
      case napi_biguint64_array:
        elementSize = 8;
        break;
      default:
        break;
    }
    *data = static_cast<const unsigned char *>(ptr);
    *len = length * elementSize;
    return true;
  }
  bool isDataView = false;
  napi_is_dataview(env, value, &isDataView);
  if (isDataView) {
    void *ptr = nullptr;
    napi_get_dataview_info(env, value, len, &ptr, nullptr, nullptr);
    *data = static_cast<const unsigned char *>(ptr);
    return true;
  }
  std::string message = std::string(what) + " must be a Buffer or Uint8Array";
  napi_throw_type_error(env, nullptr, message.c_str());
  return false;
}

static const unsigned char kEmpty[1] = {0};

// ---------------------------------------------------------------------------
// Hash class
// ---------------------------------------------------------------------------

struct HashContext {
  EVP_MD_CTX *ctx = nullptr;
  bool finalized = false;

  ~HashContext() {
    EVP_MD_CTX_free(ctx);
  }
};

static void hashContextFinalizer(napi_env, void *data, void *) {
  delete static_cast<HashContext *>(data);
}

static napi_value hashNew(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], thisVal;
  napi_get_cb_info(env, info, &argc, argv, &thisVal, nullptr);

  if (argc < 1) {
    napi_throw_error(env, nullptr, "algorithm argument required");
    return nullptr;
  }

  char algoBuf[64];
  size_t algoLen = 0;
  napi_get_value_string_utf8(env, argv[0], algoBuf, sizeof(algoBuf), &algoLen);

  EVP_MD *md = fetchDigest(algoBuf);
  if (!md) {
    throwUnsupportedDigest(env);
    return nullptr;
  }

  auto *hctx = new HashContext();
  hctx->ctx = EVP_MD_CTX_new();
  bool ok = hctx->ctx && EVP_DigestInit_ex2(hctx->ctx, md, nullptr) == 1;
  EVP_MD_free(md);
  if (!ok) {
    delete hctx;
    throwUnsupportedDigest(env);
    return nullptr;
  }

  napi_wrap(env, thisVal, hctx, hashContextFinalizer, nullptr, nullptr);
  return thisVal;
}

static napi_value hashUpdate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], thisVal;
  napi_get_cb_info(env, info, &argc, argv, &thisVal, nullptr);

  HashContext *hctx = nullptr;
  napi_unwrap(env, thisVal, reinterpret_cast<void **>(&hctx));
  if (!hctx || hctx->finalized) {
    napi_throw_error(env, nullptr, "Digest already called");
    return nullptr;
  }

  if (argc >= 1) {
    const unsigned char *data = nullptr;
    size_t len = 0;
    if (!getBytes(env, argv[0], "data", &data, &len))
      return nullptr;
    if (len > 0)
      EVP_DigestUpdate(hctx->ctx, data, len);
  }

  // Return true for success (JS wrapper chains .update calls).
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value hashDigest(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);

  HashContext *hctx = nullptr;
  napi_unwrap(env, thisVal, reinterpret_cast<void **>(&hctx));
  if (!hctx || hctx->finalized) {
    napi_throw_error(env, nullptr, "Digest already called");
    return nullptr;
  }

  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned int digestLen = 0;
  hctx->finalized = true;
  const EVP_MD *md = EVP_MD_CTX_get0_md(hctx->ctx);
  int ok;
  if (md && (EVP_MD_get_flags(md) & EVP_MD_FLAG_XOF)) {
    // shake128/shake256: Node's default output length is the digest size.
    digestLen = static_cast<unsigned int>(EVP_MD_get_size(md));
    ok = EVP_DigestFinalXOF(hctx->ctx, digest, digestLen);
  } else {
    ok = EVP_DigestFinal_ex(hctx->ctx, digest, &digestLen);
  }
  if (ok != 1) {
    napi_throw_error(env, nullptr, "Digest failed");
    return nullptr;
  }

  napi_value result;
  napi_create_buffer_copy(env, digestLen, digest, nullptr, &result);
  return result;
}

static napi_value hashCopy(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);

  HashContext *hctx = nullptr;
  napi_unwrap(env, thisVal, reinterpret_cast<void **>(&hctx));
  if (!hctx) {
    napi_throw_error(env, nullptr, "Invalid Hash object");
    return nullptr;
  }

  // Create a new Hash instance via the constructor so it has prototype methods.
  napi_value hashCtorVal;
  napi_get_reference_value(
      env, getRuntimeState(env)->hashCtorRef, &hashCtorVal);

  napi_value algoStr;
  napi_create_string_utf8(
      env,
      EVP_MD_get0_name(EVP_MD_CTX_get0_md(hctx->ctx)),
      NAPI_AUTO_LENGTH,
      &algoStr);

  napi_value newInstance;
  if (napi_new_instance(env, hashCtorVal, 1, &algoStr, &newInstance) != napi_ok)
    return nullptr;

  // Overwrite the fresh context with a copy of the source state.
  HashContext *newCtx = nullptr;
  napi_unwrap(env, newInstance, reinterpret_cast<void **>(&newCtx));
  EVP_MD_CTX_copy_ex(newCtx->ctx, hctx->ctx);
  newCtx->finalized = hctx->finalized;

  return newInstance;
}

// ---------------------------------------------------------------------------
// Hmac class
// ---------------------------------------------------------------------------

struct HmacContext {
  EVP_MAC_CTX *ctx = nullptr;
  bool finalized = false;

  ~HmacContext() {
    EVP_MAC_CTX_free(ctx);
  }
};

static void hmacContextFinalizer(napi_env, void *data, void *) {
  delete static_cast<HmacContext *>(data);
}

static napi_value hmacNew(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);
  // No-op constructor. Actual init happens in hmacInit.
  return thisVal;
}

static napi_value hmacInit(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], thisVal;
  napi_get_cb_info(env, info, &argc, argv, &thisVal, nullptr);

  if (argc < 2) {
    napi_throw_error(env, nullptr, "algorithm and key arguments required");
    return nullptr;
  }

  char algoBuf[64];
  size_t algoLen = 0;
  napi_get_value_string_utf8(env, argv[0], algoBuf, sizeof(algoBuf), &algoLen);

  EVP_MD *md = fetchDigest(algoBuf);
  if (!md) {
    std::string message = std::string("Invalid digest: ") + algoBuf;
    napi_throw_type_error(env, "ERR_CRYPTO_INVALID_DIGEST", message.c_str());
    return nullptr;
  }
  std::string digestName = EVP_MD_get0_name(md);
  EVP_MD_free(md);

  const unsigned char *key = nullptr;
  size_t keyLen = 0;
  if (!getBytes(env, argv[1], "key", &key, &keyLen))
    return nullptr;

  EVP_MAC *mac = EVP_MAC_fetch(nullptr, "HMAC", nullptr);
  auto *hctx = new HmacContext();
  hctx->ctx = mac ? EVP_MAC_CTX_new(mac) : nullptr;
  EVP_MAC_free(mac);
  OSSL_PARAM params[] = {
      OSSL_PARAM_construct_utf8_string(
          OSSL_MAC_PARAM_DIGEST, &digestName[0], 0),
      OSSL_PARAM_construct_end(),
  };
  if (!hctx->ctx ||
      EVP_MAC_init(hctx->ctx, keyLen ? key : kEmpty, keyLen, params) != 1) {
    delete hctx;
    napi_throw_error(env, nullptr, "HMAC initialization failed");
    return nullptr;
  }

  napi_wrap(env, thisVal, hctx, hmacContextFinalizer, nullptr, nullptr);
  return thisVal;
}

static napi_value hmacUpdate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], thisVal;
  napi_get_cb_info(env, info, &argc, argv, &thisVal, nullptr);

  HmacContext *hctx = nullptr;
  napi_unwrap(env, thisVal, reinterpret_cast<void **>(&hctx));
  if (!hctx || hctx->finalized) {
    napi_throw_error(env, nullptr, "Digest already called");
    return nullptr;
  }

  if (argc >= 1) {
    const unsigned char *data = nullptr;
    size_t len = 0;
    if (!getBytes(env, argv[0], "data", &data, &len))
      return nullptr;
    if (len > 0)
      EVP_MAC_update(hctx->ctx, data, len);
  }

  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value hmacDigest(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);

  HmacContext *hctx = nullptr;
  napi_unwrap(env, thisVal, reinterpret_cast<void **>(&hctx));
  if (!hctx || hctx->finalized) {
    napi_throw_error(env, nullptr, "Digest already called");
    return nullptr;
  }

  unsigned char digest[EVP_MAX_MD_SIZE];
  size_t digestLen = 0;
  hctx->finalized = true;
  if (EVP_MAC_final(hctx->ctx, digest, &digestLen, sizeof(digest)) != 1) {
    napi_throw_error(env, nullptr, "Digest failed");
    return nullptr;
  }

  napi_value result;
  napi_create_buffer_copy(env, digestLen, digest, nullptr, &result);
  return result;
}

// ---------------------------------------------------------------------------
// Standalone functions
// ---------------------------------------------------------------------------

/// The digest names Node's crypto.getHashes() reports, filtered to the ones
/// this OpenSSL provides.
static napi_value getHashes(napi_env env, napi_callback_info) {
  static const char *const kNames[] = {
      "RSA-MD5",
      "RSA-RIPEMD160",
      "RSA-SHA1",
      "RSA-SHA1-2",
      "RSA-SHA224",
      "RSA-SHA256",
      "RSA-SHA3-224",
      "RSA-SHA3-256",
      "RSA-SHA3-384",
      "RSA-SHA3-512",
      "RSA-SHA384",
      "RSA-SHA512",
      "RSA-SHA512/224",
      "RSA-SHA512/256",
      "RSA-SM3",
      "blake2b512",
      "blake2s256",
      "id-rsassa-pkcs1-v1_5-with-sha3-224",
      "id-rsassa-pkcs1-v1_5-with-sha3-256",
      "id-rsassa-pkcs1-v1_5-with-sha3-384",
      "id-rsassa-pkcs1-v1_5-with-sha3-512",
      "md5",
      "md5-sha1",
      "md5WithRSAEncryption",
      "ripemd",
      "ripemd160",
      "ripemd160WithRSA",
      "rmd160",
      "sha1",
      "sha1WithRSAEncryption",
      "sha224",
      "sha224WithRSAEncryption",
      "sha256",
      "sha256WithRSAEncryption",
      "sha3-224",
      "sha3-256",
      "sha3-384",
      "sha3-512",
      "sha384",
      "sha384WithRSAEncryption",
      "sha512",
      "sha512-224",
      "sha512-224WithRSAEncryption",
      "sha512-256",
      "sha512-256WithRSAEncryption",
      "sha512WithRSAEncryption",
      "shake128",
      "shake256",
      "sm3",
      "sm3WithRSAEncryption",
      "ssl3-md5",
      "ssl3-sha1",
  };
  napi_value result;
  napi_create_array(env, &result);
  uint32_t i = 0;
  for (const char *name : kNames) {
    EVP_MD *md = fetchDigest(name);
    if (!md)
      continue;
    EVP_MD_free(md);
    napi_value str;
    napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &str);
    napi_set_element(env, result, i++, str);
  }
  return result;
}

static napi_value getFipsCrypto(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_int32(env, 0, &result);
  return result;
}

static napi_value setFipsCrypto(napi_env env, napi_callback_info) {
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value timingSafeEqual(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 2) {
    napi_throw_error(env, nullptr, "two arguments required");
    return nullptr;
  }

  void *dataA = nullptr, *dataB = nullptr;
  size_t lenA = 0, lenB = 0;
  napi_typedarray_type taType;
  napi_value abuf;
  size_t offset;

  napi_get_typedarray_info(
      env, argv[0], &taType, &lenA, &dataA, &abuf, &offset);
  napi_get_typedarray_info(
      env, argv[1], &taType, &lenB, &dataB, &abuf, &offset);

  if (lenA != lenB) {
    napi_throw_range_error(
        env,
        "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
        "Input buffers must have the same byte length");
    return nullptr;
  }

  // Constant-time comparison.
  volatile unsigned char result = 0;
  const volatile unsigned char *a =
      static_cast<const volatile unsigned char *>(dataA);
  const volatile unsigned char *b =
      static_cast<const volatile unsigned char *>(dataB);
  for (size_t i = 0; i < lenA; ++i) {
    result |= a[i] ^ b[i];
  }

  napi_value ret;
  napi_get_boolean(env, result == 0, &ret);
  return ret;
}

static napi_value randomFillSync(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 3) {
    napi_throw_error(
        env, nullptr, "buffer, offset, and size arguments required");
    return nullptr;
  }

  // Get typed array data pointer.
  void *data = nullptr;
  size_t byteLength = 0;
  napi_typedarray_type taType;
  napi_value abuf;
  size_t taOffset;
  napi_status st = napi_get_typedarray_info(
      env, argv[0], &taType, &byteLength, &data, &abuf, &taOffset);
  if (st != napi_ok || !data) {
    napi_throw_type_error(
        env, nullptr, "buffer must be a TypedArray or Buffer");
    return nullptr;
  }

  uint32_t offset = 0;
  napi_get_value_uint32(env, argv[1], &offset);

  uint32_t size = 0;
  napi_get_value_uint32(env, argv[2], &size);

  uv_loop_t *loop = getRuntimeState(env)->loop;
  uv_random_t req;
  int rc =
      uv_random(loop, &req, static_cast<char *>(data) + offset, size, 0, NULL);
  if (rc < 0) {
    napi_throw_error(env, nullptr, uv_strerror(rc));
    return nullptr;
  }

  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

// ---------------------------------------------------------------------------
// Shared helpers for the key, KDF and cipher functions
// ---------------------------------------------------------------------------

/// Throw an Error that carries OpenSSL's reason for the failure, and clear the
/// error queue so it does not leak into the next operation.
static napi_value throwOpenSSLError(napi_env env, const char *fallback) {
  char buf[256];
  unsigned long e = ERR_peek_last_error();
  ERR_clear_error();
  if (e != 0) {
    ERR_error_string_n(e, buf, sizeof(buf));
    napi_throw_error(env, nullptr, buf);
  } else {
    napi_throw_error(env, nullptr, fallback);
  }
  return nullptr;
}

/// Read a string argument. Returns false if the value is not a string.
static bool getString(napi_env env, napi_value value, std::string &out) {
  napi_valuetype t;
  napi_typeof(env, value, &t);
  if (t != napi_string)
    return false;
  size_t len = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &len);
  out.assign(len, '\0');
  napi_get_value_string_utf8(env, value, &out[0], len + 1, &len);
  return true;
}

static napi_value
makeBuffer(napi_env env, const unsigned char *data, size_t len) {
  napi_value result;
  napi_create_buffer_copy(env, len, len ? data : kEmpty, nullptr, &result);
  return result;
}

// ---------------------------------------------------------------------------
// HKDF
// ---------------------------------------------------------------------------

/// hkdf(digest, key, salt, info, length) -> Buffer
static napi_value hkdf(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  std::string digestName;
  const unsigned char *key, *salt, *infoBytes;
  size_t keyLen, saltLen, infoLen;
  uint32_t length = 0;
  if (argc < 5 || !getString(env, argv[0], digestName)) {
    napi_throw_type_error(env, nullptr, "hkdf: invalid arguments");
    return nullptr;
  }
  if (!getBytes(env, argv[1], "ikm", &key, &keyLen) ||
      !getBytes(env, argv[2], "salt", &salt, &saltLen) ||
      !getBytes(env, argv[3], "info", &infoBytes, &infoLen))
    return nullptr;
  napi_get_value_uint32(env, argv[4], &length);

  EVP_MD *md = fetchDigest(digestName.c_str());
  if (!md) {
    throwUnsupportedDigest(env);
    return nullptr;
  }
  std::vector<unsigned char> out(length ? length : 1);
  EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, nullptr);
  bool ok = ctx && EVP_PKEY_derive_init(ctx) == 1 &&
      EVP_PKEY_CTX_set_hkdf_md(ctx, md) == 1 &&
      EVP_PKEY_CTX_set1_hkdf_key(
          ctx, keyLen ? key : kEmpty, static_cast<int>(keyLen)) == 1 &&
      EVP_PKEY_CTX_set1_hkdf_salt(
          ctx, saltLen ? salt : kEmpty, static_cast<int>(saltLen)) == 1 &&
      EVP_PKEY_CTX_add1_hkdf_info(
          ctx, infoLen ? infoBytes : kEmpty, static_cast<int>(infoLen)) == 1;
  size_t outLen = length;
  if (ok && length > 0)
    ok = EVP_PKEY_derive(ctx, out.data(), &outLen) == 1;
  EVP_PKEY_CTX_free(ctx);
  EVP_MD_free(md);
  if (!ok)
    return throwOpenSSLError(env, "hkdf failed");
  return makeBuffer(env, out.data(), length);
}

// ---------------------------------------------------------------------------
// Asymmetric keys
// ---------------------------------------------------------------------------
//
// A key is an EVP_PKEY in a napi external. libjs/shims/crypto.js wraps it in
// KeyObject and records whether it is used as a public or a private key: a
// private EVP_PKEY also serves as its public key.

static void keyFinalizer(napi_env, void *data, void *) {
  EVP_PKEY_free(static_cast<EVP_PKEY *>(data));
}

static EVP_PKEY *getKey(napi_env env, napi_value value) {
  void *data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok || !data) {
    napi_throw_type_error(env, nullptr, "Invalid key handle");
    return nullptr;
  }
  return static_cast<EVP_PKEY *>(data);
}

/// keyParse(data, format, isPrivate) -> key handle
/// format is "der" (PKCS#8 for a private key, SPKI for a public key) or "pem".
static napi_value keyParse(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  const unsigned char *data;
  size_t len;
  std::string format;
  bool isPrivate = false;
  if (argc < 3 || !getBytes(env, argv[0], "key", &data, &len))
    return nullptr;
  getString(env, argv[1], format);
  napi_get_value_bool(env, argv[2], &isPrivate);

  EVP_PKEY *pkey = nullptr;
  if (format == "pem") {
    BIO *bio = BIO_new_mem_buf(data, static_cast<int>(len));
    if (bio) {
      pkey = isPrivate ? PEM_read_bio_PrivateKey(bio, nullptr, nullptr, nullptr)
                       : PEM_read_bio_PUBKEY(bio, nullptr, nullptr, nullptr);
      BIO_free(bio);
    }
  } else {
    const unsigned char *p = data;
    pkey = isPrivate ? d2i_AutoPrivateKey(nullptr, &p, static_cast<long>(len))
                     : d2i_PUBKEY(nullptr, &p, static_cast<long>(len));
  }
  if (!pkey)
    return throwOpenSSLError(env, "Failed to read the key");

  napi_value result;
  napi_create_external(env, pkey, keyFinalizer, nullptr, &result);
  return result;
}

/// keyType(handle) -> the Node asymmetricKeyType, e.g. "ed25519", "rsa", "ec"
static napi_value keyType(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  EVP_PKEY *pkey = argc >= 1 ? getKey(env, argv[0]) : nullptr;
  if (!pkey)
    return nullptr;
  const char *name = EVP_PKEY_get0_type_name(pkey);
  std::string type = name ? name : "";
  std::transform(type.begin(), type.end(), type.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  napi_value result;
  napi_create_string_utf8(env, type.c_str(), type.size(), &result);
  return result;
}

/// keyExport(handle, isPrivate, format) -> Buffer
/// format is "der" or "pem" (PKCS#8 / SPKI), or "raw" for the raw key bytes of
/// an Ed25519, X25519, Ed448 or X448 key.
static napi_value keyExport(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  EVP_PKEY *pkey = argc >= 3 ? getKey(env, argv[0]) : nullptr;
  if (!pkey)
    return nullptr;
  bool isPrivate = false;
  napi_get_value_bool(env, argv[1], &isPrivate);
  std::string format;
  getString(env, argv[2], format);

  if (format == "raw") {
    unsigned char raw[128];
    size_t rawLen = sizeof(raw);
    int ok = isPrivate ? EVP_PKEY_get_raw_private_key(pkey, raw, &rawLen)
                       : EVP_PKEY_get_raw_public_key(pkey, raw, &rawLen);
    if (ok != 1)
      return throwOpenSSLError(env, "The key has no raw form");
    napi_value result = makeBuffer(env, raw, rawLen);
    OPENSSL_cleanse(raw, sizeof(raw));
    return result;
  }

  BIO *bio = BIO_new(BIO_s_mem());
  if (!bio)
    return throwOpenSSLError(env, "Failed to export the key");
  int ok;
  if (format == "pem") {
    ok = isPrivate ? PEM_write_bio_PKCS8PrivateKey(
                         bio, pkey, nullptr, nullptr, 0, nullptr, nullptr)
                   : PEM_write_bio_PUBKEY(bio, pkey);
  } else {
    ok = isPrivate ? i2d_PKCS8PrivateKey_bio(
                         bio, pkey, nullptr, nullptr, 0, nullptr, nullptr)
                   : i2d_PUBKEY_bio(bio, pkey);
  }
  if (ok != 1) {
    BIO_free(bio);
    return throwOpenSSLError(env, "Failed to export the key");
  }
  char *data = nullptr;
  long len = BIO_get_mem_data(bio, &data);
  napi_value result = makeBuffer(
      env, reinterpret_cast<unsigned char *>(data), static_cast<size_t>(len));
  BIO_free(bio);
  return result;
}

/// signOneShot(handle, digest | null, data) -> Buffer
static napi_value signOneShot(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  EVP_PKEY *pkey = argc >= 3 ? getKey(env, argv[0]) : nullptr;
  if (!pkey)
    return nullptr;
  std::string digestName;
  EVP_MD *md = nullptr;
  if (getString(env, argv[1], digestName) &&
      !(md = fetchDigest(digestName.c_str()))) {
    throwUnsupportedDigest(env);
    return nullptr;
  }
  const unsigned char *data;
  size_t len;
  if (!getBytes(env, argv[2], "data", &data, &len)) {
    EVP_MD_free(md);
    return nullptr;
  }

  EVP_MD_CTX *ctx = EVP_MD_CTX_new();
  size_t sigLen = 0;
  std::vector<unsigned char> sig;
  bool ok = ctx && EVP_DigestSignInit(ctx, nullptr, md, nullptr, pkey) == 1 &&
      EVP_DigestSign(ctx, nullptr, &sigLen, len ? data : kEmpty, len) == 1;
  if (ok) {
    sig.resize(sigLen ? sigLen : 1);
    ok =
        EVP_DigestSign(ctx, sig.data(), &sigLen, len ? data : kEmpty, len) == 1;
  }
  EVP_MD_CTX_free(ctx);
  EVP_MD_free(md);
  if (!ok)
    return throwOpenSSLError(env, "Failed to sign");
  return makeBuffer(env, sig.data(), sigLen);
}

/// verifyOneShot(handle, digest | null, data, signature) -> boolean
static napi_value verifyOneShot(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  EVP_PKEY *pkey = argc >= 4 ? getKey(env, argv[0]) : nullptr;
  if (!pkey)
    return nullptr;
  std::string digestName;
  EVP_MD *md = nullptr;
  if (getString(env, argv[1], digestName) &&
      !(md = fetchDigest(digestName.c_str()))) {
    throwUnsupportedDigest(env);
    return nullptr;
  }
  const unsigned char *data, *sig;
  size_t len, sigLen;
  if (!getBytes(env, argv[2], "data", &data, &len) ||
      !getBytes(env, argv[3], "signature", &sig, &sigLen)) {
    EVP_MD_free(md);
    return nullptr;
  }

  EVP_MD_CTX *ctx = EVP_MD_CTX_new();
  bool initOk =
      ctx && EVP_DigestVerifyInit(ctx, nullptr, md, nullptr, pkey) == 1;
  int verified = initOk
      ? EVP_DigestVerify(
            ctx, sigLen ? sig : kEmpty, sigLen, len ? data : kEmpty, len)
      : -1;
  EVP_MD_CTX_free(ctx);
  EVP_MD_free(md);
  if (!initOk)
    return throwOpenSSLError(env, "Failed to verify");
  // A signature that does not match is a result, not an error.
  ERR_clear_error();
  napi_value result;
  napi_get_boolean(env, verified == 1, &result);
  return result;
}

/// diffieHellman(privateHandle, publicHandle) -> Buffer
static napi_value diffieHellman(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  EVP_PKEY *priv = argc >= 2 ? getKey(env, argv[0]) : nullptr;
  EVP_PKEY *pub = priv ? getKey(env, argv[1]) : nullptr;
  if (!priv || !pub)
    return nullptr;

  EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new(priv, nullptr);
  size_t secretLen = 0;
  std::vector<unsigned char> secret;
  bool ok = ctx && EVP_PKEY_derive_init(ctx) == 1 &&
      EVP_PKEY_derive_set_peer(ctx, pub) == 1 &&
      EVP_PKEY_derive(ctx, nullptr, &secretLen) == 1;
  if (ok) {
    secret.resize(secretLen ? secretLen : 1);
    ok = EVP_PKEY_derive(ctx, secret.data(), &secretLen) == 1;
  }
  EVP_PKEY_CTX_free(ctx);
  if (!ok)
    return throwOpenSSLError(env, "diffieHellman failed");
  napi_value result = makeBuffer(env, secret.data(), secretLen);
  OPENSSL_cleanse(secret.data(), secret.size());
  return result;
}

// ---------------------------------------------------------------------------
// Ciphers
// ---------------------------------------------------------------------------

static napi_value getCiphers(napi_env env, napi_callback_info) {
  std::vector<std::string> names;
  EVP_CIPHER_do_all_provided(
      nullptr,
      [](EVP_CIPHER *cipher, void *arg) {
        std::string name = EVP_CIPHER_get0_name(cipher);
        std::transform(
            name.begin(), name.end(), name.begin(), [](unsigned char c) {
              return static_cast<char>(std::tolower(c));
            });
        static_cast<std::vector<std::string> *>(arg)->push_back(name);
      },
      &names);
  std::sort(names.begin(), names.end());
  names.erase(std::unique(names.begin(), names.end()), names.end());

  napi_value arr;
  napi_create_array_with_length(env, names.size(), &arr);
  for (size_t i = 0; i < names.size(); i++) {
    napi_value str;
    napi_create_string_utf8(env, names[i].c_str(), names[i].size(), &str);
    napi_set_element(env, arr, static_cast<uint32_t>(i), str);
  }
  return arr;
}

struct CipherContext {
  EVP_CIPHER_CTX *ctx = nullptr;
  bool encrypt = true;
  bool aead = false;
  int authTagLength = 16;

  ~CipherContext() {
    EVP_CIPHER_CTX_free(ctx);
  }
};

static void cipherContextFinalizer(napi_env, void *data, void *) {
  delete static_cast<CipherContext *>(data);
}

static CipherContext *unwrapCipher(
    napi_env env,
    napi_callback_info info,
    size_t *argc,
    napi_value *argv) {
  napi_value thisVal;
  napi_get_cb_info(env, info, argc, argv, &thisVal, nullptr);
  CipherContext *cctx = nullptr;
  napi_unwrap(env, thisVal, reinterpret_cast<void **>(&cctx));
  if (!cctx || !cctx->ctx)
    napi_throw_error(env, nullptr, "Invalid cipher state");
  return cctx && cctx->ctx ? cctx : nullptr;
}

/// new Cipher(name, key, iv, encrypt, authTagLength)
/// CCM and OCB need the tag and message lengths before the key is set, which
/// this does not do, so they are rejected.
static napi_value cipherNew(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5], thisVal;
  napi_get_cb_info(env, info, &argc, argv, &thisVal, nullptr);

  std::string name;
  const unsigned char *key, *iv;
  size_t keyLen, ivLen;
  if (argc < 5 || !getString(env, argv[0], name)) {
    napi_throw_type_error(env, nullptr, "Cipher: invalid arguments");
    return nullptr;
  }
  if (!getBytes(env, argv[1], "key", &key, &keyLen) ||
      !getBytes(env, argv[2], "iv", &iv, &ivLen))
    return nullptr;
  bool encrypt = true;
  napi_get_value_bool(env, argv[3], &encrypt);
  int32_t authTagLength = 16;
  napi_get_value_int32(env, argv[4], &authTagLength);

  EVP_CIPHER *cipher = EVP_CIPHER_fetch(nullptr, name.c_str(), nullptr);
  if (!cipher) {
    ERR_clear_error();
    napi_throw_error(env, "ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
    return nullptr;
  }
  int mode = EVP_CIPHER_get_mode(cipher);
  if (mode == EVP_CIPH_CCM_MODE || mode == EVP_CIPH_OCB_MODE) {
    EVP_CIPHER_free(cipher);
    napi_throw_error(env, nullptr, "CCM and OCB ciphers are not supported");
    return nullptr;
  }

  auto *cctx = new CipherContext();
  cctx->encrypt = encrypt;
  cctx->aead = (EVP_CIPHER_get_flags(cipher) & EVP_CIPH_FLAG_AEAD_CIPHER) != 0;
  cctx->authTagLength = authTagLength;
  cctx->ctx = EVP_CIPHER_CTX_new();
  bool ok = cctx->ctx &&
      EVP_CipherInit_ex(
          cctx->ctx, cipher, nullptr, nullptr, nullptr, encrypt ? 1 : 0) == 1;
  if (ok && cctx->aead)
    ok = EVP_CIPHER_CTX_ctrl(
             cctx->ctx,
             EVP_CTRL_AEAD_SET_IVLEN,
             static_cast<int>(ivLen),
             nullptr) == 1;
  const char *invalid = nullptr;
  if (ok &&
      static_cast<int>(keyLen) != EVP_CIPHER_CTX_get_key_length(cctx->ctx))
    invalid = "Invalid key length";
  else if (
      ok && static_cast<int>(ivLen) != EVP_CIPHER_CTX_get_iv_length(cctx->ctx))
    invalid = "Invalid initialization vector";
  if (ok && !invalid)
    ok = EVP_CipherInit_ex(
             cctx->ctx,
             nullptr,
             nullptr,
             keyLen ? key : kEmpty,
             ivLen ? iv : kEmpty,
             encrypt ? 1 : 0) == 1;
  EVP_CIPHER_free(cipher);
  if (invalid) {
    delete cctx;
    napi_throw_range_error(env, nullptr, invalid);
    return nullptr;
  }
  if (!ok) {
    delete cctx;
    return throwOpenSSLError(env, "Failed to initialize the cipher");
  }

  napi_wrap(env, thisVal, cctx, cipherContextFinalizer, nullptr, nullptr);
  return thisVal;
}

/// update(data) -> Buffer
static napi_value cipherUpdate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CipherContext *cctx = unwrapCipher(env, info, &argc, argv);
  const unsigned char *data;
  size_t len;
  if (!cctx || argc < 1 || !getBytes(env, argv[0], "data", &data, &len))
    return nullptr;
  std::vector<unsigned char> out(len + EVP_MAX_BLOCK_LENGTH);
  int outLen = 0;
  if (EVP_CipherUpdate(
          cctx->ctx,
          out.data(),
          &outLen,
          len ? data : kEmpty,
          static_cast<int>(len)) != 1)
    return throwOpenSSLError(env, "Cipher update failed");
  return makeBuffer(env, out.data(), static_cast<size_t>(outLen));
}

/// final() -> Buffer
static napi_value cipherFinal(napi_env env, napi_callback_info info) {
  CipherContext *cctx = unwrapCipher(env, info, nullptr, nullptr);
  if (!cctx)
    return nullptr;
  unsigned char out[EVP_MAX_BLOCK_LENGTH];
  int outLen = 0;
  if (EVP_CipherFinal_ex(cctx->ctx, out, &outLen) != 1) {
    if (cctx->aead && !cctx->encrypt) {
      ERR_clear_error();
      napi_throw_error(
          env, nullptr, "Unsupported state or unable to authenticate data");
      return nullptr;
    }
    return throwOpenSSLError(env, "Cipher final failed");
  }
  return makeBuffer(env, out, static_cast<size_t>(outLen));
}

/// setAAD(data)
static napi_value cipherSetAAD(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CipherContext *cctx = unwrapCipher(env, info, &argc, argv);
  const unsigned char *data;
  size_t len;
  if (!cctx || argc < 1 || !getBytes(env, argv[0], "aad", &data, &len))
    return nullptr;
  int outLen = 0;
  if (!cctx->aead ||
      EVP_CipherUpdate(
          cctx->ctx,
          nullptr,
          &outLen,
          len ? data : kEmpty,
          static_cast<int>(len)) != 1)
    return throwOpenSSLError(env, "Failed to set the AAD");
  return nullptr;
}

/// getAuthTag() -> Buffer
static napi_value cipherGetAuthTag(napi_env env, napi_callback_info info) {
  CipherContext *cctx = unwrapCipher(env, info, nullptr, nullptr);
  if (!cctx)
    return nullptr;
  unsigned char tag[EVP_MAX_AEAD_TAG_LENGTH];
  if (!cctx->aead || !cctx->encrypt || cctx->authTagLength < 1 ||
      cctx->authTagLength > static_cast<int>(sizeof(tag)) ||
      EVP_CIPHER_CTX_ctrl(
          cctx->ctx, EVP_CTRL_AEAD_GET_TAG, cctx->authTagLength, tag) != 1)
    return throwOpenSSLError(env, "Failed to get the auth tag");
  return makeBuffer(env, tag, static_cast<size_t>(cctx->authTagLength));
}

/// setAuthTag(tag)
static napi_value cipherSetAuthTag(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CipherContext *cctx = unwrapCipher(env, info, &argc, argv);
  const unsigned char *tag;
  size_t len;
  if (!cctx || argc < 1 || !getBytes(env, argv[0], "tag", &tag, &len))
    return nullptr;
  if (!cctx->aead || cctx->encrypt || len < 1 ||
      EVP_CIPHER_CTX_ctrl(
          cctx->ctx,
          EVP_CTRL_AEAD_SET_TAG,
          static_cast<int>(len),
          const_cast<unsigned char *>(tag)) != 1)
    return throwOpenSSLError(env, "Failed to set the auth tag");
  return nullptr;
}

/// setAutoPadding(enabled)
static napi_value cipherSetAutoPadding(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CipherContext *cctx = unwrapCipher(env, info, &argc, argv);
  if (!cctx)
    return nullptr;
  bool enabled = true;
  if (argc >= 1)
    napi_get_value_bool(env, argv[0], &enabled);
  EVP_CIPHER_CTX_set_padding(cctx->ctx, enabled ? 1 : 0);
  return nullptr;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const char *opensslVersionString() {
  return OpenSSL_version(OPENSSL_VERSION_STRING);
}

napi_value initCryptoBinding(napi_env env, napi_value exports) {
  // Define Hash class.
  napi_property_descriptor hashProtoProps[] = {
      {"update",
       nullptr,
       hashUpdate,
       nullptr,
       nullptr,
       nullptr,
       napi_enumerable,
       nullptr},
      {"digest",
       nullptr,
       hashDigest,
       nullptr,
       nullptr,
       nullptr,
       napi_enumerable,
       nullptr},
      {"copy",
       nullptr,
       hashCopy,
       nullptr,
       nullptr,
       nullptr,
       napi_enumerable,
       nullptr},
  };

  napi_value hashCtor;
  napi_define_class(
      env,
      "Hash",
      NAPI_AUTO_LENGTH,
      hashNew,
      nullptr,
      sizeof(hashProtoProps) / sizeof(hashProtoProps[0]),
      hashProtoProps,
      &hashCtor);

  napi_create_reference(env, hashCtor, 1, &getRuntimeState(env)->hashCtorRef);

  // Define Hmac class.
  napi_property_descriptor hmacProtoProps[] = {
      {"init",
       nullptr,
       hmacInit,
       nullptr,
       nullptr,
       nullptr,
       napi_enumerable,
       nullptr},
      {"update",
       nullptr,
       hmacUpdate,
       nullptr,
       nullptr,
       nullptr,
       napi_enumerable,
       nullptr},
      {"digest",
       nullptr,
       hmacDigest,
       nullptr,
       nullptr,
       nullptr,
       napi_enumerable,
       nullptr},
  };

  napi_value hmacCtor;
  napi_define_class(
      env,
      "Hmac",
      NAPI_AUTO_LENGTH,
      hmacNew,
      nullptr,
      sizeof(hmacProtoProps) / sizeof(hmacProtoProps[0]),
      hmacProtoProps,
      &hmacCtor);

  // Define Cipher class (both directions; the constructor takes `encrypt`).
  // clang-format off
  napi_property_descriptor cipherProtoProps[] = {
    {"update",         nullptr, cipherUpdate,         nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"final",          nullptr, cipherFinal,          nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"setAAD",         nullptr, cipherSetAAD,         nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"getAuthTag",     nullptr, cipherGetAuthTag,     nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"setAuthTag",     nullptr, cipherSetAuthTag,     nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"setAutoPadding", nullptr, cipherSetAutoPadding, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
  };
  // clang-format on

  napi_value cipherCtor;
  napi_define_class(
      env,
      "Cipher",
      NAPI_AUTO_LENGTH,
      cipherNew,
      nullptr,
      sizeof(cipherProtoProps) / sizeof(cipherProtoProps[0]),
      cipherProtoProps,
      &cipherCtor);

  // Constants needed by Node's internal/crypto/random.js.
  napi_value kSync, kAsync;
  napi_create_int32(env, 0, &kSync);
  napi_create_int32(env, 1, &kAsync);

  // clang-format off
  napi_property_descriptor props[] = {
    {"Hash",            nullptr, nullptr,         nullptr, nullptr, hashCtor, napi_enumerable, nullptr},
    {"Hmac",            nullptr, nullptr,         nullptr, nullptr, hmacCtor, napi_enumerable, nullptr},
    {"getHashes",       nullptr, getHashes,       nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"getFipsCrypto",   nullptr, getFipsCrypto,   nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"setFipsCrypto",   nullptr, setFipsCrypto,   nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"timingSafeEqual", nullptr, timingSafeEqual, nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"randomFillSync",  nullptr, randomFillSync,  nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"hkdf",            nullptr, hkdf,            nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"keyParse",        nullptr, keyParse,        nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"keyType",         nullptr, keyType,         nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"keyExport",       nullptr, keyExport,       nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"signOneShot",     nullptr, signOneShot,     nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"verifyOneShot",   nullptr, verifyOneShot,   nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"diffieHellman",   nullptr, diffieHellman,   nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"getCiphers",      nullptr, getCiphers,      nullptr, nullptr, nullptr,  napi_enumerable, nullptr},
    {"Cipher",          nullptr, nullptr,         nullptr, nullptr, cipherCtor, napi_enumerable, nullptr},
    {"kCryptoJobSync",  nullptr, nullptr,         nullptr, nullptr, kSync,    napi_enumerable, nullptr},
    {"kCryptoJobAsync", nullptr, nullptr,         nullptr, nullptr, kAsync,   napi_enumerable, nullptr},
  };
  // clang-format on

  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

} // namespace node_compat
} // namespace hermes

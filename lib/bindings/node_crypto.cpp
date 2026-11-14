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
#include <openssl/evp.h>
#include <openssl/params.h>
#include <uv.h>

#include <cstring>
#include <string>

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
    {"kCryptoJobSync",  nullptr, nullptr,         nullptr, nullptr, kSync,    napi_enumerable, nullptr},
    {"kCryptoJobAsync", nullptr, nullptr,         nullptr, nullptr, kAsync,   napi_enumerable, nullptr},
  };
  // clang-format on

  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

} // namespace node_compat
} // namespace hermes

/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <hermes/node-compat/bindings/node_tls.h>
#include <hermes/node-compat/runtime/runtime_state.h>
#include <node_api.h>

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>

#include <cstring>
#include <string>
#include <vector>

namespace hermes {
namespace node_compat {

namespace {

// Status codes shared with libjs/shims/tls.js. Keep in sync.
enum EngineStatus {
  kOk = 0,
  kWantRead = 1, // needs more ciphertext from the peer
  kClosed = 2, // peer sent close_notify
  kError = 3,
};

void ensureOpenSSLInit() {
  static bool done = false;
  if (!done) {
    SSL_library_init();
    SSL_load_error_strings();
    OPENSSL_init_ssl(OPENSSL_INIT_LOAD_SSL_STRINGS, nullptr);
    done = true;
  }
}

/// Drain OpenSSL's error queue into a single message. The queue must be
/// cleared either way, or a stale error leaks into the next operation's
/// diagnosis.
std::string takeOpenSSLError() {
  std::string msg;
  unsigned long e;
  while ((e = ERR_get_error()) != 0) {
    char buf[256];
    ERR_error_string_n(e, buf, sizeof(buf));
    if (!msg.empty())
      msg += "; ";
    msg += buf;
  }
  return msg.empty() ? std::string("unknown TLS error") : msg;
}

struct Engine {
  SSL_CTX *ctx = nullptr;
  SSL *ssl = nullptr;
  BIO *rbio = nullptr; // ciphertext from the peer goes in here
  BIO *wbio = nullptr; // ciphertext to send to the peer comes out of here
  std::string lastError;
  bool handshakeDone = false;

  ~Engine() {
    if (ssl)
      SSL_free(ssl); // frees rbio/wbio too, they are owned by the SSL
    if (ctx)
      SSL_CTX_free(ctx);
  }
};

void engineFinalizer(napi_env, void *data, void *) {
  delete static_cast<Engine *>(data);
}

Engine *unwrapEngine(napi_env env, napi_value thisVal) {
  Engine *eng = nullptr;
  if (napi_unwrap(env, thisVal, reinterpret_cast<void **>(&eng)) != napi_ok)
    return nullptr;
  return eng;
}

// --- option reading helpers ------------------------------------------------

bool getStringProp(
    napi_env env,
    napi_value obj,
    const char *name,
    std::string &out) {
  napi_value v;
  if (napi_get_named_property(env, obj, name, &v) != napi_ok)
    return false;
  napi_valuetype t;
  napi_typeof(env, v, &t);
  if (t != napi_string)
    return false;
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &len) != napi_ok)
    return false;
  out.assign(len, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, v, &out[0], len + 1, &copied) != napi_ok)
    return false;
  return true;
}

bool getBoolProp(
    napi_env env,
    napi_value obj,
    const char *name,
    bool defaultValue) {
  napi_value v;
  if (napi_get_named_property(env, obj, name, &v) != napi_ok)
    return defaultValue;
  napi_valuetype t;
  napi_typeof(env, v, &t);
  if (t != napi_boolean)
    return defaultValue;
  bool b = defaultValue;
  napi_get_value_bool(env, v, &b);
  return b;
}

/// Collect a PEM option that may be a string or an array of strings, which is
/// how Node accepts `ca`.
bool getPemList(
    napi_env env,
    napi_value obj,
    const char *name,
    std::vector<std::string> &out) {
  napi_value v;
  if (napi_get_named_property(env, obj, name, &v) != napi_ok)
    return false;
  napi_valuetype t;
  napi_typeof(env, v, &t);
  if (t == napi_string) {
    std::string s;
    if (getStringProp(env, obj, name, s)) {
      out.push_back(std::move(s));
      return true;
    }
    return false;
  }
  bool isArray = false;
  napi_is_array(env, v, &isArray);
  if (!isArray)
    return false;
  uint32_t len = 0;
  napi_get_array_length(env, v, &len);
  for (uint32_t i = 0; i < len; i++) {
    napi_value el;
    if (napi_get_element(env, v, i, &el) != napi_ok)
      continue;
    napi_valuetype et;
    napi_typeof(env, el, &et);
    if (et != napi_string)
      continue;
    size_t slen = 0;
    napi_get_value_string_utf8(env, el, nullptr, 0, &slen);
    std::string s(slen, '\0');
    size_t copied = 0;
    napi_get_value_string_utf8(env, el, &s[0], slen + 1, &copied);
    out.push_back(std::move(s));
  }
  return !out.empty();
}

/// Load one or more PEM certificates into the context's trust store.
///
/// Node's `ca` option *replaces* the default roots rather than adding to
/// them, so a caller that passes `ca` gets exactly what it asked for.
bool addTrustedPems(
    SSL_CTX *ctx,
    const std::vector<std::string> &pems,
    std::string &err) {
  X509_STORE *store = SSL_CTX_get_cert_store(ctx);
  if (!store) {
    err = "no certificate store";
    return false;
  }
  size_t added = 0;
  for (const auto &pem : pems) {
    BIO *bio = BIO_new_mem_buf(pem.data(), static_cast<int>(pem.size()));
    if (!bio)
      continue;
    // A single PEM string can hold a whole bundle, so keep reading.
    while (X509 *cert =
               PEM_read_bio_X509(bio, nullptr, nullptr, nullptr)) {
      if (X509_STORE_add_cert(store, cert) == 1) {
        added++;
      } else {
        // Duplicates are expected when bundles overlap; not an error.
        unsigned long e = ERR_peek_last_error();
        if (ERR_GET_REASON(e) != X509_R_CERT_ALREADY_IN_HASH_TABLE) {
          X509_free(cert);
          BIO_free(bio);
          err = takeOpenSSLError();
          return false;
        }
        ERR_clear_error();
      }
      X509_free(cert);
    }
    ERR_clear_error(); // the loop ends with a benign "no start line"
    BIO_free(bio);
  }
  if (added == 0) {
    err = "no certificates could be parsed from the ca option";
    return false;
  }
  return true;
}

// --- JS surface -----------------------------------------------------------

/// new TlsEngine(options)
///
/// options: { isServer, servername, rejectUnauthorized, ca, cert, key,
///            requestCert, ALPNProtocols, minVersion, maxVersion }
napi_value engineNew(napi_env env, napi_callback_info info) {
  ensureOpenSSLInit();

  size_t argc = 1;
  napi_value argv[1], thisVal;
  napi_get_cb_info(env, info, &argc, argv, &thisVal, nullptr);

  napi_value opts = nullptr;
  if (argc >= 1) {
    napi_valuetype t;
    napi_typeof(env, argv[0], &t);
    if (t == napi_object)
      opts = argv[0];
  }

  bool isServer = opts && getBoolProp(env, opts, "isServer", false);
  // Node's default. A caller that genuinely wants an unverified connection
  // has to say so, as it does for a self-signed device certificate.
  bool rejectUnauthorized =
      !opts || getBoolProp(env, opts, "rejectUnauthorized", true);

  auto *eng = new Engine();

  eng->ctx = SSL_CTX_new(isServer ? TLS_server_method() : TLS_client_method());
  if (!eng->ctx) {
    std::string err = takeOpenSSLError();
    delete eng;
    napi_throw_error(env, nullptr, err.c_str());
    return nullptr;
  }

  // TLS 1.2 is the floor; anything older is not worth carrying.
  SSL_CTX_set_min_proto_version(eng->ctx, TLS1_2_VERSION);

  std::vector<std::string> caPems;
  if (opts && getPemList(env, opts, "ca", caPems)) {
    std::string err;
    if (!addTrustedPems(eng->ctx, caPems, err)) {
      delete eng;
      napi_throw_error(env, nullptr, err.c_str());
      return nullptr;
    }
  } else {
    // Fall back to OpenSSL's configured roots.
    if (SSL_CTX_set_default_verify_paths(eng->ctx) != 1) {
      ERR_clear_error();
      // Not fatal on its own: a caller with rejectUnauthorized:false does not
      // need roots at all, and one that does will get a verify error with a
      // clear reason.
    }
  }

  // Client certificate. Both halves have to be present to be useful; this is
  // the pairing-record path for a physical iOS device.
  std::string certPem, keyPem;
  const bool haveCert = opts && getStringProp(env, opts, "cert", certPem);
  const bool haveKey = opts && getStringProp(env, opts, "key", keyPem);
  if (haveCert != haveKey) {
    delete eng;
    napi_throw_error(
        env, nullptr, "tls: 'cert' and 'key' must be provided together");
    return nullptr;
  }
  if (haveCert && haveKey) {
    BIO *cbio = BIO_new_mem_buf(certPem.data(), static_cast<int>(certPem.size()));
    X509 *cert = cbio ? PEM_read_bio_X509(cbio, nullptr, nullptr, nullptr)
                      : nullptr;
    bool ok = cert && SSL_CTX_use_certificate(eng->ctx, cert) == 1;
    if (cert)
      X509_free(cert);
    if (cbio)
      BIO_free(cbio);

    if (ok) {
      BIO *kbio =
          BIO_new_mem_buf(keyPem.data(), static_cast<int>(keyPem.size()));
      EVP_PKEY *pkey =
          kbio ? PEM_read_bio_PrivateKey(kbio, nullptr, nullptr, nullptr)
               : nullptr;
      ok = pkey && SSL_CTX_use_PrivateKey(eng->ctx, pkey) == 1;
      if (pkey)
        EVP_PKEY_free(pkey);
      if (kbio)
        BIO_free(kbio);
    }

    if (!ok) {
      std::string err = takeOpenSSLError();
      delete eng;
      napi_throw_error(env, nullptr, ("tls: " + err).c_str());
      return nullptr;
    }
  }

  if (isServer) {
    const bool requestCert = getBoolProp(env, opts, "requestCert", false);
    SSL_CTX_set_verify(
        eng->ctx,
        requestCert ? (rejectUnauthorized
                           ? (SSL_VERIFY_PEER |
                              SSL_VERIFY_FAIL_IF_NO_PEER_CERT)
                           : SSL_VERIFY_PEER)
                    : SSL_VERIFY_NONE,
        nullptr);
  } else {
    // Verify in report-only mode: the handshake completes and JS decides what
    // to do with the result. This keeps the verify error available through
    // verifyError() the way Node exposes authorizationError, instead of
    // surfacing as an opaque handshake failure.
    SSL_CTX_set_verify(eng->ctx, SSL_VERIFY_NONE, nullptr);
  }

  eng->ssl = SSL_new(eng->ctx);
  if (!eng->ssl) {
    std::string err = takeOpenSSLError();
    delete eng;
    napi_throw_error(env, nullptr, err.c_str());
    return nullptr;
  }

  eng->rbio = BIO_new(BIO_s_mem());
  eng->wbio = BIO_new(BIO_s_mem());
  if (!eng->rbio || !eng->wbio) {
    delete eng;
    napi_throw_error(env, nullptr, "tls: failed to allocate memory BIOs");
    return nullptr;
  }
  // SSL takes ownership of both BIOs.
  SSL_set_bio(eng->ssl, eng->rbio, eng->wbio);

  std::string servername;
  if (!isServer && opts && getStringProp(env, opts, "servername", servername) &&
      !servername.empty()) {
    SSL_set_tlsext_host_name(eng->ssl, servername.c_str());
    if (rejectUnauthorized) {
      // Check the name as part of verification rather than reimplementing
      // wildcard and SAN matching in JS.
      X509_VERIFY_PARAM *param = SSL_get0_param(eng->ssl);
      X509_VERIFY_PARAM_set_hostflags(
          param, X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS);
      X509_VERIFY_PARAM_set1_host(
          param, servername.c_str(), servername.size());
    }
  }

  if (isServer)
    SSL_set_accept_state(eng->ssl);
  else
    SSL_set_connect_state(eng->ssl);

  napi_wrap(env, thisVal, eng, engineFinalizer, nullptr, nullptr);
  return thisVal;
}

/// Map an OpenSSL return code to an EngineStatus, recording the message when
/// it is a genuine failure.
EngineStatus classify(Engine *eng, int ret) {
  int err = SSL_get_error(eng->ssl, ret);
  switch (err) {
    case SSL_ERROR_NONE:
      return kOk;
    case SSL_ERROR_WANT_READ:
    case SSL_ERROR_WANT_WRITE:
      return kWantRead;
    case SSL_ERROR_ZERO_RETURN:
      return kClosed;
    case SSL_ERROR_SYSCALL:
      // With memory BIOs there is no syscall; this means the peer went away
      // mid-record.
      eng->lastError = "TLS connection closed unexpectedly";
      return kError;
    default:
      eng->lastError = takeOpenSSLError();
      return kError;
  }
}

napi_value makeInt(napi_env env, int v) {
  napi_value out;
  napi_create_int32(env, v, &out);
  return out;
}

/// handshake() -> status
napi_value engineHandshake(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);
  if (!eng)
    return makeInt(env, kError);

  if (eng->handshakeDone)
    return makeInt(env, kOk);

  ERR_clear_error();
  int ret = SSL_do_handshake(eng->ssl);
  if (ret == 1) {
    eng->handshakeDone = true;
    return makeInt(env, kOk);
  }
  return makeInt(env, classify(eng, ret));
}

/// writeCiphertext(buffer) -> bytes consumed, or -1
/// Feed bytes received from the peer.
napi_value engineWriteCiphertext(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], thisVal;
  napi_get_cb_info(env, info, &argc, argv, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);
  if (!eng || argc < 1)
    return makeInt(env, -1);

  void *data = nullptr;
  size_t len = 0;
  napi_typedarray_type type;
  napi_value ab;
  size_t off = 0;
  if (napi_get_typedarray_info(env, argv[0], &type, &len, &data, &ab, &off) !=
          napi_ok ||
      !data) {
    napi_throw_type_error(
        env, nullptr, "writeCiphertext: expected a Buffer or Uint8Array");
    return nullptr;
  }
  if (len == 0)
    return makeInt(env, 0);

  int written = BIO_write(eng->rbio, data, static_cast<int>(len));
  return makeInt(env, written);
}

/// readCiphertext(buffer) -> bytes written into buffer (0 if none pending)
/// Collect bytes that must be sent to the peer.
napi_value engineReadCiphertext(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], thisVal;
  napi_get_cb_info(env, info, &argc, argv, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);
  if (!eng || argc < 1)
    return makeInt(env, -1);

  void *data = nullptr;
  size_t len = 0;
  napi_typedarray_type type;
  napi_value ab;
  size_t off = 0;
  if (napi_get_typedarray_info(env, argv[0], &type, &len, &data, &ab, &off) !=
          napi_ok ||
      !data) {
    napi_throw_type_error(
        env, nullptr, "readCiphertext: expected a Buffer or Uint8Array");
    return nullptr;
  }

  if (BIO_pending(eng->wbio) <= 0)
    return makeInt(env, 0);

  int n = BIO_read(eng->wbio, data, static_cast<int>(len));
  return makeInt(env, n > 0 ? n : 0);
}

/// writePlaintext(buffer) -> bytes consumed, or negative status
napi_value engineWritePlaintext(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], thisVal;
  napi_get_cb_info(env, info, &argc, argv, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);
  if (!eng || argc < 1)
    return makeInt(env, -1);

  void *data = nullptr;
  size_t len = 0;
  napi_typedarray_type type;
  napi_value ab;
  size_t off = 0;
  if (napi_get_typedarray_info(env, argv[0], &type, &len, &data, &ab, &off) !=
          napi_ok ||
      !data) {
    napi_throw_type_error(
        env, nullptr, "writePlaintext: expected a Buffer or Uint8Array");
    return nullptr;
  }
  if (len == 0)
    return makeInt(env, 0);

  ERR_clear_error();
  int n = SSL_write(eng->ssl, data, static_cast<int>(len));
  if (n > 0)
    return makeInt(env, n);
  return makeInt(env, -classify(eng, n));
}

/// readPlaintext(buffer) -> { n, status }
/// Returns an object because "no data right now" and "0 bytes" need to be
/// distinguishable from "connection closed".
napi_value engineReadPlaintext(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], thisVal;
  napi_get_cb_info(env, info, &argc, argv, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);

  napi_value result;
  napi_create_object(env, &result);

  auto setFields = [&](int n, EngineStatus st) {
    napi_set_named_property(env, result, "n", makeInt(env, n));
    napi_set_named_property(env, result, "status", makeInt(env, st));
  };

  if (!eng || argc < 1) {
    setFields(0, kError);
    return result;
  }

  void *data = nullptr;
  size_t len = 0;
  napi_typedarray_type type;
  napi_value ab;
  size_t off = 0;
  if (napi_get_typedarray_info(env, argv[0], &type, &len, &data, &ab, &off) !=
          napi_ok ||
      !data) {
    napi_throw_type_error(
        env, nullptr, "readPlaintext: expected a Buffer or Uint8Array");
    return nullptr;
  }

  ERR_clear_error();
  int n = SSL_read(eng->ssl, data, static_cast<int>(len));
  if (n > 0) {
    setFields(n, kOk);
    return result;
  }
  setFields(0, classify(eng, n));
  return result;
}

/// shutdown() -> status. Sends close_notify.
napi_value engineShutdown(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);
  if (!eng)
    return makeInt(env, kError);
  ERR_clear_error();
  int ret = SSL_shutdown(eng->ssl);
  if (ret >= 0)
    return makeInt(env, kOk);
  return makeInt(env, classify(eng, ret));
}

/// isHandshakeComplete() -> boolean
napi_value engineIsHandshakeComplete(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);
  napi_value out;
  napi_get_boolean(env, eng && eng->handshakeDone, &out);
  return out;
}

/// lastError() -> string | undefined
napi_value engineLastError(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);
  if (!eng || eng->lastError.empty()) {
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
  }
  napi_value out;
  napi_create_string_utf8(
      env, eng->lastError.c_str(), NAPI_AUTO_LENGTH, &out);
  return out;
}

/// verifyError() -> string | undefined
/// The certificate chain verification result, which is separate from whether
/// the handshake itself succeeded.
napi_value engineVerifyError(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);

  napi_value undef;
  napi_get_undefined(env, &undef);
  if (!eng)
    return undef;

  long res = SSL_get_verify_result(eng->ssl);
  if (res == X509_V_OK) {
    // A chain that verifies but was never presented is still a failure for a
    // client that asked for verification.
    X509 *peer = SSL_get1_peer_certificate(eng->ssl);
    if (!peer) {
      napi_value out;
      napi_create_string_utf8(
          env, "no certificate presented by peer", NAPI_AUTO_LENGTH, &out);
      return out;
    }
    X509_free(peer);
    return undef;
  }

  const char *reason = X509_verify_cert_error_string(res);
  napi_value out;
  napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &out);
  return out;
}

/// getProtocol() -> string | undefined
napi_value engineGetProtocol(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);
  if (!eng || !eng->handshakeDone) {
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
  }
  const char *ver = SSL_get_version(eng->ssl);
  napi_value out;
  napi_create_string_utf8(env, ver ? ver : "", NAPI_AUTO_LENGTH, &out);
  return out;
}

/// getCipher() -> { name, version } | undefined
napi_value engineGetCipher(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);
  napi_value undef;
  napi_get_undefined(env, &undef);
  if (!eng || !eng->handshakeDone)
    return undef;

  const SSL_CIPHER *c = SSL_get_current_cipher(eng->ssl);
  if (!c)
    return undef;

  napi_value out, name, version;
  napi_create_object(env, &out);
  napi_create_string_utf8(
      env, SSL_CIPHER_get_name(c), NAPI_AUTO_LENGTH, &name);
  napi_create_string_utf8(
      env, SSL_CIPHER_get_version(c), NAPI_AUTO_LENGTH, &version);
  napi_set_named_property(env, out, "name", name);
  napi_set_named_property(env, out, "version", version);
  return out;
}

/// getPeerCertificate() -> { subject, issuer, valid_from, valid_to, raw } | undefined
napi_value engineGetPeerCertificate(napi_env env, napi_callback_info info) {
  napi_value thisVal;
  napi_get_cb_info(env, info, nullptr, nullptr, &thisVal, nullptr);
  Engine *eng = unwrapEngine(env, thisVal);
  napi_value undef;
  napi_get_undefined(env, &undef);
  if (!eng)
    return undef;

  X509 *peer = SSL_get1_peer_certificate(eng->ssl);
  if (!peer)
    return undef;

  napi_value out;
  napi_create_object(env, &out);

  auto addName = [&](const char *field, X509_NAME *nm) {
    if (!nm)
      return;
    char buf[512];
    X509_NAME_oneline(nm, buf, sizeof(buf));
    napi_value v;
    napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, out, field, v);
  };
  addName("subject", X509_get_subject_name(peer));
  addName("issuer", X509_get_issuer_name(peer));

  auto addTime = [&](const char *field, const ASN1_TIME *t) {
    if (!t)
      return;
    BIO *bio = BIO_new(BIO_s_mem());
    if (!bio)
      return;
    if (ASN1_TIME_print(bio, t)) {
      char *p = nullptr;
      long n = BIO_get_mem_data(bio, &p);
      if (p && n > 0) {
        napi_value v;
        napi_create_string_utf8(env, p, static_cast<size_t>(n), &v);
        napi_set_named_property(env, out, field, v);
      }
    }
    BIO_free(bio);
  };
  addTime("valid_from", X509_get0_notBefore(peer));
  addTime("valid_to", X509_get0_notAfter(peer));

  // DER bytes, so callers can do their own checks (pinning, fingerprints).
  unsigned char *der = nullptr;
  int derLen = i2d_X509(peer, &der);
  if (derLen > 0 && der) {
    void *copy = nullptr;
    napi_value buf;
    if (napi_create_buffer(env, static_cast<size_t>(derLen), &copy, &buf) ==
        napi_ok) {
      std::memcpy(copy, der, static_cast<size_t>(derLen));
      napi_set_named_property(env, out, "raw", buf);
    }
    OPENSSL_free(der);
  }

  X509_free(peer);
  return out;
}

} // namespace

napi_value initTlsBinding(napi_env env, napi_value exports) {
  ensureOpenSSLInit();

  const napi_property_attributes kMethod = static_cast<napi_property_attributes>(
      napi_enumerable | napi_writable | napi_configurable);

  napi_property_descriptor props[] = {
      {"handshake", nullptr, engineHandshake, nullptr, nullptr, nullptr,
       kMethod, nullptr},
      {"writeCiphertext", nullptr, engineWriteCiphertext, nullptr, nullptr,
       nullptr, kMethod, nullptr},
      {"readCiphertext", nullptr, engineReadCiphertext, nullptr, nullptr,
       nullptr, kMethod, nullptr},
      {"writePlaintext", nullptr, engineWritePlaintext, nullptr, nullptr,
       nullptr, kMethod, nullptr},
      {"readPlaintext", nullptr, engineReadPlaintext, nullptr, nullptr,
       nullptr, kMethod, nullptr},
      {"shutdown", nullptr, engineShutdown, nullptr, nullptr, nullptr, kMethod,
       nullptr},
      {"isHandshakeComplete", nullptr, engineIsHandshakeComplete, nullptr,
       nullptr, nullptr, kMethod, nullptr},
      {"lastError", nullptr, engineLastError, nullptr, nullptr, nullptr,
       kMethod, nullptr},
      {"verifyError", nullptr, engineVerifyError, nullptr, nullptr, nullptr,
       kMethod, nullptr},
      {"getProtocol", nullptr, engineGetProtocol, nullptr, nullptr, nullptr,
       kMethod, nullptr},
      {"getCipher", nullptr, engineGetCipher, nullptr, nullptr, nullptr,
       kMethod, nullptr},
      {"getPeerCertificate", nullptr, engineGetPeerCertificate, nullptr,
       nullptr, nullptr, kMethod, nullptr},
  };

  napi_value ctor;
  napi_define_class(
      env,
      "TlsEngine",
      NAPI_AUTO_LENGTH,
      engineNew,
      nullptr,
      sizeof(props) / sizeof(props[0]),
      props,
      &ctor);
  napi_set_named_property(env, exports, "TlsEngine", ctor);

  // Status constants, mirrored in libjs/shims/tls.js.
  napi_value status;
  napi_create_object(env, &status);
  napi_set_named_property(env, status, "OK", makeInt(env, kOk));
  napi_set_named_property(env, status, "WANT_READ", makeInt(env, kWantRead));
  napi_set_named_property(env, status, "CLOSED", makeInt(env, kClosed));
  napi_set_named_property(env, status, "ERROR", makeInt(env, kError));
  napi_set_named_property(env, exports, "status", status);

  return exports;
}

} // namespace node_compat
} // namespace hermes

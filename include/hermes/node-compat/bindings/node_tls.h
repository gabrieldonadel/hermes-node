/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#ifndef HERMES_NODE_COMPAT_BINDINGS_NODE_TLS_H
#define HERMES_NODE_COMPAT_BINDINGS_NODE_TLS_H

#include <node_api_types.h>

namespace hermes {
namespace node_compat {

/// Init function for the 'tls' binding.
///
/// Exposes a TLS engine built on OpenSSL memory BIOs: it performs the
/// handshake and record crypto but does no I/O of its own. Callers push
/// ciphertext in, pull ciphertext out, and read/write plaintext; moving bytes
/// to and from a socket is the JS side's job.
///
/// This differs from Node, which implements TLS as a native TLSWrap that is
/// simultaneously a StreamBase and a StreamListener on its parent stream.
/// hermes-node has no such abstraction -- LibuvStreamBase is bound to a real
/// uv_stream_t -- so a faithful TLSWrap port would first require introducing
/// Node's whole stream-listener layer and moving the TCP, pipe and TTY wraps
/// onto it.
///
/// Keeping the engine I/O-free also makes `tls.connect({ socket })` fall out
/// for free: anything that can hand over bytes works, including a plain JS
/// Duplex. That path matters here because eas-shared upgrades an existing
/// usbmux socket to TLS when talking to a physical iOS device.
napi_value initTlsBinding(napi_env env, napi_value exports);

} // namespace node_compat
} // namespace hermes

#endif // HERMES_NODE_COMPAT_BINDINGS_NODE_TLS_H

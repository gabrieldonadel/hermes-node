/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <hermes/node-compat/runtime/hermes_node_instance.h>

#include <memory>

namespace hermes {
namespace node_compat {

/// What the embedding host (e.g. React Native) provides.
struct HermesNodeEmbedderHost {
  /// Run \p fn(\p arg) on the runtime's JS thread, after whatever it is
  /// currently doing. Called from a background thread; must be thread-safe.
  /// If the host can no longer run tasks (e.g. it is tearing down), it may
  /// drop the call.
  void (*postToJSThread)(void *data, void (*fn)(void *arg), void *arg) =
      nullptr;
  void *data = nullptr;
};

/// Runs Node (bindings, module loader, libuv) inside a runtime whose thread
/// and event loop belong to someone else.
///
/// The host keeps its own run loop. A background thread waits on libuv's
/// backend fd (and on timers / pending nextTicks); whenever libuv has work,
/// it posts a task to the JS thread that runs one non-blocking libuv
/// iteration and drains nextTick + microtasks. This is the approach Electron
/// uses to run Node inside Chromium.
///
/// Node's globals are left alone unless requested (see
/// HermesNodeInstanceConfig::installGlobals), except `process` and, when the
/// host has none, `Buffer`, which Node's own JS and most npm packages assume.
/// JS reaches Node through the function installed by installRequire().
///
/// attach() and detach() must be called on the JS thread.
class HermesNodeEmbedder {
 public:
  ~HermesNodeEmbedder();

  HermesNodeEmbedder(const HermesNodeEmbedder &) = delete;
  HermesNodeEmbedder &operator=(const HermesNodeEmbedder &) = delete;

  /// Bootstrap Node onto \p runtime and start the loop bridge. Returns
  /// nullptr on failure (details are printed to stderr).
  static std::unique_ptr<HermesNodeEmbedder> attach(
      facebook::jsi::Runtime &runtime,
      const HermesNodeInstanceConfig &config,
      const HermesNodeEmbedderHost &host);

  /// Install `globalThis[globalName] = (id) => require(id)`.
  napi_status installRequire(const char *globalName);

  HermesNodeInstance &instance();

  /// Stop the loop bridge and shut Node down: emits process 'exit', closes
  /// handles and the libuv loop. Must run before the host destroys the
  /// runtime. The embedder object itself must outlive the runtime, because
  /// the runtime's GC finalizers can still reach per-runtime binding state.
  void detach();

  /// Wake the loop bridge, e.g. after the host called into Node outside a
  /// loop iteration. Thread-safe. Optional: the bridge also re-checks libuv
  /// periodically.
  void wakeup();

  /// Implementation detail; public only so file-local helpers can name it.
  struct Bridge;

 private:
  HermesNodeEmbedder();

  std::unique_ptr<HermesNodeInstance> instance_;
  std::shared_ptr<Bridge> bridge_;
  bool detached_ = false;
};

} // namespace node_compat
} // namespace hermes

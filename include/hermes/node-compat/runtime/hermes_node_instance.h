/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <node_api.h>
#include <uv.h>

#include <memory>
#include <string>
#include <vector>

namespace facebook {
namespace hermes {
class HermesRuntime;
} // namespace hermes
} // namespace facebook

namespace hermes {
namespace node_compat {

struct RuntimeState;

/// Configuration for bootstrapping the Node environment onto a runtime.
struct HermesNodeInstanceConfig {
  /// process.argv values. First element should be the binary name.
  std::vector<std::string> argv;

  /// Override process.version. Empty = use default.
  std::string nodeVersion;

  /// Override process.execPath. Empty = uv_exepath().
  std::string execPath;

  /// Install Node's globals (console, process, timers, Buffer, URL,
  /// URLSearchParams) on globalThis. A standalone runtime wants this; an
  /// embedder that already has its own globals (e.g. React Native) does not,
  /// and gets everything through require() instead.
  bool installGlobals = true;

  /// Set up process.stdin/stdout/stderr on top of the real file descriptors.
  bool setupStdio = true;
};

/// A Node environment (napi_env, bindings, module loader, libuv loop)
/// attached to a Hermes runtime that is owned by someone else.
///
/// Lifecycle:
///   create() -> bootstrap() -> [require()/runOnce()/drainTicks()]* ->
///   emitExit() -> closeStdio() -> beginShutdown() -> finishShutdown() ->
///   destroyEnv()
///
/// All methods must be called on the runtime's JS thread.
class HermesNodeInstance {
 public:
  ~HermesNodeInstance();

  HermesNodeInstance(const HermesNodeInstance &) = delete;
  HermesNodeInstance &operator=(const HermesNodeInstance &) = delete;

  /// Create the event loop and the napi_env for \p runtime. The runtime must
  /// have been created with the microtask queue enabled and must outlive the
  /// instance's env (see destroyEnv()). Returns nullptr on failure.
  static std::unique_ptr<HermesNodeInstance> create(
      facebook::hermes::HermesRuntime &runtime);

  /// Load primordials, process, the module loader, timers etc. Returns false
  /// on failure; the pending JS exception (if any) has been printed.
  bool bootstrap(const HermesNodeInstanceConfig &config);

  napi_env env() const;
  uv_loop_t *loop() const;
  facebook::hermes::HermesRuntime &runtime() const;

  /// Per-runtime binding state. Valid until the instance is destroyed.
  RuntimeState *runtimeState() const;

  /// require() a module through Node's module loader (builtins and, once
  /// CJS is initialized, files and node_modules).
  napi_status require(const char *id, napi_value *result);

  /// Create a JS function `(id) => require(id)` bound to this instance.
  napi_status createRequireFunction(napi_value *result);

  /// Drain Hermes microtasks and Node's nextTick queue.
  void drainTicks();

  /// Run one non-blocking iteration of the libuv loop, then drain ticks.
  void runOnce();

  /// True when Node has nextTick callbacks queued (readable from any thread).
  bool hasTickScheduled() const;

  /// Emit process 'exit'. Folds in process.exitCode (before and after the
  /// event, like Node) and returns the resulting exit code.
  int emitExit(int exitCode);

  /// Close process.stdin/stdout/stderr handles.
  void closeStdio();

  /// First half of shutdown: close timers and tick handles. Embedders that
  /// run extra threads on the loop (e.g. the inspector) stop them after this.
  void beginShutdown();

  /// Second half of shutdown: close c-ares, the libuv loop, and detach the
  /// loader, process and bindings from the env.
  void finishShutdown();

  /// Destroy the napi_env. The runtime may be destroyed afterwards. The
  /// per-runtime binding state is intentionally kept alive until the
  /// instance is destroyed, because GC finalizers that run during runtime
  /// destruction can still reach it.
  void destroyEnv();

  /// Implementation detail; public only so file-local libuv callbacks can
  /// name it.
  struct Impl;

 private:
  HermesNodeInstance();

  std::unique_ptr<Impl> impl_;
};

/// Print a pending JS exception to stderr and clear it.
void printAndClearException(napi_env env);

} // namespace node_compat
} // namespace hermes

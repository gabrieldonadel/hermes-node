/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <hermes/node-compat/runtime/hermes_node_runtime.h>

#include "napi/hermes_napi.h"

#include "hermes/Public/RuntimeConfig.h"
#include "hermes/hermes.h"

#ifdef HERMES_ENABLE_DEBUGGER
#include <hermes/RuntimeTaskRunner.h>
#include <hermes/cdp/CDPAgent.h>
#include <hermes/cdp/CDPDebugAPI.h>

#include <atomic>
#include <mutex>
#include <queue>
#include <thread>
#endif

#include <hermes/node-compat/bindings/node_contextify.h>
#include <hermes/node-compat/bundle/bundle_build.h>
#include <hermes/node-compat/bundle/bundle_run.h>
#include <hermes/node-compat/compile-cache/compile_cache.h>
#include <hermes/node-compat/embedded-modules/embedded_modules.h>
#include <hermes/node-compat/event-loop/uv_event_loop.h>
#include <hermes/node-compat/inspector/inspector_bridge.h>
#include <hermes/node-compat/process/node_process.h>
#include <hermes/node-compat/runtime/hermes_node_instance.h>
#include <hermes/node-compat/runtime/runtime_state.h>
#include <hermes/node-compat/version.h>
#include <hermes/node-compat/vm-options/vm_options.h>

#include <hermes/BCGen/HBC/BytecodeVersion.h>
#include <uv.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#ifdef HERMES_ENABLE_DEBUGGER
#include <spawn.h>
#include <sys/wait.h>
#include <climits>
#include <cstdlib>
extern char **environ;
#endif

using namespace hermes::node_compat;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#ifdef HERMES_ENABLE_DEBUGGER
/// Spawn the platform browser-opener (open on macOS, xdg-open on Linux)
/// to open \p url. Best-effort: failures are reported on stderr but do not
/// abort the parent. The DevTools URL printed above is still usable.
static void openDevToolsUrl(const char *url) {
#if defined(__APPLE__)
  const char *opener = "/usr/bin/open";
#elif defined(__linux__)
  const char *opener = "/usr/bin/xdg-open";
#else
  std::fprintf(stderr, "--inspect-open: unsupported platform\n");
  return;
#endif
  char *const argv[] = {
      const_cast<char *>(opener), const_cast<char *>(url), nullptr};
  pid_t pid = 0;
  int rc = posix_spawn(&pid, opener, nullptr, nullptr, argv, environ);
  if (rc != 0) {
    std::fprintf(
        stderr,
        "--inspect-open: posix_spawn(%s) failed: %s\n",
        opener,
        std::strerror(rc));
    return;
  }
  // Reap the child so it doesn't become a zombie. The opener returns
  // immediately after handing off to the browser.
  int status = 0;
  waitpid(pid, &status, 0);
}
#endif

// ---------------------------------------------------------------------------
// Inspector state for CDP debugging (cross-thread communication)
// ---------------------------------------------------------------------------

#ifdef HERMES_ENABLE_DEBUGGER

/// Main-thread state for cross-thread CDP communication. Holds mutex-protected
/// queues for inbound CDP commands and RuntimeTasks, plus a uv_async_t handle
/// that signals the main event loop to drain them.
struct InspectorState {
  std::mutex mutex;
  std::queue<std::string> inboundCommands;
  std::queue<facebook::hermes::debugger::RuntimeTask> runtimeTasks;
  uv_async_t asyncHandle{};
  facebook::hermes::cdp::CDPAgent *agent = nullptr;
  facebook::hermes::HermesRuntime *hermesRT = nullptr;
  /// Set to false before closing the async handle to prevent uv_async_send
  /// calls on a closed handle (e.g. during CDPAgent destruction).
  std::atomic<bool> asyncActive{false};
};

/// uv_async_t callback: drain inbound CDP commands and runtime tasks.
static void onInspectorAsync(uv_async_t *handle) {
  auto *state = static_cast<InspectorState *>(handle->data);

  // Swap queues under lock to minimize lock hold time.
  std::queue<std::string> commands;
  std::queue<facebook::hermes::debugger::RuntimeTask> tasks;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    commands.swap(state->inboundCommands);
    tasks.swap(state->runtimeTasks);
  }

  // Process inbound CDP commands.
  while (!commands.empty()) {
    if (state->agent) {
      state->agent->handleCommand(commands.front());
    }
    commands.pop();
  }

  // Execute runtime tasks.
  while (!tasks.empty()) {
    if (state->hermesRT) {
      tasks.front()(*state->hermesRT);
    }
    tasks.pop();
  }
}

/// Generate a UUID-like session ID for the inspector WebSocket path.
static std::string generateSessionId() {
  unsigned char bytes[16];
  int err = uv_random(nullptr, nullptr, bytes, sizeof(bytes), 0, nullptr);
  if (err != 0) {
    // Fallback: use high-res timer + process ID.
    uint64_t t = uv_hrtime();
    uint32_t pid = uv_os_getpid();
    std::memcpy(bytes, &t, sizeof(t));
    std::memcpy(bytes + sizeof(t), &pid, sizeof(pid));
    std::memset(
        bytes + sizeof(t) + sizeof(pid),
        0,
        sizeof(bytes) - sizeof(t) - sizeof(pid));
  }
  char buf[37];
  std::snprintf(
      buf,
      sizeof(buf),
      "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
      bytes[0],
      bytes[1],
      bytes[2],
      bytes[3],
      bytes[4],
      bytes[5],
      bytes[6],
      bytes[7],
      bytes[8],
      bytes[9],
      bytes[10],
      bytes[11],
      bytes[12],
      bytes[13],
      bytes[14],
      bytes[15]);
  return buf;
}

#endif // HERMES_ENABLE_DEBUGGER

// ---------------------------------------------------------------------------
// runHermesNode
// ---------------------------------------------------------------------------

namespace hermes {
namespace node_compat {

namespace {

/// Build and enable the compile cache for this runtime, or return nullptr.
///
/// Disabled under --inspect / --inspect-brk: cached bytecode is compiled by
/// hermes_compile_to_bytecode, which has no debug flag and always produces
/// DebugInfoSetting::THROWING, while napi_run_script compiles at
/// DebugInfoSetting::ALL under HERMES_ENABLE_DEBUGGER. Bypassing here rather
/// than at each compile site keeps debugger behaviour unchanged by
/// construction.
/// Whether compiles should run the optimization pipeline.
///
/// kDefault ties it to whether the result is kept: optimizing costs compile
/// time and buys execution speed, so with a cache it is paid once and repaid
/// on every later run, while without one it would be paid on every run and
/// thrown away. hermes_run_script, the uncached path, is tuned for low
/// start-up latency, so leaving it unoptimized is the point rather than a
/// limitation.
bool resolveOptimize(const HermesNodeConfig &config, bool cacheActive) {
  switch (config.process.optimize) {
    case OptimizeMode::kOff:
      return false;
    case OptimizeMode::kOn:
      return true;
    case OptimizeMode::kDefault:
      return cacheActive;
  }
  return cacheActive;
}

CompileCache *createCompileCache(const HermesNodeConfig &config) {
  // The inspector's own runtime never caches, whatever its config says. It
  // only evaluates require('inspector-server'), which is embedded in the
  // binary as precompiled bytecode, so it has nothing to compile and nothing
  // to gain -- but it does inherit the process-wide cache settings, so
  // without this it would create a directory (and prune generations) at
  // whatever root the user selected. Keying on what the runtime IS, rather
  // than on a flag its construction site must remember to set, is what keeps
  // this correct as HermesNodeProcessConfig grows.
  if (config.inspectorBridgeContext != nullptr)
    return nullptr;

  if (config.process.disableCompileCache || config.inspect || config.inspectBrk)
    return nullptr;
  if (const char *off = ::getenv("HERMES_NODE_DISABLE_COMPILE_CACHE")) {
    if (off[0] != '\0' && std::strcmp(off, "0") != 0)
      return nullptr;
  }

  std::string root = config.process.compileCacheDir;
  if (root.empty()) {
    if (const char *fromEnv = ::getenv("HERMES_NODE_COMPILE_CACHE"))
      root = fromEnv;
  }
  if (root.empty())
    root = compileCacheDefaultRoot();
  if (root.empty())
    return nullptr;

  // Everything that invalidates every entry at once goes in the generation
  // name: the wrapper text applied natively, and the compile flags.
  //
  // The optimization setting is a compile flag in the strongest sense -- it
  // changes the bytecode produced from identical source -- so it must be in
  // here. Without it, a run with --optimize=off would serve optimized entries
  // written by an earlier default run, and vice versa, from the same keys.
  uint32_t configCrc =
      compileCacheCrc32(kCJSWrapperPrefix, sizeof(kCJSWrapperPrefix) - 1);
  {
    // Resolved against cacheActive=true: reaching here means a cache is being
    // created, which is exactly the condition kDefault keys on.
    const char optimizeByte =
        resolveOptimize(config, /*cacheActive*/ true) ? 'O' : 'o';
    configCrc = compileCacheCrc32(&optimizeByte, 1) ^ configCrc;
  }

  auto cache = std::make_unique<CompileCache>();
  if (!cache->enable(
          root,
          compileCacheGenerationName(
              HERMES_NODE_VERSION_STRING,
              HERMES_NODE_CACHE_ARCH,
              hermes::hbc::BYTECODE_VERSION,
              configCrc))) {
    return nullptr;
  }

  if (const char *dbg = ::getenv("HERMES_NODE_DEBUG_NATIVE"))
    cache->setTracing(std::strstr(dbg, "COMPILE_CACHE") != nullptr);

  return cache.release();
}

/// The half of bundle consumer mode that follows a successful open: install
/// the bundle-aware Module._load wrapper and run the bundle's entry module.
/// Returns the process exit code. Shared by the two ways a container
/// arrives -- mapped from a file, or linked into this executable -- so they
/// cannot diverge on how the bundle is run.
int runOpenBundle(napi_env env, HermesNodeInstance &node) {
  napi_value bundleObject;
  if (installBundleGlobals(env, &bundleObject) != napi_ok) {
    std::fprintf(stderr, "Error: failed to install the bundle natives\n");
    printAndClearException(env);
    return 1;
  }

  // Node's CJS loader is what the wrapper hooks -- user code and everything
  // under node_modules goes through it, so hooking it covers resolution and
  // file reading at once. `path` turns the bundle root and a module identity
  // into the __filename / __dirname a bundled module sees. `fs` is for
  // exactly one question -- whether a native addon's sidecar file exists --
  // so a missing one is reported as our own MODULE_NOT_FOUND rather than as
  // an ERR_DLOPEN_FAILED that misdescribes the problem.
  napi_value cjsLoader;
  napi_value pathModule;
  napi_value fsModule;
  if (node.require("internal/modules/cjs/loader", &cjsLoader) != napi_ok ||
      node.require("path", &pathModule) != napi_ok ||
      node.require("fs", &fsModule) != napi_ok) {
    std::fprintf(stderr, "Error: failed to load the CommonJS loader\n");
    printAndClearException(env);
    return 1;
  }
  napi_value moduleCtor;
  napi_get_named_property(env, cjsLoader, "Module", &moduleCtor);

  napi_value installFn;
  if (runEmbeddedModule(env, "bundle-loader", &installFn) != napi_ok) {
    std::fprintf(stderr, "Error: failed to execute bundle-loader\n");
    printAndClearException(env);
    return 1;
  }

  napi_value global;
  napi_get_global(env, &global);

  // installBundleLoader(Module, bundle, path, fs) -> run()
  napi_value installArgs[4] = {moduleCtor, bundleObject, pathModule, fsModule};
  napi_value runFn;
  if (napi_call_function(env, global, installFn, 4, installArgs, &runFn) !=
      napi_ok) {
    printAndClearException(env);
    return 1;
  }

  napi_value result;
  if (napi_call_function(env, global, runFn, 0, nullptr, &result) != napi_ok) {
    printAndClearException(env);
    return 1;
  }
  return 0;
}

/// Bundle consumer mode: map the container, install the bundle-aware
/// Module._load wrapper, and run the bundle's entry module. Returns the
/// process exit code.
///
/// Every failure before user code starts is fatal and reported here rather
/// than falling back to running something else. A bundle is a deliverable:
/// if it cannot be mapped, does not validate, or was built by a different
/// hermes-node, silently recompiling from a source tree that may not even
/// be present is worse than refusing to start.
int runBundle(
    napi_env env,
    HermesNodeInstance &node,
    const std::string &path) {
  std::string error;
  if (!openBundle(path, &error)) {
    std::fprintf(stderr, "error: %s\n", error.c_str());
    return 1;
  }
  return runOpenBundle(env, node);
}

/// The same, for a bundle that arrived as a section of this executable.
/// uv_exepath rather than argv[0]: argv[0] is whatever the caller chose and
/// need not be a path at all, and the root decides where sidecars are found.
int runEmbeddedBundle(
    napi_env env,
    HermesNodeInstance &node,
    const uint8_t *data,
    size_t size) {
  char exePath[4096];
  size_t len = sizeof(exePath);
  if (uv_exepath(exePath, &len) != 0) {
    std::fprintf(stderr, "Error: cannot determine the executable path\n");
    return 1;
  }
  std::string error;
  if (!openEmbeddedBundle(data, size, std::string(exePath, len), &error)) {
    std::fprintf(stderr, "error: %s\n", error.c_str());
    return 1;
  }
  return runOpenBundle(env, node);
}

} // namespace

int runHermesNode(const HermesNodeConfig &config) {
  // 1. Create the Hermes runtime. The configuration comes from
  //    --vm= / a container's baked options / HERMES_NODE_VM_OPTIONS,
  //    already resolved into one ordered list by the caller. With no
  //    options at all this produces exactly what the hardcoded
  //    Builder() call it replaced produced: microtask queue, async
  //    generators and ES6 block scoping on.
  //
  //    Parsed under call_once so that the inspector runtime -- a second
  //    runHermesNode() call in the same process -- is configured from the
  //    identical result rather than from a second parse of the same list.
  //    A debugger attached to a differently-configured VM would mislead in
  //    a way that is hard to notice, and re-deriving a config that cannot
  //    differ is work with only a downside. (buildVmRuntimeConfig is
  //    itself safe to call twice; this is about agreement, not safety.)
  //
  //    In bundle producer mode (config.buildBundlePath), --vm= is recorded
  //    into the container below rather than applied here: the producer
  //    compiles rather than runs, and a build machine's VM tuning is not
  //    the artifact's business. Applying it to this runtime as well would
  //    make an ordinary tuning flag like -Xes6-proxy=false break the build
  //    itself, since libjs/primordials.js runs on this same runtime before
  //    step 13 ever reaches buildBundle().
  static std::once_flag vmConfigOnce;
  static hermes::vm::RuntimeConfig vmRuntimeConfig;
  static std::string vmConfigError;
  std::call_once(vmConfigOnce, [&config]() {
    static const std::vector<std::string> kNoVmOptions;
    const std::vector<std::string> &effectiveVmOptions =
        config.buildBundlePath.empty() ? config.process.vmOptions
                                       : kNoVmOptions;
    if (!buildVmRuntimeConfig(
            effectiveVmOptions, &vmRuntimeConfig, &vmConfigError))
      // Neutral prefix, not "--vm:": the options may have come from a
      // container's baked list or from HERMES_NODE_VM_OPTIONS, and in a
      // --build-exe artifact there is no --vm flag at all to point at.
      vmConfigError = "Error: VM options: " + vmConfigError;
  });
  if (!vmConfigError.empty()) {
    std::fprintf(stderr, "%s\n", vmConfigError.c_str());
    return 1;
  }
  auto hermesRT = facebook::hermes::makeHermesRuntime(vmRuntimeConfig);

  // 2-3. Create the event loop and the napi_env.
  auto instance = HermesNodeInstance::create(*hermesRT);
  if (!instance)
    return 1;
  napi_env env = instance->env();

  // process.exit() bypasses everything below and calls _exit(), which
  // discards queued stdio writes. Give it the loop so it can flush first.
  setProcessExitLoop(instance->loop());

  // The compile cache is deleted by ~HermesNodeInstance(), after the runtime
  // is gone: bytecode mapped from it is released by GC finalizers.
  RuntimeState *runtimeState = instance->runtimeState();
  runtimeState->inspectorBridgeContext = config.inspectorBridgeContext;
  runtimeState->compileCache = createCompileCache(config);
  runtimeState->optimizeCompiles =
      resolveOptimize(config, runtimeState->compileCache != nullptr);

  // Create CDP objects and inspector async handle for debugger support.
#ifdef HERMES_ENABLE_DEBUGGER
  std::unique_ptr<facebook::hermes::cdp::CDPDebugAPI> cdpDebugAPI;
  std::unique_ptr<facebook::hermes::cdp::CDPAgent> cdpAgent;
  InspectorState inspectorState;
  bool inspectorAsyncActive = false;
  std::thread inspectorThread;
  InspectorBridgeContext *bridgeCtx = nullptr;
  if (config.inspect) {
    cdpDebugAPI = facebook::hermes::cdp::CDPDebugAPI::create(*hermesRT);

    // Initialize the async handle for cross-thread CDP signaling.
    uv_async_init(
        instance->loop(), &inspectorState.asyncHandle, onInspectorAsync);
    inspectorState.asyncHandle.data = &inspectorState;
    uv_unref(reinterpret_cast<uv_handle_t *>(&inspectorState.asyncHandle));
    inspectorState.asyncActive.store(true, std::memory_order_release);
    inspectorAsyncActive = true;

    // Allocate the bridge context before CDPAgent so the outbound
    // messageCallback can capture it.
    std::string sessionId = generateSessionId();
    bridgeCtx = new InspectorBridgeContext();
    bridgeCtx->host = config.inspectHost;
    bridgeCtx->port = config.inspectPort;
    bridgeCtx->scriptName = config.scriptPath;
    bridgeCtx->sessionId = sessionId;

    // Wire up inbound (inspector -> main) pointers.
    bridgeCtx->inboundMutex = &inspectorState.mutex;
    bridgeCtx->inboundQueue = &inspectorState.inboundCommands;
    bridgeCtx->mainAsync = &inspectorState.asyncHandle;
    bridgeCtx->mainAsyncActive = &inspectorState.asyncActive;

    cdpAgent = facebook::hermes::cdp::CDPAgent::create(
        /*executionContextID=*/
        1,
        *cdpDebugAPI,
        /*enqueueRuntimeTask=*/
        [&inspectorState](facebook::hermes::debugger::RuntimeTask task) {
          {
            std::lock_guard<std::mutex> lock(inspectorState.mutex);
            inspectorState.runtimeTasks.push(std::move(task));
          }
          if (inspectorState.asyncActive.load(std::memory_order_acquire)) {
            uv_async_send(&inspectorState.asyncHandle);
          }
        },
        /*messageCallback=*/
        [bridgeCtx](const std::string &msg) {
          {
            std::lock_guard<std::mutex> lock(bridgeCtx->outboundMutex);
            bridgeCtx->outboundQueue.push(msg);
          }
          if (bridgeCtx->inspectorAsyncActive.load(std::memory_order_acquire)) {
            uv_async_send(&bridgeCtx->inspectorAsync);
          }
        });

    inspectorState.agent = cdpAgent.get();
    inspectorState.hermesRT = hermesRT.get();
    cdpAgent->enableRuntimeDomain();
    if (config.inspectBrk) {
      // Pre-enable the debugger domain so its event callback is registered
      // before user code. The task fires during the first JS execution
      // (primordials), setting pauseOnScriptLoad=true and registering the
      // coordinator's event callback. This is required for the
      // coordinator().pause() call in step 12b below to actually pause the VM.
      cdpAgent->enableDebuggerDomain();
    }

    // Set up the interrupt-based drain for inbound CDP commands. When the
    // runtime is paused at a breakpoint, the event loop is not running, so
    // uv_async_send alone cannot deliver commands. This function triggers a
    // runtime interrupt that drains the inbound queue and calls handleCommand.
    bridgeCtx->triggerInboundDrain = [&inspectorState, &cdpDebugAPI]() {
      cdpDebugAPI->asyncDebuggerAPI().triggerInterrupt_TS(
          [&inspectorState](facebook::hermes::HermesRuntime &) {
            std::queue<std::string> commands;
            {
              std::lock_guard<std::mutex> lock(inspectorState.mutex);
              commands.swap(inspectorState.inboundCommands);
            }
            while (!commands.empty()) {
              if (inspectorState.agent) {
                inspectorState.agent->handleCommand(commands.front());
              }
              commands.pop();
            }
          });
    };

    // Build inspector config and launch the inspector thread.
    //
    // Process-wide settings are inherited wholesale; everything else is left
    // default-constructed on purpose. See HermesNodeProcessConfig for why the
    // two groups are separated -- in short, copying this config outright
    // would run the user's script a second time on this thread, re-run every
    // -r preload, and start a recursive inspector.
    HermesNodeConfig inspectorConfig;
    inspectorConfig.process = config.process;
    inspectorConfig.evalCode = "require('inspector-server');";
    inspectorConfig.argv = {"hermes-node-inspector"};
    inspectorConfig.inspectorBridgeContext = bridgeCtx;

    inspectorThread = std::thread([bridgeCtx, inspectorConfig]() {
      runHermesNode(inspectorConfig);
      // Ensure the main thread's readyCv wait doesn't hang if the inspector
      // failed to start (notifyReady was never called).
      {
        std::lock_guard<std::mutex> lock(bridgeCtx->readyMutex);
        bridgeCtx->ready = true;
      }
      bridgeCtx->readyCv.notify_one();
    });

    // Wait for the inspector server to signal it's listening.
    {
      std::unique_lock<std::mutex> lock(bridgeCtx->readyMutex);
      bridgeCtx->readyCv.wait(lock, [&] { return bridgeCtx->ready; });
    }

    if (bridgeCtx->actualPort > 0) {
      std::fprintf(
          stderr,
          "Debugger listening on ws://%s:%d/%s\n",
          bridgeCtx->host.c_str(),
          bridgeCtx->actualPort,
          bridgeCtx->sessionId.c_str());
      std::fprintf(
          stderr, "For help, see: https://nodejs.org/en/docs/inspector\n");
      char devtoolsUrl[1024];
      std::snprintf(
          devtoolsUrl,
          sizeof(devtoolsUrl),
          "http://%s:%d/devtools/inspector.html?ws=%s:%d/%s",
          bridgeCtx->host.c_str(),
          bridgeCtx->actualPort,
          bridgeCtx->host.c_str(),
          bridgeCtx->actualPort,
          bridgeCtx->sessionId.c_str());
      std::fprintf(stderr, "Open DevTools: %s\n", devtoolsUrl);
      if (config.inspectOpen) {
        openDevToolsUrl(devtoolsUrl);
      }
    } else {
      std::fprintf(stderr, "Warning: inspector failed to start\n");
    }
  }
#endif

  // 4-12. Bootstrap the Node environment: console, bindings, primordials,
  // process, module loader, nextTick, timers, globals, stdio, CJS loader,
  // tick-draining loop handles.
  HermesNodeInstanceConfig instanceConfig;
  instanceConfig.argv = config.argv;
  instanceConfig.nodeVersion = config.process.nodeVersion;
  int exitCode = instance->bootstrap(instanceConfig) ? 0 : 1;

  napi_handle_scope scope;
  napi_open_handle_scope(env, &scope);
  napi_value global;
  napi_get_global(env, &global);

  // 12b. For --inspect-brk, register a CDP breakpoint at the user file's
  // first user statement so the runtime pauses there once the script is
  // parsed and execution enters the wrapper function body.
  //
  // We rely on Debugger.setBreakpointByUrl rather than coordinator.pause()
  // or a synthetic `debugger;` statement because:
  //   - CDP's ScriptLoaded handler always auto-resumes (it never user-pauses).
  //   - coordinator.pause()'s ExplicitPause flag, set this early, gets
  //     swallowed by the legacy Debugger's runUntilValidPauseLocation when
  //     the bytecode it lands on isn't yet a valid pause point.
  //   - Setting the breakpoint here means it's already pending when
  //     compileFunctionForCJSLoader parses the user file; processScript
  //     resolves it against the matching URL and the Breakpoint event is
  //     delivered as a real user-visible pause.
  //
  // Column offset: the wrapper function expression starts at column 0 on
  // line 1, with the user's first character at column kCJSWrapperPrefixLen.
  // Setting the breakpoint at that column makes the resolver land inside
  // the wrapper body rather than on the script-level function-expression
  // statement (which evaluates without entering the body).
#ifdef HERMES_ENABLE_DEBUGGER
  if (exitCode == 0 && config.inspectBrk && cdpDebugAPI) {
    auto flushRuntimeTasks = [&]() {
      std::queue<facebook::hermes::debugger::RuntimeTask> tasks;
      {
        std::lock_guard<std::mutex> lock(inspectorState.mutex);
        tasks.swap(inspectorState.runtimeTasks);
      }
      while (!tasks.empty()) {
        tasks.front()(*hermesRT);
        tasks.pop();
      }
    };
    // Flush enableDebuggerDomain so the agent is wired up before we add
    // the breakpoint or run the synthetic debugger; statement.
    flushRuntimeTasks();

    if (!config.scriptPath.empty()) {
      // File mode: resolve the user script path to absolute form so it
      // matches what compileFunctionForCJSLoader records as the script's
      // sourceURL.
      char absScriptPath[PATH_MAX] = {0};
      const char *url = config.scriptPath.c_str();
      if (realpath(config.scriptPath.c_str(), absScriptPath)) {
        url = absScriptPath;
      }
      char cmd[PATH_MAX + 256];
      std::snprintf(
          cmd,
          sizeof(cmd),
          "{\"id\":1,\"method\":\"Debugger.setBreakpointByUrl\","
          "\"params\":{\"url\":\"%s\",\"lineNumber\":0,\"columnNumber\":%zu}}",
          url,
          kCJSWrapperPrefixLen);
      cdpAgent->handleCommand(cmd);
      // Without setBreakpointsActive(true) the Breakpoint event handler in
      // DebuggerDomainCoordinator auto-resumes instead of user-pausing.
      cdpAgent->handleCommand(
          "{\"id\":2,\"method\":\"Debugger.setBreakpointsActive\","
          "\"params\":{\"active\":true}}");
      flushRuntimeTasks();
    } else {
      // Eval / REPL mode: there is no user file URL to set a breakpoint
      // on, so fall back to running a synthetic `debugger;` statement
      // (the same primitive the binding used before commit 5d36ec8).
      // The legacy Debugger fires immediately and blocks on the
      // coordinator until a DevTools client connects and sends Resume.
      // The synthetic-frame DevTools UX caveat from that commit only
      // matters in file mode, where the user expects to land in their
      // own source.
      napi_value brkScript;
      napi_create_string_utf8(
          env,
          "debugger; //# sourceURL=hermes-node:inspect-brk",
          NAPI_AUTO_LENGTH,
          &brkScript);
      napi_value brkResult;
      napi_run_script(env, brkScript, &brkResult);
    }
  }
#endif

  // 12c. Preload --require modules, before any user code runs.
  //
  // Module._preloadModules is Node's own entry point for this: it resolves
  // each request against a dummy parent module in the current directory, so
  // relative paths, bare package names, and requires made *by* a preloaded
  // module all behave as they do in Node.
  //
  // Never in bundle mode: the CLI already refuses -r/--require together
  // with --bundle (checkToolOptions() in tools/hermes-node/hermes-node.cpp,
  // with the user-facing message), so config.bundlePath and
  // config.requireModules cannot both be set through that front door today.
  // This guard is defence in depth for hermes_node_runtime.h being a public
  // header with a different caller than the check that currently protects
  // it: a bundle's preloads are the container's own (config.preloadModules,
  // run from inside runBundle), and a disk -r must not run in front of
  // them -- see docs/superpowers/specs/2026-08-20-bundle-preload-design.md. An
  // embedded bundle is the same situation reached by a different route, and
  // is guarded here for the same reason: bundle_main.cpp parses no flags, so
  // it cannot set requireModules, but the guard belongs to the mode rather
  // than to the front door that happens to select it.
  if (exitCode == 0 && !config.requireModules.empty() &&
      config.bundlePath.empty() && config.embeddedBundleData == nullptr) {
    napi_value cjsLoader;
    if (instance->require("internal/modules/cjs/loader", &cjsLoader) !=
        napi_ok) {
      std::fprintf(
          stderr, "Error: failed to load internal/modules/cjs/loader\n");
      printAndClearException(env);
      exitCode = 1;
    } else {
      napi_value moduleCtor, preloadFn;
      napi_get_named_property(env, cjsLoader, "Module", &moduleCtor);
      napi_get_named_property(env, moduleCtor, "_preloadModules", &preloadFn);

      napi_valuetype preloadType;
      napi_typeof(env, preloadFn, &preloadType);
      if (preloadType != napi_function) {
        std::fprintf(stderr, "Error: Module._preloadModules is unavailable\n");
        exitCode = 1;
      } else {
        napi_value requests;
        napi_create_array_with_length(
            env, config.requireModules.size(), &requests);
        for (size_t i = 0; i < config.requireModules.size(); ++i) {
          napi_value request;
          napi_create_string_utf8(
              env,
              config.requireModules[i].c_str(),
              NAPI_AUTO_LENGTH,
              &request);
          napi_set_element(env, requests, static_cast<uint32_t>(i), request);
        }

        napi_value preloadResult;
        if (napi_call_function(
                env, moduleCtor, preloadFn, 1, &requests, &preloadResult) !=
            napi_ok) {
          printAndClearException(env);
          exitCode = 1;
        }
      }
    }
  }

  // 13. Load and execute the user script, eval code, or start the REPL --
  // or, in AOT bundle producer mode, build the bundle instead of running
  // anything, or, in consumer mode, run the bundle's entry module.
  if (exitCode == 0) {
    if (config.embeddedBundleData != nullptr) {
      exitCode = runEmbeddedBundle(
          env, *instance, config.embeddedBundleData, config.embeddedBundleSize);
    } else if (!config.bundlePath.empty()) {
      exitCode = runBundle(env, *instance, config.bundlePath);
    } else if (!config.buildBundlePath.empty()) {
      if (config.scriptPath.empty()) {
        std::fprintf(
            stderr, "Error: --build-bundle requires a script argument\n");
        exitCode = 1;
      } else {
        exitCode = buildBundle(
            env,
            config.scriptPath,
            config.buildBundlePath,
            config.verbose,
            config.includeModules,
            config.preloadModules,
            config.process.vmOptions,
            config.allowVmOptionsOverride);
      }
    } else if (!config.scriptPath.empty()) {
      napi_value loadUserScriptFn;
      napi_get_named_property(
          env, global, "__loadUserScript", &loadUserScriptFn);

      napi_value scriptPathStr;
      napi_create_string_utf8(
          env, config.scriptPath.c_str(), NAPI_AUTO_LENGTH, &scriptPathStr);

      napi_value result;
      if (napi_call_function(
              env, global, loadUserScriptFn, 1, &scriptPathStr, &result) !=
          napi_ok) {
        printAndClearException(env);
        exitCode = 1;
      }
    } else if (!config.evalCode.empty()) {
      // Give the code a real Node require (extension dispatch, node_modules
      // resolution from the current directory) before evaluating it. It is
      // still evaluated as a script, so it runs at global scope as Node's -e
      // does. See __setupEvalContext in libjs/loader.js.
      napi_value setupEvalFn;
      napi_get_named_property(env, global, "__setupEvalContext", &setupEvalFn);

      napi_valuetype setupEvalType;
      napi_typeof(env, setupEvalFn, &setupEvalType);
      if (setupEvalType != napi_function) {
        std::fprintf(stderr, "Error: __setupEvalContext is unavailable\n");
        exitCode = 1;
      } else {
        napi_value setupResult;
        if (napi_call_function(
                env, global, setupEvalFn, 0, nullptr, &setupResult) !=
            napi_ok) {
          printAndClearException(env);
          exitCode = 1;
        }
      }

      if (exitCode == 0) {
        napi_value evalScript;
        napi_create_string_utf8(
            env, config.evalCode.c_str(), NAPI_AUTO_LENGTH, &evalScript);
        napi_value evalResult;
        if (napi_run_script(env, evalScript, &evalResult) != napi_ok) {
          printAndClearException(env);
          exitCode = 1;
        }
      }
    } else if (config.enableRepl) {
      const char *replCode =
          "var cliRepl = require('internal/repl');\n"
          "cliRepl.createInternalRepl(process.env, function(err, repl) {\n"
          "  if (err) throw err;\n"
          "  repl.on('exit', function() {\n"
          "    if (repl.historyManager.isFlushing) {\n"
          "      repl.once('flushHistory', function() { process.exit(); });\n"
          "      return;\n"
          "    }\n"
          "    process.exit();\n"
          "  });\n"
          "});\n"
          "//# sourceURL=hermes-node:repl-start\n";
      napi_value replScript, replResult;
      napi_create_string_utf8(env, replCode, NAPI_AUTO_LENGTH, &replScript);
      if (napi_run_script(env, replScript, &replResult) != napi_ok) {
        printAndClearException(env);
        exitCode = 1;
      }
    }
  }

  // 14. Run event loop.
  if (exitCode == 0) {
    instance->drainTicks();

    // uv_run() returns as soon as nothing keeps the loop alive, but a
    // callback in that last iteration may well have scheduled a tick, a
    // microtask, or a fresh handle. Node drains those and re-checks
    // liveness before winding down; doing the same here is what keeps work
    // scheduled from the final callback from being dropped on the floor.
    do {
      uv_run(instance->loop(), UV_RUN_DEFAULT);
      instance->drainTicks();
    } while (uv_loop_alive(instance->loop()));
  }

  // 15. Settle the exit status, then emit 'exit' on the process object.
  exitCode = instance->emitExit(exitCode);

  // 16. Cleanup (reverse order of creation).
  instance->closeStdio();
  instance->beginShutdown();

  // Shut down the inspector thread and close the inspector async handle.
#ifdef HERMES_ENABLE_DEBUGGER
  if (inspectorAsyncActive) {
    // Signal the inspector thread to stop its event loop.
    if (inspectorThread.joinable() && bridgeCtx) {
      std::lock_guard<std::mutex> lock(bridgeCtx->shutdownMutex);
      if (bridgeCtx->canSendShutdown) {
        uv_async_send(&bridgeCtx->shutdownAsync);
      }
    }

    // Prevent further uv_async_send calls from the inspector thread
    // (or from CDPAgent destruction).
    inspectorState.asyncActive.store(false, std::memory_order_release);
    inspectorState.agent = nullptr;

    // Wait for the inspector thread to complete its cleanup.
    if (inspectorThread.joinable()) {
      inspectorThread.join();
    }

    uv_close(
        reinterpret_cast<uv_handle_t *>(&inspectorState.asyncHandle), nullptr);
  }
#endif

  // If this is the inspector runtime, mark async handles as no longer safe
  // before closing the event loop. This prevents the main thread from sending
  // to inspectorAsync or shutdownAsync after the loop is destroyed.
  if (config.inspectorBridgeContext) {
    auto *bc =
        static_cast<InspectorBridgeContext *>(config.inspectorBridgeContext);
    bc->inspectorAsyncActive.store(false, std::memory_order_release);
    std::lock_guard<std::mutex> lock(bc->shutdownMutex);
    bc->canSendShutdown = false;
  }

  napi_close_handle_scope(env, scope);
  instance->finishShutdown();

  // Destroy CDP objects before env and runtime (reverse creation order).
  // CDPAgent destructor may enqueue runtime tasks; drain them manually since
  // the async handle is already closed.
#ifdef HERMES_ENABLE_DEBUGGER
  cdpAgent.reset();
  if (inspectorAsyncActive) {
    std::lock_guard<std::mutex> lock(inspectorState.mutex);
    while (!inspectorState.runtimeTasks.empty()) {
      inspectorState.runtimeTasks.front()(*hermesRT);
      inspectorState.runtimeTasks.pop();
    }
    inspectorState.hermesRT = nullptr;
    inspectorAsyncActive = false;
  }
  cdpDebugAPI.reset();
  delete bridgeCtx;
#endif

  instance->destroyEnv();
  hermesRT.reset();
  instance.reset();

  return exitCode;
}

} // namespace node_compat
} // namespace hermes

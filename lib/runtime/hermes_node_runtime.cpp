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
#include <hermes/node-compat/event-loop/uv_event_loop.h>
#include <hermes/node-compat/inspector/inspector_bridge.h>
#include <hermes/node-compat/runtime/embedded_blob.h>
#include <hermes/node-compat/runtime/hermes_node_instance.h>
#include <hermes/node-compat/runtime/runtime_state.h>

#include <uv.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
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

/// napi callback for __runEmbeddedBytecode(): evaluates bytecode embedded in
/// this executable and returns the script's completion value (the CJS module
/// wrapper function).
///
/// The blob is part of the loaded image, so it is already mapped and needs no
/// copy and no finalizer -- hence the null finalize callback.
static napi_value runEmbeddedBytecodeCallback(
    napi_env env,
    napi_callback_info /*info*/) {
  const uint8_t *data = nullptr;
  size_t size = 0;
  if (!findEmbeddedBlob(&data, &size)) {
    napi_throw_error(env, nullptr, "no embedded bytecode in this binary");
    return nullptr;
  }

  hermes_bytecode_flags flags{};
  flags.struct_size = sizeof(flags);
  flags.persistent = true;

  napi_value result;
  if (hermes_run_bytecode(
          env,
          data,
          size,
          nullptr,
          nullptr,
          "hnode:embedded",
          &flags,
          &result) != napi_ok) {
    return nullptr;
  }
  return result;
}

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

int runHermesNode(const HermesNodeConfig &config) {
  // 1. Create Hermes runtime with microtask queue enabled.
  auto rtConfig = hermes::vm::RuntimeConfig::Builder()
                      .withMicrotaskQueue(true)
                      .withEnableAsyncGenerators(true)
                      .withES6BlockScoping(true)
                      .build();
  auto hermesRT = facebook::hermes::makeHermesRuntime(rtConfig);

  // 2-3. Create the event loop and the napi_env.
  auto instance = HermesNodeInstance::create(*hermesRT);
  if (!instance)
    return 1;
  napi_env env = instance->env();
  instance->runtimeState()->inspectorBridgeContext =
      config.inspectorBridgeContext;

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
    HermesNodeConfig inspectorConfig;
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
  instanceConfig.nodeVersion = config.nodeVersion;
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

  // 13. Load and execute the user script, eval code, or start the REPL.
  if (exitCode == 0) {
    const uint8_t *blobData = nullptr;
    size_t blobSize = 0;
    const bool haveBlob = findEmbeddedBlob(&blobData, &blobSize);

    // A binary with bytecode injected into it behaves like that application
    // rather than like a JS runtime: argv belongs to the embedded program, so
    // an explicit script path is not consulted. An explicit -e/--eval still
    // wins, which keeps a blob build debuggable.
    if (haveBlob && config.evalCode.empty()) {
      napi_value runEmbeddedFn;
      napi_create_function(
          env,
          "__runEmbeddedBytecode",
          NAPI_AUTO_LENGTH,
          runEmbeddedBytecodeCallback,
          nullptr,
          &runEmbeddedFn);
      napi_set_named_property(
          env, global, "__runEmbeddedBytecode", runEmbeddedFn);

      napi_value loadEmbeddedFn;
      napi_get_named_property(
          env, global, "__loadEmbeddedScript", &loadEmbeddedFn);

      napi_value nameStr;
      napi_create_string_utf8(
          env,
          config.argv.empty() ? "hnode:embedded" : config.argv[0].c_str(),
          NAPI_AUTO_LENGTH,
          &nameStr);

      napi_value result;
      if (napi_call_function(
              env, global, loadEmbeddedFn, 1, &nameStr, &result) != napi_ok) {
        printAndClearException(env);
        exitCode = 1;
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
      napi_value evalScript;
      napi_create_string_utf8(
          env, config.evalCode.c_str(), NAPI_AUTO_LENGTH, &evalScript);
      napi_value evalResult;
      if (napi_run_script(env, evalScript, &evalResult) != napi_ok) {
        printAndClearException(env);
        exitCode = 1;
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
  //
  // Alternate between draining (microtasks + nextTick) and running the loop
  // until both are quiescent.
  //
  // A single drain-then-run is not enough. uv_run() returns once no handles
  // are active, but a promise resolved during that final iteration leaves its
  // continuation sitting in the microtask queue -- the unref'd check/prepare
  // handles only drain while the loop is still spinning. Without a drain after
  // uv_run() returns, `await` on the last pending operation never resumes and
  // the process exits 0 with the remaining work silently dropped.
  //
  // Draining can also schedule new timers or I/O, which makes the loop alive
  // again, so this has to be a loop rather than a drain/run/drain sequence.
  if (exitCode == 0) {
    for (;;) {
      instance->drainTicks();
      if (!uv_loop_alive(instance->loop()))
        break;
      uv_run(instance->loop(), UV_RUN_DEFAULT);
    }
  }

  // 15. Emit 'exit' event on process object (honouring process.exitCode).
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

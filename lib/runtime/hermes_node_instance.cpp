/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <hermes/node-compat/runtime/hermes_node_instance.h>

#include "napi/hermes_napi.h"

#include "hermes/hermes.h"

#include <hermes/node-compat/binding-registry/binding_registry.h>
#include <hermes/node-compat/bindings/handle_wrap_base.h>
#include <hermes/node-compat/bindings/node_async_context_frame.h>
#include <hermes/node-compat/bindings/node_async_wrap.h>
#include <hermes/node-compat/bindings/node_buffer.h>
#include <hermes/node-compat/bindings/node_cares_wrap.h>
#include <hermes/node-compat/bindings/node_config.h>
#include <hermes/node-compat/bindings/node_constants.h>
#include <hermes/node-compat/bindings/node_contextify.h>
#include <hermes/node-compat/bindings/node_credentials.h>
#include <hermes/node-compat/bindings/node_crypto.h>
#include <hermes/node-compat/bindings/node_encoding.h>
#include <hermes/node-compat/bindings/node_errors.h>
#include <hermes/node-compat/bindings/node_file.h>
#include <hermes/node-compat/bindings/node_file_dir.h>
#include <hermes/node-compat/bindings/node_fs_event_wrap.h>
#include <hermes/node-compat/bindings/node_http_parser.h>
#include <hermes/node-compat/bindings/node_module_wrap.h>
#include <hermes/node-compat/bindings/node_modules.h>
#include <hermes/node-compat/bindings/node_os.h>
#include <hermes/node-compat/bindings/node_pipe_wrap.h>
#include <hermes/node-compat/bindings/node_process_wrap.h>
#include <hermes/node-compat/bindings/node_spawn_sync.h>
#include <hermes/node-compat/bindings/node_stdio.h>
#include <hermes/node-compat/bindings/node_stream_wrap.h>
#include <hermes/node-compat/bindings/node_string_decoder.h>
#include <hermes/node-compat/bindings/node_symbols.h>
#include <hermes/node-compat/bindings/node_task_queue.h>
#include <hermes/node-compat/bindings/node_tcp_wrap.h>
#include <hermes/node-compat/bindings/node_timers.h>
#include <hermes/node-compat/bindings/node_tls.h>
#include <hermes/node-compat/bindings/node_trace_events.h>
#include <hermes/node-compat/bindings/node_tty_wrap.h>
#include <hermes/node-compat/bindings/node_types.h>
#include <hermes/node-compat/bindings/node_udp_wrap.h>
#include <hermes/node-compat/bindings/node_url.h>
#include <hermes/node-compat/bindings/node_util.h>
#include <hermes/node-compat/bindings/node_uv.h>
#include <hermes/node-compat/bindings/node_zlib.h>
#include <hermes/node-compat/embedded-modules/embedded_modules.h>
#include <hermes/node-compat/event-loop/uv_event_loop.h>
#include <hermes/node-compat/inspector/inspector_bridge.h>
#include <hermes/node-compat/module-loader/module_loader.h>
#include <hermes/node-compat/process/node_process.h>
#include <hermes/node-compat/runtime/runtime_state.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace hermes {
namespace node_compat {

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

void printAndClearException(napi_env env) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending)
    return;

  napi_value exc;
  napi_get_and_clear_last_exception(env, &exc);

  // Try to get the stack trace (Error objects have .stack).
  napi_value stack;
  napi_status st = napi_get_named_property(env, exc, "stack", &stack);
  napi_valuetype stackType = napi_undefined;
  if (st == napi_ok)
    napi_typeof(env, stack, &stackType);

  napi_value msg;
  if (stackType == napi_string) {
    msg = stack;
  } else {
    napi_coerce_to_string(env, exc, &msg);
  }

  char buf[4096];
  size_t len = 0;
  napi_get_value_string_utf8(env, msg, buf, sizeof(buf), &len);
  std::fprintf(stderr, "%.*s\n", static_cast<int>(len), buf);
}

/// Called by Hermes NAPI when napi_fatal_exception() is invoked.
/// Routes to process.emit('uncaughtException', err). If no handler is
/// installed or the emit fails, prints the error and aborts.
static void onFatalException(void * /*data*/, napi_env env, napi_value err) {
  napi_handle_scope scope;
  napi_open_handle_scope(env, &scope);

  napi_value global;
  napi_get_global(env, &global);

  napi_value processObj;
  napi_get_named_property(env, global, "process", &processObj);

  napi_value emitFn;
  napi_get_named_property(env, processObj, "emit", &emitFn);

  napi_valuetype emitType;
  napi_typeof(env, emitFn, &emitType);

  bool handled = false;
  if (emitType == napi_function) {
    napi_value eventStr;
    napi_create_string_utf8(
        env, "uncaughtException", NAPI_AUTO_LENGTH, &eventStr);
    napi_value emitArgs[2] = {eventStr, err};
    napi_value emitResult;
    napi_status st =
        napi_call_function(env, processObj, emitFn, 2, emitArgs, &emitResult);
    if (st == napi_ok) {
      // process.emit returns true if there were listeners.
      bool result = false;
      napi_get_value_bool(env, emitResult, &result);
      handled = result;
    }
  }

  if (!handled) {
    // No listener handled it -- print and abort, matching Node.js behavior
    // for unhandled uncaughtException.
    napi_value errStr;
    napi_coerce_to_string(env, err, &errStr);
    char buf[4096];
    size_t len = 0;
    napi_get_value_string_utf8(env, errStr, buf, sizeof(buf), &len);
    std::fprintf(stderr, "%.*s\n", static_cast<int>(len), buf);

    // Clear any exception that may have been set during error formatting.
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending) {
      napi_value exc;
      napi_get_and_clear_last_exception(env, &exc);
    }

    napi_close_handle_scope(env, scope);
    std::abort();
  }

  napi_close_handle_scope(env, scope);
}

/// Write stringified arguments to a FILE*, separated by spaces, with newline.
static napi_value
consolePrint(napi_env env, napi_callback_info info, FILE *out) {
  size_t argc = 16;
  napi_value argv[16];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  for (size_t i = 0; i < argc; ++i) {
    if (i > 0)
      std::fputc(' ', out);
    napi_value str;
    napi_coerce_to_string(env, argv[i], &str);
    size_t len = 0;
    napi_get_value_string_utf8(env, str, nullptr, 0, &len);
    std::string buf(len, '\0');
    napi_get_value_string_utf8(env, str, &buf[0], len + 1, &len);
    std::fwrite(buf.data(), 1, len, out);
  }
  std::fputc('\n', out);

  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value consoleLog(napi_env env, napi_callback_info info) {
  return consolePrint(env, info, stdout);
}

static napi_value consoleError(napi_env env, napi_callback_info info) {
  return consolePrint(env, info, stderr);
}

/// Install a minimal console object with log/warn/error/info methods.
static napi_status installConsole(napi_env env) {
  napi_value global;
  napi_status st = napi_get_global(env, &global);
  if (st != napi_ok)
    return st;

  napi_value console;
  st = napi_create_object(env, &console);
  if (st != napi_ok)
    return st;

  napi_value logFn, errorFn;
  st = napi_create_function(
      env, "log", NAPI_AUTO_LENGTH, consoleLog, nullptr, &logFn);
  if (st != napi_ok)
    return st;
  st = napi_create_function(
      env, "error", NAPI_AUTO_LENGTH, consoleError, nullptr, &errorFn);
  if (st != napi_ok)
    return st;

  // log and info go to stdout; warn and error go to stderr.
  st = napi_set_named_property(env, console, "log", logFn);
  if (st != napi_ok)
    return st;
  st = napi_set_named_property(env, console, "info", logFn);
  if (st != napi_ok)
    return st;
  st = napi_set_named_property(env, console, "warn", errorFn);
  if (st != napi_ok)
    return st;
  st = napi_set_named_property(env, console, "error", errorFn);
  if (st != napi_ok)
    return st;

  return napi_set_named_property(env, global, "console", console);
}

// ---------------------------------------------------------------------------
// HermesNodeInstance::Impl
// ---------------------------------------------------------------------------

struct HermesNodeInstance::Impl {
  facebook::jsi::Runtime *runtime = nullptr;
  facebook::hermes::IHermes *hermes = nullptr;
  UvEventLoop eventLoop;
  napi_env env = nullptr;
  RuntimeState *runtimeState = nullptr;

  BindingRegistry registry;
  NodeProcess proc;
  ModuleLoader loader;
  bool bootstrapped = false;

  /// process._tickCallback (runNextTicks).
  napi_ref tickCallbackRef = nullptr;
  /// tickInfo[kHasTickScheduled], owned by the task_queue binding.
  volatile uint32_t *tickInfo = nullptr;

  /// Drain microtasks and ticks around every loop iteration, like Node.
  uv_check_t checkHandle{};
  uv_prepare_t prepareHandle{};
  bool tickHandlesActive = false;

  bool loopClosed = false;

  void drainTicks();
  bool bootstrap(const HermesNodeInstanceConfig &config);
};

void HermesNodeInstance::Impl::drainTicks() {
  napi_handle_scope scope;
  napi_open_handle_scope(env, &scope);

  // Drain microtasks first. Use the JSI virtual method so the body executes
  // in Hermes's TU with the correct layout (see the ODR note in create()).
  runtime->drainMicrotasks(-1);

  // Call the JS tick callback (runNextTicks) if set.
  if (tickCallbackRef) {
    napi_value tickCb;
    napi_get_reference_value(env, tickCallbackRef, &tickCb);

    napi_valuetype cbType;
    napi_typeof(env, tickCb, &cbType);
    if (cbType == napi_function) {
      napi_value global;
      napi_get_global(env, &global);
      napi_value result;
      if (napi_call_function(env, global, tickCb, 0, nullptr, &result) !=
          napi_ok) {
        printAndClearException(env);
      }
    }
  }

  napi_close_handle_scope(env, scope);
}

static void onCheckDrainTicks(uv_check_t *handle) {
  static_cast<HermesNodeInstance::Impl *>(handle->data)->drainTicks();
}

static void onPrepareDrainTicks(uv_prepare_t *handle) {
  static_cast<HermesNodeInstance::Impl *>(handle->data)->drainTicks();
}

bool HermesNodeInstance::Impl::bootstrap(
    const HermesNodeInstanceConfig &config) {
  napi_handle_scope scope;
  napi_open_handle_scope(env, &scope);
  bool ok = true;

  // Install console object.
  if (config.installGlobals && installConsole(env) != napi_ok) {
    std::fprintf(stderr, "Error: failed to install console\n");
    ok = false;
  }

  // Register native bindings.
  registry.registerBinding("async_context_frame", initAsyncContextFrameBinding);
  registry.registerBinding("async_wrap", initAsyncWrapBinding);
  registry.registerBinding("buffer", initBufferBinding);
  registry.registerBinding("cares_wrap", initCaresWrapBinding);
  registry.registerBinding("config", initConfigBinding);
  registry.registerBinding("constants", initConstantsBinding);
  registry.registerBinding("contextify", initContextifyBinding);
  registry.registerBinding("credentials", initCredentialsBinding);
  registry.registerBinding("crypto", initCryptoBinding);
  registry.registerBinding("encoding_binding", initEncodingBinding);
  registry.registerBinding("errors", initErrorsBinding);
  registry.registerBinding("fs", initFsBinding);
  registry.registerBinding("fs_dir", initFsDirBinding);
  registry.registerBinding("fs_event_wrap", initFsEventWrapBinding);
  registry.registerBinding("http_parser", initHttpParserBinding);
  registry.registerBinding("inspector_bridge", initInspectorBridgeBinding);
  registry.registerBinding("module_wrap", initModuleWrapBinding);
  registry.registerBinding("modules", initModulesBinding);
  registry.registerBinding("os", initOsBinding);
  registry.registerBinding("pipe_wrap", initPipeWrapBinding);
  registry.registerBinding("process_wrap", initProcessWrapBinding);
  registry.registerBinding("spawn_sync", initSpawnSyncBinding);
  registry.registerBinding("stdio", initStdioBinding);
  registry.registerBinding("stream_wrap", initStreamWrapBinding);
  registry.registerBinding("string_decoder", initStringDecoderBinding);
  registry.registerBinding("symbols", initSymbolsBinding);
  registry.registerBinding("task_queue", initTaskQueueBinding);
  registry.registerBinding("tcp_wrap", initTcpWrapBinding);
  registry.registerBinding("udp_wrap", initUdpWrapBinding);
  registry.registerBinding("timers", initTimersBinding);
  registry.registerBinding("tls", initTlsBinding);
  registry.registerBinding("trace_events", initTraceEventsBinding);
  registry.registerBinding("tty_wrap", initTtyWrapBinding);
  registry.registerBinding("types", initTypesBinding);
  registry.registerBinding("url", initUrlBinding);
  registry.registerBinding("url_pattern", initUrlPatternBinding);
  registry.registerBinding("util", initUtilBinding);
  registry.registerBinding("uv", initUvBinding);
  registry.registerBinding("zlib", initZlibBinding);
  registry.attach(env);

  // Load and execute primordials from embedded bytecode.
  if (ok) {
    napi_value result;
    if (runEmbeddedModule(env, "primordials", &result) != napi_ok) {
      std::fprintf(stderr, "Error: failed to execute primordials\n");
      printAndClearException(env);
      ok = false;
    }
  }

  napi_value global;
  napi_get_global(env, &global);
  napi_value primordials;
  napi_get_named_property(env, global, "primordials", &primordials);

  // Create internalBinding function.
  napi_value internalBindingFn;
  registry.createInternalBindingFunction(env, &internalBindingFn);

  // Create and set the process global.
  {
    std::vector<std::string> nodeArgv;
    if (!config.argv.empty()) {
      nodeArgv = config.argv;
    } else {
      nodeArgv.push_back("hermes-node");
    }
    proc.setArgv(std::move(nodeArgv));
    if (!config.nodeVersion.empty())
      proc.setVersion(config.nodeVersion.c_str());

    if (!config.execPath.empty()) {
      proc.setExecPath(config.execPath);
    } else {
      char execBuf[4096];
      size_t execSize = sizeof(execBuf);
      if (uv_exepath(execBuf, &execSize) == 0) {
        proc.setExecPath(std::string(execBuf, execSize));
      } else {
        proc.setExecPath(config.argv.empty() ? "hermes-node" : config.argv[0]);
      }
    }
  }

  if (ok) {
    napi_value processObj;
    if (proc.create(env, &processObj) != napi_ok) {
      std::fprintf(stderr, "Error: failed to create process object\n");
      printAndClearException(env);
      ok = false;
    } else {
      // Node's own JS reads the `process` global, so it is installed even
      // when the embedder doesn't want the other Node globals.
      napi_set_named_property(env, global, "process", processObj);

      // Add minimal process event emitter methods (on/emit/emitWarning).
      napi_value peResult;
      if (runEmbeddedModule(env, "process-events", &peResult) != napi_ok) {
        std::fprintf(stderr, "Error: failed to execute process-events\n");
        printAndClearException(env);
        ok = false;
      }
    }
  }

  // Initialize the module loader.
  if (ok) {
    if (loader.init(env, primordials, internalBindingFn) != napi_ok) {
      std::fprintf(stderr, "Error: failed to initialize module loader\n");
      printAndClearException(env);
      ok = false;
    }
  }

  // Set up process.nextTick via internal/process/task_queues.
  if (ok) {
    napi_value taskQueuesModule;
    if (loader.require(
            env, "internal/process/task_queues", &taskQueuesModule) !=
        napi_ok) {
      std::fprintf(
          stderr, "Error: failed to load internal/process/task_queues\n");
      printAndClearException(env);
      ok = false;
    } else {
      napi_value setupFn;
      napi_get_named_property(
          env, taskQueuesModule, "setupTaskQueue", &setupFn);

      napi_value setupResult;
      if (napi_call_function(
              env, taskQueuesModule, setupFn, 0, nullptr, &setupResult) !=
          napi_ok) {
        std::fprintf(stderr, "Error: failed to call setupTaskQueue()\n");
        printAndClearException(env);
        ok = false;
      } else {
        napi_value nextTickFn;
        napi_get_named_property(env, setupResult, "nextTick", &nextTickFn);

        napi_value runNextTicksFn;
        napi_get_named_property(
            env, setupResult, "runNextTicks", &runNextTicksFn);

        napi_value processObj;
        napi_get_named_property(env, global, "process", &processObj);
        napi_set_named_property(env, processObj, "nextTick", nextTickFn);
        napi_set_named_property(
            env, processObj, "_tickCallback", runNextTicksFn);

        napi_create_reference(env, runNextTicksFn, 1, &tickCallbackRef);
      }
    }

    // Remember where tickInfo[kHasTickScheduled] lives so embedders can tell
    // from another thread that ticks are waiting to be drained.
    napi_value taskQueueBinding, tickInfoArr;
    if (registry.getBinding(env, "task_queue", &taskQueueBinding) == napi_ok &&
        napi_get_named_property(
            env, taskQueueBinding, "tickInfo", &tickInfoArr) == napi_ok) {
      napi_typedarray_type type;
      size_t length = 0;
      void *data = nullptr;
      if (napi_get_typedarray_info(
              env, tickInfoArr, &type, &length, &data, nullptr, nullptr) ==
              napi_ok &&
          type == napi_uint32_array && length >= 1) {
        tickInfo = static_cast<volatile uint32_t *>(data);
      }
    }
  }

  // Set up timers (setTimeout, setInterval, setImmediate).
  if (ok && tickCallbackRef) {
    napi_value internalTimersModule;
    if (loader.require(env, "internal/timers", &internalTimersModule) !=
        napi_ok) {
      std::fprintf(stderr, "Error: failed to load internal/timers\n");
      printAndClearException(env);
      ok = false;
    } else {
      napi_value runNextTicksFn;
      napi_get_reference_value(env, tickCallbackRef, &runNextTicksFn);

      napi_value getTimerCallbacksFn;
      napi_get_named_property(
          env, internalTimersModule, "getTimerCallbacks", &getTimerCallbacksFn);

      napi_value timerCallbacks;
      if (napi_call_function(
              env,
              internalTimersModule,
              getTimerCallbacksFn,
              1,
              &runNextTicksFn,
              &timerCallbacks) != napi_ok) {
        std::fprintf(stderr, "Error: failed to call getTimerCallbacks()\n");
        printAndClearException(env);
        ok = false;
      } else {
        napi_value processImmediateFn;
        napi_get_named_property(
            env, timerCallbacks, "processImmediate", &processImmediateFn);
        napi_value processTimersFn;
        napi_get_named_property(
            env, timerCallbacks, "processTimers", &processTimersFn);

        napi_value timersBinding;
        registry.getBinding(env, "timers", &timersBinding);

        napi_value setupTimersFn;
        napi_get_named_property(
            env, timersBinding, "setupTimers", &setupTimersFn);

        napi_value setupArgs[2] = {processImmediateFn, processTimersFn};
        napi_value setupResult;
        if (napi_call_function(
                env,
                timersBinding,
                setupTimersFn,
                2,
                setupArgs,
                &setupResult) != napi_ok) {
          std::fprintf(stderr, "Error: failed to call setupTimers()\n");
          printAndClearException(env);
          ok = false;
        }
      }
    }

    // Load public timers module and set globals.
    if (ok && config.installGlobals) {
      napi_value timersModule;
      if (loader.require(env, "timers", &timersModule) != napi_ok) {
        std::fprintf(stderr, "Error: failed to load timers module\n");
        printAndClearException(env);
        ok = false;
      } else {
        const char *timerGlobals[] = {
            "setTimeout",
            "clearTimeout",
            "setInterval",
            "clearInterval",
            "setImmediate",
            "clearImmediate",
        };
        for (const char *name : timerGlobals) {
          napi_value fn;
          napi_get_named_property(env, timersModule, name, &fn);
          napi_set_named_property(env, global, name, fn);
        }
      }
    }
  }

  // Set globalThis.Buffer.
  if (ok && config.installGlobals) {
    napi_value bufferModule;
    if (loader.require(env, "buffer", &bufferModule) == napi_ok) {
      napi_value bufferCtor;
      napi_get_named_property(env, bufferModule, "Buffer", &bufferCtor);
      napi_set_named_property(env, global, "Buffer", bufferCtor);
    }
  }

  // Set globalThis.URL and globalThis.URLSearchParams.
  if (ok && config.installGlobals) {
    napi_value urlModule;
    if (loader.require(env, "internal/url", &urlModule) == napi_ok) {
      napi_value urlCtor;
      napi_get_named_property(env, urlModule, "URL", &urlCtor);
      napi_set_named_property(env, global, "URL", urlCtor);

      napi_value urlSPCtor;
      napi_get_named_property(env, urlModule, "URLSearchParams", &urlSPCtor);
      napi_set_named_property(env, global, "URLSearchParams", urlSPCtor);
    }
  }

  // Set globalThis.AbortController/AbortSignal, EventTarget/Event and
  // fetch/Headers/Request/Response, as Node does.
  if (ok && config.installGlobals) {
    struct GlobalExport {
      const char *module;
      const char *name;
    };
    const GlobalExport exportsToInstall[] = {
        {"internal/event_target", "EventTarget"},
        {"internal/event_target", "Event"},
        {"internal/abort_controller", "AbortController"},
        {"internal/abort_controller", "AbortSignal"},
        {"internal/hermes/fetch", "fetch"},
        {"internal/hermes/fetch", "Headers"},
        {"internal/hermes/fetch", "Request"},
        {"internal/hermes/fetch", "Response"},
    };
    for (const GlobalExport &e : exportsToInstall) {
      napi_value mod, value;
      if (loader.require(env, e.module, &mod) == napi_ok &&
          napi_get_named_property(env, mod, e.name, &value) == napi_ok) {
        napi_set_named_property(env, global, e.name, value);
      }
      printAndClearException(env);
    }
  }

  // Initialize debuglog.
  if (ok) {
    napi_value debuglogModule;
    if (loader.require(env, "internal/util/debuglog", &debuglogModule) ==
        napi_ok) {
      napi_value initDebugEnvFn;
      napi_get_named_property(
          env, debuglogModule, "initializeDebugEnv", &initDebugEnvFn);

      napi_value processObj;
      napi_get_named_property(env, global, "process", &processObj);
      napi_value envObj;
      napi_get_named_property(env, processObj, "env", &envObj);
      napi_value nodeDebugVal;
      napi_get_named_property(env, envObj, "NODE_DEBUG", &nodeDebugVal);

      napi_value initResult;
      napi_call_function(
          env, debuglogModule, initDebugEnvFn, 1, &nodeDebugVal, &initResult);
      printAndClearException(env);
    }
  }

  // Set up process.stdin, process.stdout, process.stderr.
  if (ok && config.setupStdio) {
    napi_value result;
    if (runEmbeddedModule(env, "setup-stdio", &result) != napi_ok) {
      std::fprintf(stderr, "Error: failed to execute setup-stdio\n");
      printAndClearException(env);
      ok = false;
    }
  }

  // Load and install the real console module.
  if (ok && config.installGlobals) {
    napi_value ciResult;
    if (runEmbeddedModule(env, "console-init", &ciResult) != napi_ok) {
      // Non-fatal: fall back to the minimal C++ console.
      printAndClearException(env);
    }
  }

  // Initialize Node's CJS module loader.
  if (ok) {
    napi_value initCJSFn;
    napi_get_named_property(env, global, "__initCJS", &initCJSFn);
    napi_value initResult;
    if (napi_call_function(env, global, initCJSFn, 0, nullptr, &initResult) !=
        napi_ok) {
      // Non-fatal.
      printAndClearException(env);
    }
  }

  // Set up event loop check and prepare handles for tick draining.
  if (ok && tickCallbackRef) {
    uv_check_init(eventLoop.getLoop(), &checkHandle);
    checkHandle.data = this;
    uv_check_start(&checkHandle, onCheckDrainTicks);
    uv_unref(reinterpret_cast<uv_handle_t *>(&checkHandle));

    uv_prepare_init(eventLoop.getLoop(), &prepareHandle);
    prepareHandle.data = this;
    uv_prepare_start(&prepareHandle, onPrepareDrainTicks);
    uv_unref(reinterpret_cast<uv_handle_t *>(&prepareHandle));

    tickHandlesActive = true;
  }

  napi_close_handle_scope(env, scope);
  bootstrapped = ok;
  return ok;
}

// ---------------------------------------------------------------------------
// HermesNodeInstance
// ---------------------------------------------------------------------------

HermesNodeInstance::HermesNodeInstance() : impl_(std::make_unique<Impl>()) {}

HermesNodeInstance::~HermesNodeInstance() {
  // RuntimeState is referenced by GC finalizers that run while the runtime
  // is destroyed, so it is only freed here, after the owner of the instance
  // has destroyed the runtime (or decided to leak the instance).
  delete impl_->runtimeState;
}

std::unique_ptr<HermesNodeInstance> HermesNodeInstance::create(
    facebook::jsi::Runtime &runtime) {
  auto *ihermes =
      facebook::jsi::castInterface<facebook::hermes::IHermes>(&runtime);
  if (!ihermes) {
    std::fprintf(stderr, "Error: hermes-node requires a Hermes runtime\n");
    return nullptr;
  }

  std::unique_ptr<HermesNodeInstance> self(new HermesNodeInstance());
  Impl &impl = *self->impl_;
  impl.runtime = &runtime;
  impl.hermes = ihermes;

  int uvErr = impl.eventLoop.init();
  if (uvErr != 0) {
    std::fprintf(
        stderr,
        "Error: failed to initialize event loop: %s\n",
        uv_strerror(uvErr));
    return nullptr;
  }

  impl.eventLoop.getHost()->fatal_exception = onFatalException;

  // IMPORTANT: pass the opaque VM-runtime pointer to NAPI but use HermesRuntime
  // (JSI) for any other runtime interaction. vm::Runtime is declared in
  // Hermes-internal headers whose layout depends on private compile defines
  // (HERMES_MEMORY_INSTRUMENTATION, HERMES_CHECK_NATIVE_STACK, etc.) that
  // Hermes's CMake add_definitions() leaks only within its subdirectory scope.
  // Including those headers here would silently miscompute field offsets and
  // corrupt unrelated Runtime state. The JSI / IHermes virtual methods
  // dispatch into Hermes's TU where the layout is correct.
  impl.env = hermes_napi_create_env(
      ihermes->getVMRuntimeUnsafe(), impl.eventLoop.getHost());
  if (!impl.env) {
    std::fprintf(stderr, "Error: failed to create napi_env\n");
    return nullptr;
  }

  // Allocate and install per-instance state for bindings.
  auto *runtimeState = new RuntimeState();
  runtimeState->loop = impl.eventLoop.getLoop();
  runtimeState->drainMicrotasksFn = [](void *data) {
    static_cast<facebook::jsi::Runtime *>(data)->drainMicrotasks(-1);
  };
  runtimeState->drainMicrotasksData = &runtime;
  runtimeState->triggerAsyncBreakFn = [](void *data) {
    static_cast<facebook::hermes::IHermes *>(data)->asyncTriggerTimeout();
  };
  runtimeState->triggerAsyncBreakData = ihermes;
  impl.runtimeState = runtimeState;
  // Use a no-op finalizer: RuntimeState must outlive the env because GC
  // finalizers (which run during runtime destruction) may still reference it
  // via cached rtState_ pointers. It is deleted by ~HermesNodeInstance().
  napi_set_instance_data(
      impl.env, runtimeState, [](napi_env, void *, void *) {}, nullptr);

  return self;
}

bool HermesNodeInstance::bootstrap(const HermesNodeInstanceConfig &config) {
  return impl_->bootstrap(config);
}

napi_env HermesNodeInstance::env() const {
  return impl_->env;
}

uv_loop_t *HermesNodeInstance::loop() const {
  return impl_->loopClosed ? nullptr : impl_->eventLoop.getLoop();
}

facebook::jsi::Runtime &HermesNodeInstance::runtime() const {
  return *impl_->runtime;
}

RuntimeState *HermesNodeInstance::runtimeState() const {
  return impl_->runtimeState;
}

napi_status HermesNodeInstance::require(const char *id, napi_value *result) {
  // Builtins may be spelled with the node: scheme.
  if (std::strncmp(id, "node:", 5) == 0)
    id += 5;
  return impl_->loader.require(impl_->env, id, result);
}

static napi_value requireTrampoline(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  void *data = nullptr;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, &data);
  auto *self = static_cast<HermesNodeInstance *>(data);

  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "require: missing module id");
    return nullptr;
  }
  size_t len = 0;
  if (napi_get_value_string_utf8(env, arg, nullptr, 0, &len) != napi_ok) {
    napi_throw_type_error(env, nullptr, "require: module id must be a string");
    return nullptr;
  }
  std::string id(len, '\0');
  napi_get_value_string_utf8(env, arg, &id[0], len + 1, &len);

  napi_value result = nullptr;
  if (self->require(id.c_str(), &result) != napi_ok)
    return nullptr; // exception pending
  return result;
}

napi_status HermesNodeInstance::createRequireFunction(napi_value *result) {
  return napi_create_function(
      impl_->env,
      "nodeRequire",
      NAPI_AUTO_LENGTH,
      requireTrampoline,
      this,
      result);
}

void HermesNodeInstance::drainTicks() {
  impl_->drainTicks();
}

void HermesNodeInstance::runOnce() {
  if (impl_->loopClosed)
    return;
  uv_run(impl_->eventLoop.getLoop(), UV_RUN_NOWAIT);
  impl_->drainTicks();
}

bool HermesNodeInstance::hasTickScheduled() const {
  return impl_->tickInfo && impl_->tickInfo[0] != 0;
}

/// Read process.exitCode into \p exitCode if it is a number.
static void
readProcessExitCode(napi_env env, napi_value processObj, int &exitCode) {
  napi_value prop;
  if (napi_get_named_property(env, processObj, "exitCode", &prop) != napi_ok)
    return;
  napi_valuetype t;
  napi_typeof(env, prop, &t);
  if (t != napi_number)
    return;
  int32_t requested = 0;
  if (napi_get_value_int32(env, prop, &requested) == napi_ok)
    exitCode = requested;
}

int HermesNodeInstance::emitExit(int exitCode) {
  napi_env env = impl_->env;
  napi_handle_scope scope;
  napi_open_handle_scope(env, &scope);

  napi_value global;
  napi_get_global(env, &global);
  napi_value processObj;
  napi_get_named_property(env, global, "process", &processObj);

  // Honour `process.exitCode`. Script code sets it to request a non-zero
  // status without exiting immediately (the unhandled-rejection reporter in
  // process-events.js does this, as does plenty of userland CLI code), so it
  // has to be folded in before 'exit' is emitted -- the handler receives the
  // final code as its argument.
  //
  // An explicit process.exit(n) has already terminated the process by this
  // point, so the only source here is the property.
  if (exitCode == 0)
    readProcessExitCode(env, processObj, exitCode);

  napi_value emitFn;
  napi_get_named_property(env, processObj, "emit", &emitFn);
  napi_valuetype emitType;
  napi_typeof(env, emitFn, &emitType);
  if (emitType == napi_function) {
    napi_value exitStr, exitCodeVal;
    napi_create_string_utf8(env, "exit", NAPI_AUTO_LENGTH, &exitStr);
    napi_create_int32(env, exitCode, &exitCodeVal);
    napi_value emitArgs[2] = {exitStr, exitCodeVal};
    napi_value emitResult;
    napi_call_function(env, processObj, emitFn, 2, emitArgs, &emitResult);
    printAndClearException(env);

    // An 'exit' handler may itself set process.exitCode; Node reads the
    // property again after the event. Re-read so that still takes effect.
    readProcessExitCode(env, processObj, exitCode);
  }

  napi_close_handle_scope(env, scope);
  return exitCode;
}

void HermesNodeInstance::closeStdio() {
  napi_env env = impl_->env;
  napi_handle_scope scope;
  napi_open_handle_scope(env, &scope);

  napi_value global;
  napi_get_global(env, &global);
  napi_value processObj;
  napi_get_named_property(env, global, "process", &processObj);
  const char *stdioNames[] = {"stdin", "stdout", "stderr"};
  for (const char *name : stdioNames) {
    napi_value stream;
    napi_get_named_property(env, processObj, name, &stream);
    napi_valuetype stype;
    napi_typeof(env, stream, &stype);
    if (stype != napi_object)
      continue;
    napi_value handle;
    napi_get_named_property(env, stream, "_handle", &handle);
    napi_valuetype htype;
    napi_typeof(env, handle, &htype);
    if (htype != napi_object)
      continue;
    napi_value closeFn;
    napi_get_named_property(env, handle, "close", &closeFn);
    napi_valuetype ctype;
    napi_typeof(env, closeFn, &ctype);
    if (ctype == napi_function) {
      napi_value closeResult;
      napi_call_function(env, handle, closeFn, 0, nullptr, &closeResult);
      bool pending = false;
      napi_is_exception_pending(env, &pending);
      if (pending) {
        napi_value exc;
        napi_get_and_clear_last_exception(env, &exc);
      }
    }
  }

  napi_close_handle_scope(env, scope);
}

void HermesNodeInstance::beginShutdown() {
  Impl &impl = *impl_;
  uv_run(impl.eventLoop.getLoop(), UV_RUN_NOWAIT);

  closeTimersHandles(impl.env);

  if (impl.tickHandlesActive) {
    uv_check_stop(&impl.checkHandle);
    uv_close(reinterpret_cast<uv_handle_t *>(&impl.checkHandle), nullptr);
    uv_prepare_stop(&impl.prepareHandle);
    uv_close(reinterpret_cast<uv_handle_t *>(&impl.prepareHandle), nullptr);
    impl.tickHandlesActive = false;
  }
}

void HermesNodeInstance::finishShutdown() {
  Impl &impl = *impl_;
  uv_run(impl.eventLoop.getLoop(), UV_RUN_NOWAIT);

  caresWrapShutdown(impl.env);

  impl.eventLoop.close();
  impl.loopClosed = true;
  impl.tickInfo = nullptr;
  impl.runtimeState->loop = nullptr;

  if (impl.tickCallbackRef) {
    napi_delete_reference(impl.env, impl.tickCallbackRef);
    impl.tickCallbackRef = nullptr;
  }

  impl.loader.detach(impl.env);
  impl.proc.detach(impl.env);
  impl.registry.detach(impl.env);
}

void HermesNodeInstance::destroyEnv() {
  // The napi_env is owned by the Hermes runtime and dies with it; there is
  // nothing left to destroy here. Kept as an explicit step so callers don't
  // have to know which side owns it.
  impl_->env = nullptr;
}

} // namespace node_compat
} // namespace hermes

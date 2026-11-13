/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <hermes/node-compat/runtime/hermes_node_embedder.h>

#include <sys/select.h>

#include <condition_variable>
#include <cstdio>
#include <mutex>
#include <thread>

namespace hermes {
namespace node_compat {

/// Upper bound on how long the bridge thread sleeps without re-checking
/// libuv. libuv only registers new fds and timers with the backend while it
/// runs, so I/O started by the host outside a loop iteration (and nextTicks
/// queued from host JS) is noticed within this interval unless the host
/// calls wakeup().
static constexpr int kMaxPollMs = 16;

/// State shared between the JS thread and the bridge thread. Kept alive by
/// shared_ptr so tasks still queued on the host after detach() are harmless.
struct HermesNodeEmbedder::Bridge {
  HermesNodeEmbedderHost host;
  HermesNodeInstance *instance = nullptr;
  uv_loop_t *loop = nullptr;
  int backendFd = -1;
  uv_async_t wakeupHandle{};

  std::mutex mutex;
  std::condition_variable cv;
  bool stop = false;
  /// A runOnce task has been posted and has not finished yet.
  bool pending = false;

  std::thread thread;

  void threadMain(std::shared_ptr<Bridge> self);
  bool waitForWork();
};

namespace {
struct PostedTask {
  std::shared_ptr<HermesNodeEmbedder::Bridge> bridge;
};
} // namespace

/// Runs on the JS thread.
static void runOnceOnJSThread(void *arg) {
  std::unique_ptr<PostedTask> task(static_cast<PostedTask *>(arg));
  auto &bridge = *task->bridge;
  bool stopped;
  {
    std::lock_guard<std::mutex> lock(bridge.mutex);
    stopped = bridge.stop;
  }
  if (!stopped)
    bridge.instance->runOnce();
  {
    std::lock_guard<std::mutex> lock(bridge.mutex);
    bridge.pending = false;
  }
  bridge.cv.notify_all();
}

/// Block until libuv (or Node's nextTick queue) has work for the JS thread.
/// Returns false when asked to stop. Runs on the bridge thread.
///
/// libuv's loop state is read here without synchronization while the JS
/// thread may be mutating it; the values are only used as wakeup hints and
/// any stale read is corrected on the next check, at most kMaxPollMs later.
bool HermesNodeEmbedder::Bridge::waitForWork() {
  for (;;) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (stop)
        return false;
    }

    bool alive = uv_loop_alive(loop);
    int timeout = alive ? uv_backend_timeout(loop) : -1;
    if (instance->hasTickScheduled() || timeout == 0)
      return true;

    int wait = (timeout < 0 || timeout > kMaxPollMs) ? kMaxPollMs : timeout;
    fd_set fds;
    FD_ZERO(&fds);
    FD_SET(backendFd, &fds);
    struct timeval tv;
    tv.tv_sec = wait / 1000;
    tv.tv_usec = (wait % 1000) * 1000;
    int r = select(backendFd + 1, &fds, nullptr, nullptr, &tv);
    if (r > 0)
      return true;
    if (r == 0 && alive && timeout >= 0 && timeout <= kMaxPollMs)
      return true; // the next libuv timer is due
  }
}

void HermesNodeEmbedder::Bridge::threadMain(std::shared_ptr<Bridge> self) {
  while (waitForWork()) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (stop)
        return;
      pending = true;
    }
    host.postToJSThread(host.data, runOnceOnJSThread, new PostedTask{self});

    // Don't poll again until the JS thread has run the iteration; otherwise
    // the same readiness would be reported over and over.
    std::unique_lock<std::mutex> lock(mutex);
    cv.wait(lock, [&] { return !pending || stop; });
  }
}

HermesNodeEmbedder::HermesNodeEmbedder() = default;

HermesNodeEmbedder::~HermesNodeEmbedder() {
  if (!detached_)
    std::fprintf(
        stderr, "hermes-node: HermesNodeEmbedder destroyed without detach()\n");
}

std::unique_ptr<HermesNodeEmbedder> HermesNodeEmbedder::attach(
    facebook::hermes::HermesRuntime &runtime,
    const HermesNodeInstanceConfig &config,
    const HermesNodeEmbedderHost &host) {
  if (!host.postToJSThread) {
    std::fprintf(stderr, "hermes-node: postToJSThread is required\n");
    return nullptr;
  }

  std::unique_ptr<HermesNodeEmbedder> self(new HermesNodeEmbedder());
  self->instance_ = HermesNodeInstance::create(runtime);
  if (!self->instance_)
    return nullptr;
  if (!self->instance_->bootstrap(config)) {
    // Leave the half-initialized instance alive: the runtime may still
    // reference its state from finalizers.
    self->instance_.release();
    self->detached_ = true;
    return nullptr;
  }

  napi_env env = self->instance_->env();
  napi_handle_scope scope;
  napi_open_handle_scope(env, &scope);

  // process.exit() terminates the process in a standalone runtime; in an
  // embedder that would take the host app down with it.
  napi_value script, result;
  napi_create_string_utf8(
      env,
      "process.exit = function exit(code) {\n"
      "  throw new Error('process.exit(' + (code === undefined ? '' : code) +\n"
      "      ') is not available in an embedded hermes-node runtime');\n"
      "};\n"
      "//# sourceURL=hermes-node:embedder\n",
      NAPI_AUTO_LENGTH,
      &script);
  if (napi_run_script(env, script, &result) != napi_ok)
    printAndClearException(env);
  napi_close_handle_scope(env, scope);

  auto bridge = std::make_shared<Bridge>();
  bridge->host = host;
  bridge->instance = self->instance_.get();
  bridge->loop = self->instance_->loop();
  bridge->backendFd = uv_backend_fd(bridge->loop);

  // wakeup() target. Unref'd so it doesn't keep the loop alive by itself.
  uv_async_init(bridge->loop, &bridge->wakeupHandle, [](uv_async_t *) {});
  uv_unref(reinterpret_cast<uv_handle_t *>(&bridge->wakeupHandle));

  // Pick up anything bootstrap scheduled before the bridge runs.
  self->instance_->runOnce();

  bridge->thread = std::thread(&Bridge::threadMain, bridge.get(), bridge);
  self->bridge_ = std::move(bridge);
  return self;
}

napi_status HermesNodeEmbedder::installRequire(const char *globalName) {
  napi_env env = instance_->env();
  napi_handle_scope scope;
  napi_open_handle_scope(env, &scope);
  napi_value global, fn;
  napi_status st = napi_get_global(env, &global);
  if (st == napi_ok)
    st = instance_->createRequireFunction(&fn);
  if (st == napi_ok)
    st = napi_set_named_property(env, global, globalName, fn);
  napi_close_handle_scope(env, scope);
  return st;
}

HermesNodeInstance &HermesNodeEmbedder::instance() {
  return *instance_;
}

void HermesNodeEmbedder::wakeup() {
  if (bridge_ && !detached_)
    uv_async_send(&bridge_->wakeupHandle);
}

void HermesNodeEmbedder::detach() {
  if (detached_)
    return;
  detached_ = true;

  // Stop the bridge thread. A runOnce task it already posted may still be
  // queued on the host; it sees `stop` and does nothing.
  {
    std::lock_guard<std::mutex> lock(bridge_->mutex);
    bridge_->stop = true;
  }
  bridge_->cv.notify_all();
  if (bridge_->thread.joinable())
    bridge_->thread.join();

  uv_close(reinterpret_cast<uv_handle_t *>(&bridge_->wakeupHandle), nullptr);

  instance_->emitExit(0);
  instance_->beginShutdown();
  instance_->finishShutdown();
  instance_->destroyEnv();

  // The runtime is still alive and its finalizers may reach the instance's
  // per-runtime state when it is destroyed, so the instance outlives detach()
  // and is freed with the embedder.
}

} // namespace node_compat
} // namespace hermes

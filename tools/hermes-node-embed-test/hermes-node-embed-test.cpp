/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Exercises HermesNodeEmbedder the way a host like React Native uses it: the
// host owns the runtime and runs its own task queue on the JS thread; Node is
// reached only through the installed require function, and Node's async work
// is delivered back through the host queue.
//
// Usage: hermes-node-embed-test <script.js>
// The script runs with `nodeRequire` and `hostSetTimeout` globals (Node's
// timers and console are not installed) and must call `hostDone(code)`.

#include <hermes/node-compat/runtime/hermes_node_embedder.h>

#include "hermes/Public/RuntimeConfig.h"
#include "hermes/hermes.h"

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <fstream>
#include <functional>
#include <mutex>
#include <sstream>

using namespace hermes::node_compat;
namespace jsi = facebook::jsi;

namespace {

/// The host's JS-thread task queue (stands in for RN's RuntimeScheduler).
class HostQueue {
 public:
  void post(std::function<void()> task) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      tasks_.push_back(std::move(task));
    }
    cv_.notify_one();
  }

  void postAfter(int ms, std::function<void()> task) {
    auto due = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
    std::lock_guard<std::mutex> lock(mutex_);
    timers_.push_back({due, std::move(task)});
    cv_.notify_one();
  }

  /// Run tasks until quit() or the deadline. Returns false on timeout.
  bool run(facebook::hermes::HermesRuntime &rt, int timeoutMs) {
    auto deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    std::unique_lock<std::mutex> lock(mutex_);
    while (!quit_) {
      auto now = std::chrono::steady_clock::now();
      if (now >= deadline)
        return false;
      for (auto it = timers_.begin(); it != timers_.end();) {
        if (it->first <= now) {
          tasks_.push_back(std::move(it->second));
          it = timers_.erase(it);
        } else {
          ++it;
        }
      }
      if (tasks_.empty()) {
        cv_.wait_for(lock, std::chrono::milliseconds(5));
        continue;
      }
      auto task = std::move(tasks_.front());
      tasks_.pop_front();
      lock.unlock();
      task();
      // Like RN: drain microtasks after every host task.
      rt.drainMicrotasks(-1);
      lock.lock();
    }
    return true;
  }

  void quit() {
    std::lock_guard<std::mutex> lock(mutex_);
    quit_ = true;
    cv_.notify_one();
  }

 private:
  std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<std::function<void()>> tasks_;
  std::vector<
      std::pair<std::chrono::steady_clock::time_point, std::function<void()>>>
      timers_;
  bool quit_ = false;
};

} // namespace

int main(int argc, char **argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s <script.js>\n", argv[0]);
    return 2;
  }
  std::ifstream in(argv[1]);
  if (!in) {
    std::fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }
  std::stringstream ss;
  ss << in.rdbuf();
  std::string source = ss.str();

  auto rt = facebook::hermes::makeHermesRuntime(
      hermes::vm::RuntimeConfig::Builder()
          .withMicrotaskQueue(true)
          .withEnableAsyncGenerators(true)
          .withES6BlockScoping(true)
          .build());

  HostQueue queue;

  // Host globals: a print function, a host timer, and a completion hook.
  int exitCode = -1;
  rt->global().setProperty(
      *rt,
      "print",
      jsi::Function::createFromHostFunction(
          *rt,
          jsi::PropNameID::forAscii(*rt, "print"),
          1,
          [](jsi::Runtime &rt,
             const jsi::Value &,
             const jsi::Value *args,
             size_t count) {
            for (size_t i = 0; i < count; ++i)
              std::printf(
                  "%s%s", i ? " " : "", args[i].toString(rt).utf8(rt).c_str());
            std::printf("\n");
            std::fflush(stdout);
            return jsi::Value::undefined();
          }));
  rt->global().setProperty(
      *rt,
      "hostSetTimeout",
      jsi::Function::createFromHostFunction(
          *rt,
          jsi::PropNameID::forAscii(*rt, "hostSetTimeout"),
          2,
          [&queue](
              jsi::Runtime &rt,
              const jsi::Value &,
              const jsi::Value *args,
              size_t count) {
            auto fn = std::make_shared<jsi::Function>(
                args[0].asObject(rt).asFunction(rt));
            int ms = count > 1 ? static_cast<int>(args[1].asNumber()) : 0;
            queue.postAfter(ms, [fn, &rt]() { fn->call(rt); });
            return jsi::Value::undefined();
          }));
  rt->global().setProperty(
      *rt,
      "hostDone",
      jsi::Function::createFromHostFunction(
          *rt,
          jsi::PropNameID::forAscii(*rt, "hostDone"),
          1,
          [&queue, &exitCode](
              jsi::Runtime &,
              const jsi::Value &,
              const jsi::Value *args,
              size_t count) {
            exitCode = count > 0 ? static_cast<int>(args[0].asNumber()) : 0;
            queue.quit();
            return jsi::Value::undefined();
          }));

  HermesNodeEmbedderHost host;
  host.data = &queue;
  host.postToJSThread = [](void *data, void (*fn)(void *), void *arg) {
    static_cast<HostQueue *>(data)->post([fn, arg]() { fn(arg); });
  };

  HermesNodeInstanceConfig config;
  config.argv = {"hermes-node-embed-test", argv[1]};
  config.installGlobals = false;
  config.setupStdio = false;

  auto embedder = HermesNodeEmbedder::attach(*rt, config, host);
  if (!embedder) {
    std::fprintf(stderr, "attach failed\n");
    return 1;
  }
  if (embedder->installRequire("nodeRequire") != napi_ok) {
    std::fprintf(stderr, "installRequire failed\n");
    return 1;
  }

  // Run the script as a host task, like RN evaluating its bundle.
  queue.post([&]() {
    try {
      rt->evaluateJavaScript(
          std::make_shared<jsi::StringBuffer>(source), argv[1]);
    } catch (const jsi::JSIException &e) {
      std::fprintf(stderr, "script error: %s\n", e.what());
      exitCode = 1;
      queue.quit();
    }
  });

  bool finished = queue.run(*rt, 20000);
  if (!finished)
    std::fprintf(stderr, "timed out waiting for hostDone()\n");

  embedder->detach();
  rt.reset();
  embedder.reset();
  return finished ? exitCode : 1;
}

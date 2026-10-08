# Copyright (c) Tzvetan Mikov.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

add_hermes_library(hermesNodeBindings STATIC
  handle_wrap_base.cpp
  libuv_stream_base.cpp
  node_async_context_frame.cpp
  node_async_wrap.cpp
  node_buffer.cpp
  node_cares_wrap.cpp
  node_config.cpp
  node_constants.cpp
  node_contextify.cpp
  node_crypto.cpp
  node_credentials.cpp
  node_encoding.cpp
  node_errors.cpp
  node_file.cpp
  node_http_parser.cpp
  node_module_wrap.cpp
  node_modules.cpp
  node_file_dir.cpp
  node_os.cpp
  node_pipe_wrap.cpp
  node_process_wrap.cpp
  node_spawn_sync.cpp
  node_fs_event_wrap.cpp
  node_stdio.cpp
  node_stream_wrap.cpp
  node_tcp_wrap.cpp
  node_udp_wrap.cpp
  node_string_decoder.cpp
  node_symbols.cpp
  node_task_queue.cpp
  node_timers.cpp
  node_tls.cpp
  node_trace_events.cpp
  node_tty_wrap.cpp
  node_types.cpp
  node_url.cpp
  node_util.cpp
  node_uv.cpp
  node_zlib.cpp
)

target_include_directories(hermesNodeBindings
  PUBLIC
    ${PROJECT_SOURCE_DIR}/include
  PRIVATE
    ${PROJECT_SOURCE_DIR}/hermes/include/hermes/napi
    ${PROJECT_SOURCE_DIR}/hermes/include
    ${PROJECT_SOURCE_DIR}/hermes/API
)

target_link_libraries(hermesNodeBindings
  PUBLIC
    uv_a
  PRIVATE
    simdutf
    ada
    cares_a
    llhttp_a
    picohash
    zlib_a
    brotli_a
    zstd_a
)

# OpenSSL for the TLS binding. Located via find_package so a vendored build can
# override it by setting OPENSSL_ROOT_DIR.
#
# Static by default: the resulting hermes-node is distributed as a standalone
# binary (and on macOS has application bytecode injected into it), so a
# dependency on a dylib from the build machine's package manager would make it
# unrunnable anywhere else. Set HERMES_NODE_OPENSSL_STATIC=OFF for a
# development build against the shared libraries.
option(HERMES_NODE_OPENSSL_STATIC
  "Link OpenSSL statically so the binary is self-contained" ON)

if(HERMES_NODE_OPENSSL_STATIC)
  set(OPENSSL_USE_STATIC_LIBS ON)
endif()

find_package(OpenSSL REQUIRED)
target_link_libraries(hermesNodeBindings PRIVATE OpenSSL::SSL OpenSSL::Crypto)

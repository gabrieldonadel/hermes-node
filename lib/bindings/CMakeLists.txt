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

if(APPLE)
  # Security.framework supplies the system trust anchors; OpenSSL's
  # compiled-in OPENSSLDIR is useless in a relocated binary.
  target_link_libraries(hermesNodeBindings PRIVATE
    "-framework Security" "-framework CoreFoundation")
endif()

# Optional CA bundle compiled into the binary.
#
# A distributable build needs one. OpenSSL resolves its default trust store
# from a path fixed when OpenSSL itself was built (OPENSSLDIR), which will not
# exist on an end user's machine, and the macOS keychain APIs are not reliably
# reachable (errSecNotAvailable in a headless or sandboxed process). Without a
# bundle, certificate verification fails with "unable to get local issuer
# certificate" everywhere except the machine that built it.
#
# Deliberately not vendored: which roots to trust, and keeping them current,
# is a policy decision for whoever ships the binary. Pass e.g. curl's
# cacert.pem (https://curl.se/ca/cacert.pem).
set(HERMES_NODE_CA_BUNDLE "" CACHE FILEPATH
  "PEM bundle of trusted roots to compile into the binary")

if(HERMES_NODE_CA_BUNDLE)
  if(NOT EXISTS "${HERMES_NODE_CA_BUNDLE}")
    message(FATAL_ERROR
      "HERMES_NODE_CA_BUNDLE does not exist: ${HERMES_NODE_CA_BUNDLE}")
  endif()
  set(_hn_ca_src "${CMAKE_CURRENT_BINARY_DIR}/ca_bundle.cpp")
  add_custom_command(
    OUTPUT "${_hn_ca_src}"
    COMMAND ${CMAKE_COMMAND}
      -DIN_FILE=${HERMES_NODE_CA_BUNDLE}
      -DOUT_FILE=${_hn_ca_src}
      -P ${PROJECT_SOURCE_DIR}/cmake/EmbedCaBundle.cmake
    DEPENDS "${HERMES_NODE_CA_BUNDLE}"
            "${PROJECT_SOURCE_DIR}/cmake/EmbedCaBundle.cmake"
    COMMENT "Embedding CA bundle ${HERMES_NODE_CA_BUNDLE}")
  target_sources(hermesNodeBindings PRIVATE "${_hn_ca_src}")
  target_compile_definitions(hermesNodeBindings PRIVATE
    HERMES_NODE_EMBEDDED_CA_BUNDLE)
endif()

# A universal build needs an OpenSSL that carries every requested slice.
# Homebrew's is single-architecture, so a macos-universal build against it
# fails at link time with an "undefined symbols for architecture" wall that
# does not name the real cause. Check up front and say what is wrong.
#
# The fix is either an OpenSSL built for both architectures, or -- simpler --
# building each architecture separately against its own OpenSSL and joining
# them with `lipo -create` at the end.
if(APPLE AND CMAKE_OSX_ARCHITECTURES)
  list(LENGTH CMAKE_OSX_ARCHITECTURES _hn_arch_count)
  if(_hn_arch_count GREATER 1)
    execute_process(
      COMMAND lipo -info "${OPENSSL_CRYPTO_LIBRARY}"
      OUTPUT_VARIABLE _hn_ssl_lipo
      ERROR_QUIET
      OUTPUT_STRIP_TRAILING_WHITESPACE)
    foreach(_hn_arch IN LISTS CMAKE_OSX_ARCHITECTURES)
      if(NOT _hn_ssl_lipo MATCHES "${_hn_arch}")
        message(FATAL_ERROR
          "Requested CMAKE_OSX_ARCHITECTURES='${CMAKE_OSX_ARCHITECTURES}' but "
          "the OpenSSL at ${OPENSSL_CRYPTO_LIBRARY} does not provide "
          "'${_hn_arch}'.\n  lipo -info reports: ${_hn_ssl_lipo}\n"
          "Provide a universal OpenSSL (OPENSSL_ROOT_DIR), or build each "
          "architecture separately and combine them with 'lipo -create'.")
      endif()
    endforeach()
  endif()
endif()

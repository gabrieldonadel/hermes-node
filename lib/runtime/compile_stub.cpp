/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Linked instead of Hermes's hermesNapiCompile when hermes-node is embedded
// in a host that ships its own Hermes (e.g. React Native's hermesvm
// framework), which doesn't export the source-to-bytecode compiler. Only
// vm.Script / vm.runInContext need it; everything else keeps working.

#include "napi/hermes_napi_compile.h"

napi_status hermes_compile_to_bytecode(
    napi_env env,
    const uint8_t * /*source*/,
    size_t /*source_length*/,
    const char * /*source_url*/,
    const hermes_compile_flags * /*flags*/,
    uint8_t **bytecode,
    size_t *bytecode_length) {
  if (bytecode)
    *bytecode = nullptr;
  if (bytecode_length)
    *bytecode_length = 0;
  napi_throw_error(
      env,
      "ERR_HERMES_NODE_NO_COMPILER",
      "Compiling to bytecode is not available in embedded hermes-node");
  return napi_pending_exception;
}

void hermes_free_bytecode(uint8_t *bytecode) {
  (void)bytecode;
}

# Copyright (c) Tzvetan Mikov.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

add_hermes_tool(hermes-node-embed-test
  hermes-node-embed-test.cpp
  LINK_LIBS
    hermesNodeRuntime
)

# The test host catches jsi::JSIError from evaluateJavaScript.
target_compile_options(hermes-node-embed-test PRIVATE -fexceptions)

target_include_directories(hermes-node-embed-test PRIVATE
  ${PROJECT_SOURCE_DIR}/hermes/API
  ${PROJECT_SOURCE_DIR}/hermes/public
)

if(APPLE)
  target_link_libraries(hermes-node-embed-test -force_load hermesNapi)
elseif(MSVC)
  target_link_libraries(hermes-node-embed-test hermesNapi)
  target_link_options(hermes-node-embed-test PRIVATE /WHOLEARCHIVE:hermesNapi)
else()
  target_link_libraries(hermes-node-embed-test
    -Wl,--whole-archive
    hermesNapi
    -Wl,--no-whole-archive
  )
endif()

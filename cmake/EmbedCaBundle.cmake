# Copyright (c) Tzvetan Mikov.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# Turn a PEM CA bundle into a C++ source file defining
#   kHermesNodeCaBundle / kHermesNodeCaBundleLen
#
# Run as: cmake -DIN_FILE=<cacert.pem> -DOUT_FILE=<out.cpp> -P EmbedCaBundle.cmake
#
# Emitted as an unsigned char array rather than a string literal: a bundle of
# this size exceeds the maximum string literal length some compilers accept,
# and the file contains non-ASCII bytes (UTF-8 in the comments) that do not
# fit in a signed char.

if(NOT IN_FILE OR NOT OUT_FILE)
  message(FATAL_ERROR "IN_FILE and OUT_FILE are both required")
endif()

file(READ "${IN_FILE}" _hex HEX)
string(LENGTH "${_hex}" _hex_len)
math(EXPR _byte_count "${_hex_len} / 2")

if(_byte_count EQUAL 0)
  message(FATAL_ERROR "CA bundle is empty: ${IN_FILE}")
endif()

set(_body "")
set(_i 0)
set(_col 0)
while(_i LESS _hex_len)
  string(SUBSTRING "${_hex}" ${_i} 2 _byte)
  string(APPEND _body "0x${_byte},")
  math(EXPR _col "${_col} + 1")
  if(_col EQUAL 16)
    string(APPEND _body "\n  ")
    set(_col 0)
  endif()
  math(EXPR _i "${_i} + 2")
endwhile()

file(WRITE "${OUT_FILE}"
"// AUTO-GENERATED from ${IN_FILE}. DO NOT EDIT.
//
// Trusted roots compiled into the binary so certificate verification does not
// depend on a path fixed when OpenSSL was built.

extern \"C\" {

// Both definitions need an explicit 'extern'. A const object at namespace
// scope has internal linkage in C++ by default, and extern \"C\" only changes
// name mangling, not linkage -- without this the symbols are not exported and
// the link fails with \"symbol(s) not found\".

// NUL-terminated so it can be handed to BIO_new_mem_buf as text.
extern const unsigned char kHermesNodeCaBundle[];
extern const unsigned kHermesNodeCaBundleLen;

const unsigned char kHermesNodeCaBundle[] = {
  ${_body}0x00
};

const unsigned kHermesNodeCaBundleLen = ${_byte_count}u;

}
")

message(STATUS "Embedded CA bundle: ${_byte_count} bytes from ${IN_FILE}")

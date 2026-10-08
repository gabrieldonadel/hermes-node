/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <hermes/node-compat/runtime/embedded_blob.h>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#include <mach-o/getsect.h>
#endif

// postject refuses to inject into a binary that does not already contain this
// sentinel, and flips the trailing ":0" to ":1" when it does. Node carries the
// same string for the same reason. It must survive optimization and stripping,
// hence `used` and `volatile`.
//
// The flag itself is not what we read to detect a blob -- getsectiondata is
// authoritative and cannot disagree with reality -- but the sentinel has to be
// present for the injection step to run at all.
extern "C" {
__attribute__((used)) volatile const char kPostjectSentinel[] =
    "POSTJECT_SENTINEL_fce680ab2cc467b6e072b8b5df1996b2:0";
}

namespace hermes {
namespace node_compat {

#if defined(__APPLE__)

// Provided by the linker for the main executable's Mach-O header.
extern "C" {
#if defined(__LP64__)
extern const struct mach_header_64 _mh_execute_header;
#else
extern const struct mach_header _mh_execute_header;
#endif
}

bool findEmbeddedBlob(const uint8_t **data, size_t *size) {
  unsigned long sectionSize = 0;
  // getsectiondata resolves against the slice of the fat binary that is
  // actually loaded, so this works unchanged for a universal build.
  const uint8_t *section = getsectiondata(
      &_mh_execute_header,
      kEmbeddedBlobSegment,
      kEmbeddedBlobSection,
      &sectionSize);
  if (!section || sectionSize == 0)
    return false;

  *data = section;
  *size = static_cast<size_t>(sectionSize);
  return true;
}

#elif defined(__linux__)

// On ELF, postject injects a note section and defines these symbols. They are
// declared weak so a binary with no blob still links.
extern "C" {
extern const uint8_t
    __start_hnode_blob[] __attribute__((weak));
extern const uint8_t __stop_hnode_blob[] __attribute__((weak));
}

bool findEmbeddedBlob(const uint8_t **data, size_t *size) {
  if (!__start_hnode_blob || !__stop_hnode_blob)
    return false;
  if (__stop_hnode_blob <= __start_hnode_blob)
    return false;

  *data = __start_hnode_blob;
  *size = static_cast<size_t>(__stop_hnode_blob - __start_hnode_blob);
  return true;
}

#else

bool findEmbeddedBlob(const uint8_t **, size_t *) {
  return false;
}

#endif

} // namespace node_compat
} // namespace hermes

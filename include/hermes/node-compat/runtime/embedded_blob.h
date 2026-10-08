/*
 * Copyright (c) Tzvetan Mikov.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <cstddef>
#include <cstdint>

namespace hermes {
namespace node_compat {

/// Segment and section names for an embedded bytecode blob.
///
/// A blob is injected into an already-linked `hermes-node` binary to produce a
/// self-contained executable: one file that carries both the runtime and the
/// application bytecode, the way `pkg` does for Node.
///
/// The blob lives in a real Mach-O section rather than being appended past the
/// end of the file. On macOS the code signature is covered by a load command
/// and sits at the end of __LINKEDIT, so trailing data added after signing
/// invalidates it; a section is part of the image proper and survives both
/// `strip` and re-signing. `postject` writes this layout, which is also what
/// Node's single-executable support uses.
constexpr const char *kEmbeddedBlobSegment = "HNODE_SEA";
// Note the leading underscores: postject writes the section with a "__"
// prefix (the Mach-O convention), so the name passed on its command line is
// "hnode_blob" while the section in the image is "__hnode_blob".
constexpr const char *kEmbeddedBlobSection = "__hnode_blob";

/// Locate bytecode embedded in the running executable.
///
/// Returns true and sets \p data / \p size when a blob is present. Returns
/// false on platforms without support or when the binary carries no blob,
/// which is the normal case for a plain `hermes-node` install.
bool findEmbeddedBlob(const uint8_t **data, size_t *size);

} // namespace node_compat
} // namespace hermes

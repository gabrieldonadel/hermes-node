#!/usr/bin/env bash
# Build hermes-node as a single static library for embedding in an Apple app
# that already ships Hermes (e.g. React Native's hermesvm.framework built from
# the same facebook/hermes commit as the `hermes` submodule).
#
# The library contains hermes-node and its vendored dependencies but no
# Hermes code: Node-API and JSI symbols resolve against the host's Hermes.
# The embedded Node modules are Hermes bytecode, so the host's Hermes must
# match the submodule's bytecode version.
#
# Usage: utils/build-apple-embed-lib.sh <out-dir> [build-dir]
#   ARCHS (default: arm64), DEPLOYMENT_TARGET (default: 13.0),
#   BUILD_TYPE (default: Release)

set -euo pipefail

OUT=${1:?usage: $0 <out-dir> [build-dir]}
SRC=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${2:-$SRC/build-apple-embed}
ARCHS=${ARCHS:-arm64}
DEPLOYMENT_TARGET=${DEPLOYMENT_TARGET:-13.0}
BUILD_TYPE=${BUILD_TYPE:-Release}

OPENSSL_ROOT_DIR=${OPENSSL_ROOT_DIR:-$(brew --prefix openssl@3 2>/dev/null || true)}

cmake -S "$SRC" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
  ${OPENSSL_ROOT_DIR:+-DOPENSSL_ROOT_DIR="$OPENSSL_ROOT_DIR"} \
  -DCMAKE_OSX_ARCHITECTURES="$ARCHS" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET"
cmake --build "$BUILD" --target hermesNodeRuntime hermesNodeCompileStub

LIBS=$(cd "$BUILD" && find . -name '*.a' -not -path './hermes/*' | sort)
# The TLS binding links OpenSSL statically; fold it in too.
OPENSSL_LIBS=$(grep -E '^OPENSSL_(SSL|CRYPTO)_LIBRARY:FILEPATH=' "$BUILD/CMakeCache.txt" | cut -d= -f2-)
mkdir -p "$OUT/lib" "$OUT/include"
(cd "$BUILD" && libtool -static -no_warning_for_no_symbols \
  -o "$OUT/lib/libhermes-node-embed.a" $LIBS $OPENSSL_LIBS)

# Public headers: hermes-node's, plus the Node-API and libuv headers they use.
rsync -a --delete "$SRC/include/hermes/" "$OUT/include/hermes/"
rsync -a "$SRC/hermes/include/hermes/napi/" "$OUT/include/"
rsync -a "$SRC/external/libuv/libuv/include/" "$OUT/include/"

echo "Wrote $OUT/lib/libhermes-node-embed.a"
echo "Link with: -lc++ -lresolv -framework CoreFoundation -framework Security"

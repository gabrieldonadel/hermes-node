#!/usr/bin/env bash
# Build hermes-node as a single static library for embedding in an Apple app
# that already ships Hermes (e.g. React Native's hermesvm.framework built from
# the same facebook/hermes commit as the `hermes` submodule).
#
# The library contains hermes-node and its vendored dependencies (including a
# static OpenSSL) but no Hermes code: Node-API and JSI symbols resolve against
# the host's Hermes. The embedded Node modules are Hermes bytecode, so the
# host's Hermes must match the submodule's bytecode version.
#
# Output layout:
#   <out>/lib/libhermes-node-embed.a   one slice per entry in ARCHS
#   <out>/include/                     hermes-node, Node-API, libuv, Hermes API
#                                      and JSI headers
#   <out>/bin/hermesc                  host compiler matching the submodule,
#                                      for precompiling app JS to bytecode
#   <out>/bin/wrap-cjs.py              wraps a CJS file for hermesc
#   <out>/hermes-commit                the submodule commit the above match
#
# Usage: utils/build-apple-embed-lib.sh <out-dir> [build-dir]
#   ARCHS (default: "arm64 x86_64"), DEPLOYMENT_TARGET (default: 13.0),
#   BUILD_TYPE (default: Release),
#   OPENSSL_ROOT_<arch> (e.g. OPENSSL_ROOT_arm64): a static OpenSSL for that
#   architecture; built from source with utils/build-openssl-apple.sh if unset.
#
# Link with: -lc++ -lresolv -framework CoreFoundation -framework Security

set -euo pipefail

OUT=${1:?usage: $0 <out-dir> [build-dir]}
SRC=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${2:-$SRC/build-apple-embed}
ARCHS=${ARCHS:-arm64 x86_64}
DEPLOYMENT_TARGET=${DEPLOYMENT_TARGET:-13.0}
BUILD_TYPE=${BUILD_TYPE:-Release}

mkdir -p "$OUT" "$BUILD"
OUT=$(cd "$OUT" && pwd)
BUILD=$(cd "$BUILD" && pwd)

HOST_ARCH=$(uname -m)
SLICES=()
for ARCH in $ARCHS; do
  ssl_var="OPENSSL_ROOT_$ARCH"
  SSL=${!ssl_var:-}
  if [[ -z "$SSL" ]]; then
    SSL="$BUILD/openssl-$ARCH"
    DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" "$SRC/utils/build-openssl-apple.sh" "$ARCH" "$SSL"
  fi

  dir="$BUILD/$ARCH"
  echo "==> hermes-node $ARCH (OpenSSL: $SSL)"
  cmake -S "$SRC" -B "$dir" -G Ninja \
    -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
    -DCMAKE_OSX_ARCHITECTURES="$ARCH" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" \
    -DOPENSSL_ROOT_DIR="$SSL" \
    -DOPENSSL_USE_STATIC_LIBS=ON \
    -DOPENSSL_SSL_LIBRARY="$SSL/lib/libssl.a" \
    -DOPENSSL_CRYPTO_LIBRARY="$SSL/lib/libcrypto.a" \
    -DOPENSSL_INCLUDE_DIR="$SSL/include" >/dev/null
  targets=(hermesNodeRuntime hermesNodeCompileStub)
  if [[ "$ARCH" == "$HOST_ARCH" ]]; then
    targets+=(hermesc)
  fi
  cmake --build "$dir" --target "${targets[@]}"

  libs=$(cd "$dir" && find . -name '*.a' -not -path './hermes/*' | sort)
  (cd "$dir" && libtool -static -no_warning_for_no_symbols \
    -o "$dir/libhermes-node-embed.a" $libs "$SSL/lib/libssl.a" "$SSL/lib/libcrypto.a")
  SLICES+=("$dir/libhermes-node-embed.a")

  if [[ "$ARCH" == "$HOST_ARCH" ]]; then
    mkdir -p "$OUT/bin"
    cp "$dir/bin/hermesc" "$OUT/bin/hermesc"
  fi
done

mkdir -p "$OUT/lib" "$OUT/include"
lipo -create "${SLICES[@]}" -output "$OUT/lib/libhermes-node-embed.a"

# Public headers: hermes-node's, plus the Node-API and libuv headers they use,
# plus Hermes's public API and JSI for hosts that create the runtime
# themselves (makeHermesRuntime).
rsync -a --delete "$SRC/include/hermes/" "$OUT/include/hermes/"
rsync -a "$SRC/hermes/include/hermes/napi/" "$OUT/include/"
rsync -a "$SRC/external/libuv/libuv/include/" "$OUT/include/"
rsync -a --include='*.h' --exclude='*' "$SRC/hermes/API/hermes/" "$OUT/include/hermes/"
rsync -a "$SRC/hermes/public/hermes/Public/" "$OUT/include/hermes/Public/"
mkdir -p "$OUT/include/jsi"
rsync -a --include='*.h' --exclude='*' "$SRC/hermes/API/jsi/jsi/" "$OUT/include/jsi/"

mkdir -p "$OUT/bin"
cp "$SRC/tools/wrap-cjs.py" "$OUT/bin/wrap-cjs.py"
git -C "$SRC/hermes" rev-parse HEAD > "$OUT/hermes-commit"

echo "Wrote $OUT/lib/libhermes-node-embed.a ($(lipo -archs "$OUT/lib/libhermes-node-embed.a"))"
[[ -x "$OUT/bin/hermesc" ]] || echo "warning: no hermesc built (host arch $HOST_ARCH not in ARCHS)" >&2

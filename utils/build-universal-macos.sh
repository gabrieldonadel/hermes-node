#!/usr/bin/env bash
#
# Build a macOS universal hermes-node.
#
# Why this is not just CMAKE_OSX_ARCHITECTURES="arm64;x86_64": linking OpenSSL
# statically requires a library carrying every slice, and the usual
# installations (Homebrew in particular) are single-architecture. Rather than
# require a universal OpenSSL, build each architecture against its own and
# join the results with `lipo -create`.
#
# Usage:
#   utils/build-universal-macos.sh \
#     --openssl-arm64 /opt/homebrew/opt/openssl@3 \
#     --openssl-x86_64 /path/to/openssl-x86_64 \
#     [--out build-universal/hermes-node]
#
# An OpenSSL for the non-native architecture can be produced from the upstream
# tarball with:
#
#   ./Configure darwin64-x86_64-cc no-shared no-tests no-docs \
#       --prefix=/path/to/openssl-x86_64
#   make -j8 build_libs && make install_dev

set -euo pipefail

SSL_ARM64=""
SSL_X64=""
CA_BUNDLE=""
OUT="build-universal/hermes-node"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --openssl-arm64) SSL_ARM64="$2"; shift 2 ;;
    --openssl-x86_64) SSL_X64="$2"; shift 2 ;;
    --ca-bundle) CA_BUNDLE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SSL_ARM64" || -z "$SSL_X64" ]]; then
  echo "--openssl-arm64 and --openssl-x86_64 are both required" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Sets SLICE_BIN to the built binary's path. Returning it on stdout would mean
# capturing stdout, which also swallows the build log.
SLICE_BIN=""
build_slice() {
  local arch="$1"
  local ssl_root="$2"
  local dir="build-$arch"

  echo "==> configuring $arch (OpenSSL: $ssl_root)"
  local ca_arg=()
  if [[ -n "$CA_BUNDLE" ]]; then
    ca_arg=(-DHERMES_NODE_CA_BUNDLE="$CA_BUNDLE")
  fi
  cmake -B "$dir" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$arch" \
    -DOPENSSL_ROOT_DIR="$ssl_root" \
    -DOPENSSL_USE_STATIC_LIBS=ON \
    -DOPENSSL_SSL_LIBRARY="$ssl_root/lib/libssl.a" \
    -DOPENSSL_CRYPTO_LIBRARY="$ssl_root/lib/libcrypto.a" \
    -DOPENSSL_INCLUDE_DIR="$ssl_root/include" \
    "${ca_arg[@]+"${ca_arg[@]}"}"

  echo "==> building $arch"
  cmake --build "$dir" --target hermes-node

  local bin="$dir/bin/hermes-node"
  local got
  got="$(lipo -info "$bin" | sed 's/.*architecture: //')"
  if [[ "$got" != "$arch" ]]; then
    echo "expected $arch, built $got" >&2
    exit 1
  fi
  SLICE_BIN="$bin"
}

build_slice arm64 "$SSL_ARM64"
arm_bin="$SLICE_BIN"
build_slice x86_64 "$SSL_X64"
x64_bin="$SLICE_BIN"

mkdir -p "$(dirname "$OUT")"
echo "==> combining"
lipo -create -output "$OUT" "$arm_bin" "$x64_bin"

# Strip before signing: any modification after signing invalidates the
# signature, and the blob injection that follows has the same constraint.
#
# -x removes local symbols only. A plain `strip` also discards the global
# symbol table, which takes the exported NAPI symbols with it -- a dlopen'd
# Node-API addon then fails with "symbol not found in flat namespace
# '_napi_add_finalizer'". -x keeps all 283 of them and still saves ~2 MB.
strip -x "$OUT" 2>/dev/null || true
codesign --sign - --force --options runtime --timestamp=none "$OUT"

echo
lipo -info "$OUT"
codesign --verify --strict "$OUT" && echo "signature valid"
ls -la "$OUT" | awk '{printf "size: %.1f MB\n", $5/1048576}'

for arch in arm64 x86_64; do
  printf 'smoke %s: ' "$arch"
  arch -"$arch" "$OUT" -e 'console.log("ok", process.arch)' 2>&1 | tail -1
done

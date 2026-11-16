#!/usr/bin/env bash
# Build a static OpenSSL for one macOS architecture at a fixed deployment
# target, for linking into hermes-node (Homebrew's is single-arch and targets
# the build host's macOS).
#
# Usage: utils/build-openssl-apple.sh <arm64|x86_64> <prefix>
#   OPENSSL_VERSION (default 3.5.4), DEPLOYMENT_TARGET (default 13.0)
set -euo pipefail

ARCH=${1:?usage: $0 <arm64|x86_64> <prefix>}
PREFIX=${2:?usage: $0 <arm64|x86_64> <prefix>}
VERSION=${OPENSSL_VERSION:-3.5.4}
DEPLOYMENT_TARGET=${DEPLOYMENT_TARGET:-13.0}

if [[ -f "$PREFIX/lib/libcrypto.a" && -f "$PREFIX/.built-$VERSION-$DEPLOYMENT_TARGET" ]]; then
  echo "OpenSSL $VERSION ($ARCH) already in $PREFIX"
  exit 0
fi

case "$ARCH" in
  arm64) TARGET=darwin64-arm64-cc ;;
  x86_64) TARGET=darwin64-x86_64-cc ;;
  *) echo "unknown arch $ARCH" >&2; exit 1 ;;
esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
curl -fsSL "https://github.com/openssl/openssl/releases/download/openssl-$VERSION/openssl-$VERSION.tar.gz" \
  | tar xz -C "$WORK"
cd "$WORK/openssl-$VERSION"
./Configure "$TARGET" no-shared no-tests no-docs no-apps \
  -mmacosx-version-min="$DEPLOYMENT_TARGET" --prefix="$PREFIX" --libdir=lib >/dev/null
make -j"$(sysctl -n hw.ncpu)" build_libs >/dev/null
make install_dev >/dev/null
touch "$PREFIX/.built-$VERSION-$DEPLOYMENT_TARGET"
echo "OpenSSL $VERSION ($ARCH, macOS $DEPLOYMENT_TARGET) -> $PREFIX"

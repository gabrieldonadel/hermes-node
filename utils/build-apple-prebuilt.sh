#!/usr/bin/env bash
# Build the prebuilt artifacts a React Native macOS app needs to run Node code
# on its own Hermes through hermes-node, so the app doesn't compile Hermes or
# hermes-node itself:
#
#   hermes-engine-macos-debug.tar.gz    hermesvm.framework (universal; Debug
#   hermes-engine-macos-release.tar.gz  has the debugger), hermesc, the public
#                                       headers and the JSI sources Hermes was
#                                       built with. The layout React Native's
#                                       hermes-engine podspec takes through
#                                       HERMES_ENGINE_TARBALL_PATH (destroot/),
#                                       plus jsi/ for the app to compile
#                                       against.
#   hermes-node-embed-macos.tar.gz      utils/build-apple-embed-lib.sh's output
#   SHA256SUMS
#
# Everything is built from this checkout and its `hermes` submodule, so the
# artifacts are identified by this repository's commit (see
# .github/workflows/apple-prebuilt.yml, which publishes them as the release
# prebuilt-<commit>).
#
# The Hermes configuration mirrors React Native's
# sdks/hermes-engine/utils/build-apple-framework.sh (configure_apple_framework)
# for macOS: Release/MinSizeRel for the Debug/Release flavors, debugger only in
# Debug, Intl, an Apple framework with JSI linked in.
#
# Usage: utils/build-apple-prebuilt.sh <out-dir> [build-dir]
#   DEPLOYMENT_TARGET (default 13.0), RN_HERMES_VERSION (the version string
#   React Native expects, default 250829098.0.4)

set -euo pipefail

OUT=${1:?usage: $0 <out-dir> [build-dir]}
SRC=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${2:-$SRC/build-apple-prebuilt}
DEPLOYMENT_TARGET=${DEPLOYMENT_TARGET:-13.0}
RN_HERMES_VERSION=${RN_HERMES_VERSION:-250829098.0.4}
HERMES="$SRC/hermes"
JOBS=$(sysctl -n hw.ncpu)

mkdir -p "$OUT" "$BUILD"
OUT=$(cd "$OUT" && pwd)
BUILD=$(cd "$BUILD" && pwd)

echo "==> host hermesc"
cmake -S "$HERMES" -B "$BUILD/host" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DJSI_DIR="$HERMES/API/jsi" >/dev/null
cmake --build "$BUILD/host" --target hermesc

for flavor in Debug Release; do
  echo "==> hermesvm.framework ($flavor)"
  dir="$BUILD/hermes-$flavor"
  if [[ "$flavor" == "Debug" ]]; then
    debugger=true
    build_type=Release
  else
    debugger=false
    build_type=MinSizeRel
  fi
  cmake -S "$HERMES" -B "$dir" -G Ninja \
    -DHERMES_APPLE_TARGET_PLATFORM:STRING=macosx \
    -DCMAKE_OSX_ARCHITECTURES:STRING="x86_64;arm64" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET:STRING="$DEPLOYMENT_TARGET" \
    -DHERMES_ENABLE_DEBUGGER:BOOLEAN="$debugger" \
    -DHERMES_ENABLE_INTL:BOOLEAN=true \
    -DHERMES_ENABLE_LIBFUZZER:BOOLEAN=false \
    -DHERMES_ENABLE_FUZZILLI:BOOLEAN=false \
    -DHERMES_ENABLE_TEST_SUITE:BOOLEAN=false \
    -DHERMES_ENABLE_BITCODE:BOOLEAN=false \
    -DHERMES_BUILD_APPLE_FRAMEWORK:BOOLEAN=true \
    -DHERMES_BUILD_SHARED_JSI:BOOLEAN=false \
    -DCMAKE_CXX_FLAGS:STRING="-gdwarf" \
    -DCMAKE_C_FLAGS:STRING="-gdwarf" \
    -DIMPORT_HOST_COMPILERS:PATH="$BUILD/host/ImportHostCompilers.cmake" \
    -DJSI_DIR="$HERMES/API/jsi" \
    -DHERMES_RELEASE_VERSION="for RN $RN_HERMES_VERSION" \
    -DCMAKE_BUILD_TYPE="$build_type" >/dev/null
  cmake --build "$dir" --target hermesvm hermesc -j "$JOBS"

  stage="$BUILD/stage-$flavor"
  rm -rf "$stage"
  mkdir -p "$stage/destroot/Library/Frameworks/macosx" "$stage/destroot/bin" \
    "$stage/destroot/include/hermes/Public" "$stage/destroot/include/hermes/cdp" \
    "$stage/destroot/include/jsi" "$stage/jsi"
  cp -R "$dir/lib/hermesvm.framework" "$stage/destroot/Library/Frameworks/macosx/"
  cp "$dir/bin/hermesc" "$stage/destroot/bin/"
  cp "$HERMES"/public/hermes/Public/*.h "$stage/destroot/include/hermes/Public/"
  cp "$HERMES"/API/hermes/*.h "$stage/destroot/include/hermes/"
  cp "$HERMES"/API/hermes/cdp/*.h "$stage/destroot/include/hermes/cdp/"
  cp "$HERMES"/API/jsi/jsi/*.h "$stage/destroot/include/jsi/"
  cp -R "$HERMES/API/jsi/jsi/." "$stage/jsi/"
  cp "$HERMES/LICENSE" "$stage/"
  lower=$(echo "$flavor" | tr '[:upper:]' '[:lower:]')
  # Three top-level entries: CocoaPods flattens a tarball with a single root
  # directory, which would lose destroot/.
  tar -czf "$OUT/hermes-engine-macos-$lower.tar.gz" -C "$stage" destroot jsi LICENSE
done

echo "==> hermes-node embed library"
"$SRC/utils/build-apple-embed-lib.sh" "$BUILD/embed-out" "$BUILD/embed"
tar -czf "$OUT/hermes-node-embed-macos.tar.gz" -C "$BUILD/embed-out" .

(cd "$OUT" && shasum -a 256 *.tar.gz > SHA256SUMS)
ls -la "$OUT"

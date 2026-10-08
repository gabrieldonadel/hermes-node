(function(exports, require, module, __filename, __dirname) {// Copyright (c) Tzvetan Mikov.
//
// Stub for internal/streams/fast-utf8-stream.
//
// Node's implementation is built on SharedArrayBuffer + Atomics.wait (for its
// synchronous-flush path), neither of which Hermes provides. The module cannot
// work here as written.
//
// It still has to *load*, though. fs.js exposes it through a getter:
//
//   get Utf8Stream() { lazyLoadUtf8Stream(); return Utf8Stream; }
//
// so merely enumerating or spreading the `fs` module -- which graceful-fs,
// fs-extra and plain `{...fs}` all do -- evaluates the getter. Letting the
// require() throw turns any such enumeration into a hard failure far from the
// actual cause. Instead, follow the same pattern as the tls/https stubs: load
// cleanly, throw only on real use.
'use strict';

function notImplemented() {
  throw new Error(
    'fs.Utf8Stream is not supported (requires SharedArrayBuffer and ' +
      'Atomics, which Hermes does not provide)'
  );
}

class Utf8Stream {
  constructor() {
    notImplemented();
  }
}

module.exports = Utf8Stream;
module.exports.Utf8Stream = Utf8Stream;
module.exports.default = Utf8Stream;

});
//# sourceURL=internal/streams/fast-utf8-stream

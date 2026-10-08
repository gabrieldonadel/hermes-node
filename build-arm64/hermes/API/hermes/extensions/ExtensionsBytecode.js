/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// header.js + footer.js wraps around extension JS files to create a local scope
// so that local variables / functions defined within cannot be modified by users.
// The IIFE returns an object with setup functions keyed by extension name.
(function() {
  'use strict';
  var extensions = {};
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// TextEncoder extension setup function.
// Receives native helper functions and installs TextEncoder globally.
  extensions.TextEncoder = function(nativeInit, nativeEncode, nativeEncodeInto) {
    function TextEncoder() {
      if (!new.target) {
        throw new TypeError('TextEncoder must be called as a constructor');
      }
      nativeInit(this);
    }

    Object.defineProperty(TextEncoder.prototype, 'encoding', {
      get: function() {
        return 'utf-8';
      },
      enumerable: true,
      configurable: true
    });

    TextEncoder.prototype.encode = nativeEncode;
    TextEncoder.prototype.encodeInto = nativeEncodeInto;

    Object.defineProperty(TextEncoder.prototype, Symbol.toStringTag, {
      value: 'TextEncoder',
      writable: false,
      enumerable: false,
      configurable: true
    });

    globalThis.TextEncoder = TextEncoder;
  };
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Worker extension setup function.
// Receives native helper functions and installs Worker globally.
extensions.Worker = function(nativeInit, nativeTerminate, nativePostMessage) {
    class Worker {
        constructor(script) {
            nativeInit(this, script);
        }
        terminate() {
            return nativeTerminate.call(this);
        }
        postMessage(...args) {
            return nativePostMessage.call(this, ...args);
        }
    }

    globalThis.Worker = Worker;
};
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Dummy extension for testing precompiled extension system.
// Does nothing - just validates the multi-extension architecture.
  extensions.Dummy = function() {
    // No-op
  };
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// ContribDummy extension - example community contribution.
// Does nothing - serves as a template for contrib extensions.
  extensions.ContribDummy = function() {
    // No-op
  };
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// TextDecoder extension setup function.
// Receives native helper functions and installs TextDecoder globally.
  extensions.TextDecoder = function(nativeInit, nativeDecode, nativeGetEncoding, nativeGetFatal, nativeGetIgnoreBOM) {
    function TextDecoder(label, options) {
      if (!new.target) {
        throw new TypeError('TextDecoder must be called as a constructor');
      }
      nativeInit(this, label, options);
    }

    Object.defineProperty(TextDecoder.prototype, 'encoding', {
      get: function() {
        return nativeGetEncoding(this);
      },
      enumerable: true,
      configurable: true
    });

    Object.defineProperty(TextDecoder.prototype, 'fatal', {
      get: function() {
        return nativeGetFatal(this);
      },
      enumerable: true,
      configurable: true
    });

    Object.defineProperty(TextDecoder.prototype, 'ignoreBOM', {
      get: function() {
        return nativeGetIgnoreBOM(this);
      },
      enumerable: true,
      configurable: true
    });

    TextDecoder.prototype.decode = nativeDecode;

    Object.defineProperty(TextDecoder.prototype, Symbol.toStringTag, {
      value: 'TextDecoder',
      writable: false,
      enumerable: false,
      configurable: true
    });

    globalThis.TextDecoder = TextDecoder;
  };
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// See 00-header.js for documentation
  return extensions;
})();

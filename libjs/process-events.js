// Copyright (c) Tzvetan Mikov.
//
// Sets up process event emitter methods (on/off/once/emit/emitWarning etc.).
// Called during hermes-node bootstrap after process object is on globalThis.

'use strict';

(function setupProcessEvents() {
  var process = globalThis.process;
  var handlers = {};
  process.on = process.addListener = function(event, fn) {
    if (!handlers[event]) handlers[event] = [];
    if (event !== 'newListener') process.emit('newListener', event, fn);
    handlers[event].push(fn);
    return process;
  };
  process.prependListener = function(event, fn) {
    if (!handlers[event]) handlers[event] = [];
    if (event !== 'newListener') process.emit('newListener', event, fn);
    handlers[event].unshift(fn);
    return process;
  };
  process.prependOnceListener = function(event, fn) {
    function wrapper() {
      process.off(event, wrapper);
      fn.apply(this, arguments);
    }
    return process.prependListener(event, wrapper);
  };
  process.off = process.removeListener = function(event, fn) {
    var list = handlers[event];
    if (list) {
      var idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    }
    return process;
  };
  process.once = function(event, fn) {
    function wrapper() {
      process.off(event, wrapper);
      fn.apply(this, arguments);
    }
    return process.on(event, wrapper);
  };
  process.emit = function(event) {
    var list = handlers[event];
    if (!list) return false;
    var args = Array.prototype.slice.call(arguments, 1);
    var copy = list.slice();
    for (var i = 0; i < copy.length; i++) {
      copy[i].apply(process, args);
    }
    return true;
  };
  process.listeners = function(event) {
    return (handlers[event] || []).slice();
  };
  process.listenerCount = function(event) {
    return (handlers[event] || []).length;
  };
  process.rawListeners = function(event) {
    return (handlers[event] || []).slice();
  };
  process.removeAllListeners = function(event) {
    if (event !== undefined) { delete handlers[event]; }
    else { handlers = {}; }
    return process;
  };
  process.emitWarning = function(warning, type, code) {
    if (typeof type === 'object' && type !== null) {
      code = type.code; type = type.type || type.name;
    }
    if (typeof warning === 'string') {
      var w = new Error(warning);
      w.name = type || 'Warning';
      if (code) w.code = code;
      warning = w;
    }
    process.emit('warning', warning);
  };

  // Route unhandled promise rejections to process.emit('unhandledRejection'),
  // falling back to Node's default behaviour of reporting and exiting 1.
  //
  // Without this a rejected promise with no handler is silent: the process
  // prints nothing and exits 0. That hides real failures -- an async CLI
  // command whose action rejects just produces no output at all -- and is the
  // single most confusing way for this runtime to differ from Node.
  //
  // Hermes tracks this itself; we only have to turn it on and supply hooks.
  var HermesInternal = globalThis.HermesInternal;
  if (HermesInternal &&
      typeof HermesInternal.enablePromiseRejectionTracker === 'function') {
    // Hermes routes this to the `promise` package's rejection-tracking
    // `enable()`, so these are its option names. `allRejections` matters:
    // without it the library only reports rejections whose value is one of a
    // small whitelist of Error constructors, and stays silent for everything
    // else.
    HermesInternal.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: function(id, rejection) {
        if (process.emit('unhandledRejection', rejection, id))
          return;

        var text;
        if (rejection instanceof Error) {
          text = rejection.stack || (rejection.name + ': ' + rejection.message);
        } else {
          try {
            text = String(rejection);
          } catch (e) {
            text = '<unprintable rejection value>';
          }
        }
        process._rawDebug
          ? process._rawDebug(text)
          : console.error(text);
        console.error(
          '\nThis error originated either by throwing inside of an async ' +
          'function without a catch block, or by rejecting a promise which ' +
          'was not handled with .catch().');
        process.exitCode = 1;
      },
      onHandled: function(id) {
        process.emit('rejectionHandled', id);
      },
    });
  }
})();

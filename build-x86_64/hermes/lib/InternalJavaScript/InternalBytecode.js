/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// header.js + footer.js wraps around other js lib files to create a local scope
// so that local variables / functions defined within cannot be modified by users
(function() {
  'use strict';

  // This object will be returned as the completion value of executing internal
  // bytecode (this IIFE). It provides a way to return JS values to native code.
  // E.g. the only use currently is to register JSFunctions as JS builtins that
  // "CallBuiltin" opcode can call.
  var internalBytecodeResult = {};
/* @nolint */var initPromise = (function () {
  'use strict';
  var useEngineQueue = HermesInternal.useEngineQueue();
  // Captured at startup so per-element checks in Promise.all stay
  // cheap. Spec compliance (§27.2.4.1.2 step 8.e: always Invoke
  // `.then`) is gated on `--test262`; otherwise we keep the
  // fast path that synchronously invokes the resolve element when
  // the input is an already-fulfilled core Promise.
  var test262Enabled = HermesInternal.test262Enabled();
  function noop() {}

  // States:
  //
  // 0 - pending
  // 1 - fulfilled with _value
  // 2 - rejected with _value
  // 3 - adopted the state of another promise, _value
  //
  // once the state is no longer pending (0) it is immutable

  // All `_` prefixed properties will be reduced to `_{random number}`
  // at build time to obfuscate them and discourage their use.
  // We don't use symbols or Object.defineProperty to fully hide them
  // because the performance isn't good enough.


  // to avoid using try/catch inside critical functions, we
  // extract them to here.
  var LAST_ERROR = null;
  var IS_ERROR = {};
  function getThen(obj) {
    try {
      return obj.then;
    } catch (ex) {
      LAST_ERROR = ex;
      return IS_ERROR;
    }
  }

  function tryCallOne(fn, a) {
    try {
      return fn(a);
    } catch (ex) {
      LAST_ERROR = ex;
      return IS_ERROR;
    }
  }
  function tryCallTwo(fn, a, b) {
    try {
      fn(a, b);
    } catch (ex) {
      LAST_ERROR = ex;
      return IS_ERROR;
    }
  }

  // Per spec §27.2 / §15.7: declaring Promise as a class gives all the
  // built-in spec attributes for free:
  // - calling without `new` throws TypeError (per [[Call]] of class
  //   constructors).
  // - Promise.prototype is { writable: false, enumerable: false,
  //   configurable: false } per §15.7.10 step 26.
  // - every prototype and static method is non-enumerable, configurable,
  //   writable, with NamedEvaluation-derived `.name`, and has no
  //   [[Construct]] (so `new Promise.prototype.then()` throws).
  class Promise {
    static _B = null;
    static _C = null;
    static _D = noop;

    constructor(fn) {
      if (typeof fn !== 'function') {
        throw new TypeError('Promise constructor\'s argument is not a function');
      }
      this._x = 0;
      this._y = 0;
      this._z = null;
      this._A = null;
      if (fn === noop) return;
      doResolve(fn, this);
    }

    /* Static Methods */

    static resolve(value) {
      // Per spec §27.2.4.5 step 2: If Type(this) is not Object, throw
      // TypeError. Includes null (typeof null === 'object', but null
      // is the Null type, not Object).
      var C = this;
      if (C === null || (typeof C !== 'object' && typeof C !== 'function')) {
        throw new TypeError('Promise.resolve called on non-object');
      }
      // Per spec §27.2.4.5 step 3: if IsPromise(value) and value's
      // constructor is C, return value. Only read .constructor on
      // actual promises — reading it on arbitrary thenables/objects
      // would be user-observable and break the thenable resolution
      // path.
      if (value instanceof core && value.constructor === C) {
        return value;
      }

      if (C === core) {
        // Fast path for core Promise.
        if (value === null) return NULL;
        if (value === undefined) return UNDEFINED;
        if (value === true) return TRUE;
        if (value === false) return FALSE;
        if (value === 0) return ZERO;
        if (value === '') return EMPTYSTRING;

        if (typeof value === 'object' || typeof value === 'function') {
          try {
            var then = value.then;
            if (typeof then === 'function') {
              return new core(then.bind(value));
            }
          } catch (ex) {
            return new core(function (resolve, reject) {
              reject(ex);
            });
          }
        }
        return valuePromise(value);
      }

      // Subclass path: NewPromiseCapability(C) + capability.[[Resolve]](value)
      // per spec §27.2.4.5 steps 4-6. Extract resolve as a local so
      // the call form passes `this = undefined` (matches spec's
      // Call(F, undefined, args)).
      var capability = newPromiseCapability(C);
      var capResolve = capability.resolve;
      capResolve(value);
      return capability.promise;
    }

    static all(arr) {
      var C = this;
      // Step 2: NewPromiseCapability(C). Throws synchronously if C is
      // not a valid constructor or doesn't capture resolve/reject.
      var capability = newPromiseCapability(C);
      var resultPromise = capability.promise;
      var capResolve = capability.resolve;
      var capReject = capability.reject;
      // Step 3-4: GetPromiseResolve(C), IfAbruptRejectPromise.
      var promiseResolve;
      try {
        promiseResolve = C.resolve;
      } catch (e) {
        capReject(e);
        return resultPromise;
      }
      if (typeof promiseResolve !== 'function') {
        capReject(new TypeError('Promise resolve is not a function'));
        return resultPromise;
      }
      var remainingElementsCount = 1;
      var index = 0;
      var values = [];
      // Per spec §27.2.4.1.3: each Promise.all Resolve Element Function
      // is anonymous (name === ""), captures its own [[AlreadyCalled]],
      // and shares the values array, remainingElementsCount, and
      // capability with its siblings. Returning the closure (rather
      // than naming it via assignment) avoids triggering
      // NamedEvaluation per §8.5.5. Use an arrow function so the
      // returned closure is non-constructable per spec.
      function makeResolveElement(idx) {
        var alreadyCalled = false;
        return (value) => {
          if (alreadyCalled) return;
          alreadyCalled = true;
          Object.defineProperty(values, idx, {
            value: value, writable: true,
            enumerable: true, configurable: true,
          });
          if (--remainingElementsCount === 0) {
            capResolve(values);
          }
        };
      }
      // Step 7-8: PerformPromiseAll, IfAbruptRejectPromise. Catches
      // abrupt completions from the iterator protocol, promiseResolve,
      // nextPromise.then, the fast-path resolveElement call, and the
      // final capResolve (subclass capabilities can throw).
      try {
        for (var item of arr) {
          var nextPromise = promiseResolve.call(C, item);
          var resolveElement = makeResolveElement(index);
          remainingElementsCount++;
          // Per spec §27.2.4.1.2 step 8.e, .then must be invoked on
          // nextPromise so the reaction is enqueued as a
          // PromiseReactionJob. The fast path below synchronously calls
          // resolveElement when nextPromise is an already-fulfilled core
          // Promise, collapsing the spec's 1-microtask hop. We retain it
          // by default for performance and only take the spec path under
          // --test262.
          if (test262Enabled) {
            nextPromise.then(resolveElement, capReject);
          } else {
            nextPromise._y === 1
              ? resolveElement(nextPromise._z)
              : nextPromise.then(resolveElement, capReject);
          }
          index++;
        }
        if (--remainingElementsCount === 0) {
          capResolve(values);
        }
      } catch (e) {
        capReject(e);
      }
      return resultPromise;
    }

    static allSettled(iterable) {
      var C = this;
      // Step 2: NewPromiseCapability(C).
      var capability = newPromiseCapability(C);
      var resultPromise = capability.promise;
      var capResolve = capability.resolve;
      var capReject = capability.reject;
      // Step 3-4: GetPromiseResolve(C), IfAbruptRejectPromise.
      var promiseResolve;
      try {
        promiseResolve = C.resolve;
      } catch (e) {
        capReject(e);
        return resultPromise;
      }
      if (typeof promiseResolve !== 'function') {
        capReject(new TypeError('Promise resolve is not a function'));
        return resultPromise;
      }
      var values = [];
      var remainingElementsCount = 1;
      var index = 0;
      // Per spec §27.2.4.2.1 step q: onRejected and onFulfilled share
      // the same [[AlreadyCalled]] record, so once either fires the
      // other is blocked for this index. Use an array literal (not an
      // object literal) so the inner functions are anonymous (name "")
      // per spec — object property assignment would trigger
      // NamedEvaluation and infer the names from the keys. Per spec
      // §27.2.4.2.2 / §27.2.4.2.3, the per-element resolve/reject
      // functions are built-ins without [[Construct]] — use arrow
      // functions.
      function makeSettledPair(idx) {
        var alreadyCalled = false;
        return [
          (value) => {
            if (alreadyCalled) return;
            alreadyCalled = true;
            Object.defineProperty(values, idx, {
              value: { status: 'fulfilled', value: value },
              writable: true, enumerable: true, configurable: true,
            });
            if (--remainingElementsCount === 0) {
              capResolve(values);
            }
          },
          (reason) => {
            if (alreadyCalled) return;
            alreadyCalled = true;
            Object.defineProperty(values, idx, {
              value: { status: 'rejected', reason: reason },
              writable: true, enumerable: true, configurable: true,
            });
            if (--remainingElementsCount === 0) {
              capResolve(values);
            }
          },
        ];
      }
      // Step 7-8: PerformPromiseAllSettled, IfAbruptRejectPromise.
      try {
        for (var item of iterable) {
          var nextPromise = promiseResolve.call(C, item);
          var pair = makeSettledPair(index);
          remainingElementsCount++;
          nextPromise.then(pair[0], pair[1]);
          index++;
        }
        if (--remainingElementsCount === 0) {
          capResolve(values);
        }
      } catch (e) {
        capReject(e);
      }
      return resultPromise;
    }

    static reject(value) {
      // Per spec §27.2.4.4 steps 1-5: NewPromiseCapability(C) +
      // capability.[[Reject]](value).
      var C = this;
      if (C === null || (typeof C !== 'object' && typeof C !== 'function')) {
        throw new TypeError('Promise.reject called on non-object');
      }
      var capability = newPromiseCapability(C);
      var capReject = capability.reject;
      capReject(value);
      return capability.promise;
    }

    static race(values) {
      var C = this;
      // Step 2: NewPromiseCapability(C).
      var capability = newPromiseCapability(C);
      var resultPromise = capability.promise;
      var capResolve = capability.resolve;
      var capReject = capability.reject;
      // Step 3-4: GetPromiseResolve(C), IfAbruptRejectPromise.
      var promiseResolve;
      try {
        promiseResolve = C.resolve;
      } catch (e) {
        capReject(e);
        return resultPromise;
      }
      if (typeof promiseResolve !== 'function') {
        capReject(new TypeError('Promise resolve is not a function'));
        return resultPromise;
      }
      // Step 7-8: PerformPromiseRace, IfAbruptRejectPromise.
      try {
        for (var value of values) {
          promiseResolve.call(C, value).then(capResolve, capReject);
        }
      } catch (e) {
        capReject(e);
      }
      return resultPromise;
    }

    static any(values) {
      var C = this;
      // Step 2: NewPromiseCapability(C).
      var capability = newPromiseCapability(C);
      var resultPromise = capability.promise;
      var capResolve = capability.resolve;
      var capReject = capability.reject;
      // Step 3-4: GetPromiseResolve(C), IfAbruptRejectPromise.
      var promiseResolve;
      try {
        promiseResolve = C.resolve;
      } catch (e) {
        capReject(e);
        return resultPromise;
      }
      if (typeof promiseResolve !== 'function') {
        capReject(new TypeError('Promise resolve is not a function'));
        return resultPromise;
      }
      var errors = [];
      var remainingElementsCount = 1;
      var index = 0;
      // Per spec §27.2.4.3.1 step r: onFulfilled is
      // capability.[[Resolve]] directly. Only onRejected is wrapped
      // per element with its own [[AlreadyCalled]] flag. Per spec
      // §27.2.4.3.1, the Promise.any Reject Element Function is a
      // built-in without [[Construct]] — use arrow function.
      function makeRejectElement(idx) {
        var alreadyCalled = false;
        return (reason) => {
          if (alreadyCalled) return;
          alreadyCalled = true;
          Object.defineProperty(errors, idx, {
            value: reason, writable: true,
            enumerable: true, configurable: true,
          });
          if (--remainingElementsCount === 0) {
            capReject(getAggregateError(errors));
          }
        };
      }
      // Step 7-8: PerformPromiseAny, IfAbruptRejectPromise.
      try {
        for (var value of values) {
          var rejectElement = makeRejectElement(index);
          remainingElementsCount++;
          promiseResolve.call(C, value).then(capResolve, rejectElement);
          index++;
        }
        if (--remainingElementsCount === 0) {
          capReject(getAggregateError(errors));
        }
      } catch (e) {
        capReject(e);
      }
      return resultPromise;
    }

    // Per spec §27.2.4.9 Promise.withResolvers:
    //   1. Let promiseCapability be ? NewPromiseCapability(this).
    //   2. Return { promise, resolve, reject } from the capability.
    // Delegate to newPromiseCapability so that IsConstructor(C),
    // double-call detection (GetCapabilitiesExecutor steps 3-4), and
    // the final IsCallable(resolve/reject) check (§27.2.1.5 step 5)
    // are all enforced. Its return shape already matches what spec
    // requires here.
    static withResolvers() {
      return newPromiseCapability(this);
    }

    // Per spec §27.2.4.9 Promise.try ( callback, ...args )
    static try(callbackfn) {
      var C = this;
      // Step 2-3: NewPromiseCapability(C).
      var capability = newPromiseCapability(C);
      var capResolve = capability.resolve;
      var capReject = capability.reject;
      // Step 4-6: Call the callback. If it throws (abrupt), reject;
      // otherwise resolve. Throws from resolve/reject themselves
      // propagate per spec §27.2.4.9 steps 5.a / 6.a.
      var ret;
      try {
        if (arguments.length <= 1) {
          // Fast path: no extra args. Per spec step 4 args would be
          // an empty List; Call(callbackfn, undefined, «») is
          // equivalent to callbackfn(). Skips the args-array
          // allocation and .apply dispatch.
          ret = callbackfn();
        } else {
          // Collect extra arguments beyond the first.
          var args = [];
          for (var i = 1; i < arguments.length; i++) {
            args.push(arguments[i]);
          }
          ret = callbackfn.apply(undefined, args);
        }
      } catch (e) {
        capReject(e);
        return capability.promise;
      }
      capResolve(ret);
      return capability.promise;
    }

    /* Prototype Methods */

    then(onFulfilled, onRejected) {
      // Per spec §27.2.5.4 step 2: If IsPromise(this) is false, throw
      // TypeError. We approximate IsPromise via instanceof Promise (no
      // real [[PromiseState]] internal slot in pure JS). The check
      // must happen BEFORE reading this.constructor — otherwise a
      // hostile `constructor` getter would observe the call before
      // validation.
      if (!(this instanceof Promise)) {
        throw new TypeError('Promise.prototype.then called on non-Promise');
      }
      // Per spec §27.2.5.4 step 3 + §7.3.22 SpeciesConstructor: when
      // `constructor` is undefined, fall back to %Promise% — i.e. take
      // the fast path. Without this, an `undefined` constructor would
      // hit safeThen → newPromiseCapability(undefined) → spurious
      // TypeError where the spec returns a normal Promise.
      var C = this.constructor;
      if (C !== undefined && C !== Promise) {
        return safeThen(this, onFulfilled, onRejected);
      }
      var res = new Promise(noop);
      handle(this, new Handler(onFulfilled, onRejected, res));
      return res;
    }

    catch(onRejected) {
      // Per spec §27.2.5.1 step 2: Invoke(this, "then", « undefined,
      // onRejected »).
      return this.then(undefined, onRejected);
    }

    // Per spec §27.2.5.3: Promise.prototype.finally ( onFinally )
    finally(onFinally) {
      // Per spec §27.2.5.3 step 2: If Type(this) is not Object, throw
    // TypeError. Includes null (typeof null === 'object', but null
    // is the Null type, not Object).
    if (this === null ||
        (typeof this !== 'object' && typeof this !== 'function')) {
      throw new TypeError('Promise.prototype.finally called on non-object');
    }
    // Spec step 3 calls SpeciesConstructor(this, %Promise%); we
      // don't support @@species (perf), so fall back to
      // this.constructor (gives subclass dispatch for non-species-
      // overriding subclasses).
      var C = this.constructor;
      var thenFinally, catchFinally;
      if (typeof onFinally !== 'function') {
        thenFinally = onFinally;
        catchFinally = onFinally;
      } else {
        // Then Finally Function and Catch Finally Function per spec
        // are anonymous built-in functions (not constructors,
        // length=1). Use arrow functions so they are not
        // constructors and are anonymous (array-literal element
        // position avoids NamedEvaluation per §8.5.5). Per spec
        // §27.2.5.3.1 step 4, the result of onFinally() is wrapped
        // via PromiseResolve(C, result) — delegating to C.resolve
        // covers that (it handles same-Promise short-circuit,
        // thenable assimilation, and value wrapping).
        var fns = [(value) => {
          return C.resolve(onFinally()).then(() => value);
        }, (reason) => {
          return C.resolve(onFinally()).then(() => { throw reason; });
        }];
        thenFinally = fns[0];
        catchFinally = fns[1];
      }
      return this.then(thenFinally, catchFinally);
    }
  }
  var core = Promise;

  function safeThen(self, onFulfilled, onRejected) {
    // Per spec §27.2.5.4: NewPromiseCapability runs BEFORE
    // PerformPromiseThen attaches the reaction.
    var capability = newPromiseCapability(self.constructor);
    // Intermediate core Promise that holds the result of running
    // onFulfilled/onRejected when self settles.
    var res = new Promise(noop);
    handle(self, new Handler(onFulfilled, onRejected, res));
    // Chain res's settlement to the C-typed capability.
    handle(res, new Handler(capability.resolve, capability.reject,
      new Promise(noop)));
    return capability.promise;
  }

  // Per spec §27.2.1.5 NewPromiseCapability(C). Returns a record with
  // `promise`, `resolve`, and `reject`. Throws TypeError if C is not a
  // constructor, if the executor closure is called when [[Resolve]] or
  // [[Reject]] is already non-undefined (per spec's
  // GetCapabilitiesExecutor §27.2.1.5.1 steps 3-4), or if resolve/reject
  // are not callable after C's constructor returns.
  function newPromiseCapability(C) {
    if (C === null || (typeof C !== 'object' && typeof C !== 'function')) {
      throw new TypeError('Promise constructor is not an object');
    }
    var resolve, reject;
    // Per spec §27.2.1.5.1 GetCapabilitiesExecutor: the executor is a
    // built-in function without [[Construct]]. Arrow function provides
    // that and avoids any [[Construct]] / [[HomeObject]] surface.
    var promise = new C((resolveArg, rejectArg) => {
      // Per spec §27.2.1.5.1 steps 3-4: only throw if the corresponding
      // slot has already been set to a non-undefined value. Calls with
      // undefined args from a constructor that calls executor multiple
      // times are tolerated as long as no slot was non-undefined yet.
      if (resolve !== undefined) {
        throw new TypeError('Promise capability resolve already captured');
      }
      if (reject !== undefined) {
        throw new TypeError('Promise capability reject already captured');
      }
      resolve = resolveArg;
      reject = rejectArg;
    });
    if (typeof resolve !== 'function' || typeof reject !== 'function') {
      throw new TypeError('Promise capability resolve/reject is not a function');
    }
    return { promise: promise, resolve: resolve, reject: reject };
  }
  function handle(self, deferred) {
    while (self._y === 3) {
      self = self._z;
    }
    if (Promise._B) {
      Promise._B(self);
    }
    if (self._y === 0) {
      if (self._x === 0) {
        self._x = 1;
        self._A = deferred;
        return;
      }
      if (self._x === 1) {
        self._x = 2;
        self._A = [self._A, deferred];
        return;
      }
      self._A.push(deferred);
      return;
    }
    handleResolved(self, deferred);
  }

  function handleResolved(self, deferred) {
    (useEngineQueue ? HermesInternal.enqueueJob : setImmediate)(function() {
      var cb = self._y === 1 ? deferred.onFulfilled : deferred.onRejected;
      if (cb === null) {
        if (self._y === 1) {
          resolve(deferred.promise, self._z);
        } else {
          reject(deferred.promise, self._z);
        }
        return;
      }
      var ret = tryCallOne(cb, self._z);
      if (ret === IS_ERROR) {
        reject(deferred.promise, LAST_ERROR);
      } else {
        resolve(deferred.promise, ret);
      }
    });
  }
  function resolve(self, newValue) {
    // Promise Resolution Procedure: https://github.com/promises-aplus/promises-spec#the-promise-resolution-procedure
    if (newValue === self) {
      return reject(
        self,
        new TypeError('A promise cannot be resolved with itself.')
      );
    }
    if (
      newValue &&
      (typeof newValue === 'object' || typeof newValue === 'function')
    ) {
      var then = getThen(newValue);
      if (then === IS_ERROR) {
        return reject(self, LAST_ERROR);
      }
      if (
        then === self.then &&
        newValue instanceof Promise &&
        newValue.constructor === Promise
      ) {
        self._y = 3;
        self._z = newValue;
        finale(self);
        return;
      } else if (typeof then === 'function') {
        doResolve(then.bind(newValue), self);
        return;
      }
    }
    self._y = 1;
    self._z = newValue;
    finale(self);
  }

  function reject(self, newValue) {
    self._y = 2;
    self._z = newValue;
    if (Promise._C) {
      Promise._C(self, newValue);
    }
    finale(self);
  }
  function finale(self) {
    if (self._x === 1) {
      handle(self, self._A);
      self._A = null;
    }
    if (self._x === 2) {
      for (var i = 0; i < self._A.length; i++) {
        handle(self, self._A[i]);
      }
      self._A = null;
    }
  }

  class Handler {
    constructor(onFulfilled, onRejected, promise) {
      this.onFulfilled = typeof onFulfilled === 'function' ? onFulfilled : null;
      this.onRejected = typeof onRejected === 'function' ? onRejected : null;
      this.promise = promise;
    }
  }

  /**
   * Take a potentially misbehaving resolver function and make sure
   * onFulfilled and onRejected are only called once.
   *
   * Makes no guarantees about asynchrony.
   */
  function doResolve(fn, promise) {
    var done = false;
    // Per spec §27.2.1.3 / §27.2.1.4: Promise Resolve/Reject Functions
    // are built-in functions without [[Construct]]. Use arrow functions
    // so `new resolve()` / `new reject()` correctly throw TypeError.
    var res = tryCallTwo(fn, (value) => {
      if (done) return;
      done = true;
      resolve(promise, value);
    }, (reason) => {
      if (done) return;
      done = true;
      reject(promise, reason);
    });
    if (!done && res === IS_ERROR) {
      done = true;
      reject(promise, LAST_ERROR);
    }
  }

  //This file contains the ES6 extensions to the core Promises/A+ API
  var es6Extensions = core;

  // Per spec §27.2.5.5: Promise.prototype[@@toStringTag] is "Promise".
  // Spec mandates a *data* property — class `get [Symbol.toStringTag]()`
  // would create an accessor instead, so we still set it explicitly.
  Object.defineProperty(core.prototype, Symbol.toStringTag, {
    value: 'Promise',
    writable: false,
    enumerable: false,
    configurable: true
  });

  var TRUE = valuePromise(true);
  var FALSE = valuePromise(false);
  var NULL = valuePromise(null);
  var UNDEFINED = valuePromise(undefined);
  var ZERO = valuePromise(0);
  var EMPTYSTRING = valuePromise('');

  function valuePromise(value) {
    var p = new core(core._D);
    p._y = 1;
    p._z = value;
    return p;
  }

  function getAggregateError(errors){
    if(typeof AggregateError === 'function'){
      return new AggregateError(errors,'All promises were rejected');
    }

    var error = new Error('All promises were rejected');

    error.name = 'AggregateError';
    error.errors = errors;

    return error;
  }

  var DEFAULT_WHITELIST = [
    ReferenceError,
    TypeError,
    RangeError
  ];

  var enabled = false;
  var disable_1 = disable;
  function disable() {
    enabled = false;
    core._B = null;
    core._C = null;
  }

  var enable_1 = enable;
  function enable(options) {
    options = options || {};
    if (enabled) disable();
    enabled = true;
    var id = 0;
    var displayId = 0;
    var rejections = {};
    core._B = function (promise) {
      if (
        promise._y === 2 && // IS REJECTED
        rejections[promise._E]
      ) {
        if (rejections[promise._E].logged) {
          onHandled(promise._E);
        } else {
          clearTimeout(rejections[promise._E].timeout);
        }
        delete rejections[promise._E];
      }
    };
    core._C = function (promise, err) {
      if (promise._x === 0) { // not yet handled
        promise._E = id++;
        rejections[promise._E] = {
          displayId: null,
          error: err,
          promise: promise,
          timeout: setTimeout(
            onUnhandled.bind(null, promise._E),
            // For reference errors and type errors, this almost always
            // means the programmer made a mistake, so log them after just
            // 100ms
            // otherwise, wait 2 seconds to see if they get handled
            matchWhitelist(err, DEFAULT_WHITELIST)
              ? 100
              : 2000
          ),
          logged: false
        };
      }
    };
    function onUnhandled(id) {
      if (
        options.allRejections ||
        matchWhitelist(
          rejections[id].error,
          options.whitelist || DEFAULT_WHITELIST
        )
      ) {
        rejections[id].displayId = displayId++;
        if (options.onUnhandled) {
          rejections[id].logged = true;
          options.onUnhandled(
            rejections[id].displayId,
            rejections[id].error,
            rejections[id].promise
          );
        } else {
          rejections[id].logged = true;
          logError(
            rejections[id].displayId,
            rejections[id].error
          );
        }
      }
    }
    function onHandled(id) {
      if (rejections[id].logged) {
        if (options.onHandled) {
          options.onHandled(
            rejections[id].displayId,
            rejections[id].error,
            rejections[id].promise
          );
        } else if (!rejections[id].onUnhandled) {
          console.warn(
            'Promise Rejection Handled (id: ' + rejections[id].displayId + '):'
          );
          console.warn(
            '  This means you can ignore any previous messages of the form "Possible Unhandled Promise Rejection" with id ' +
            rejections[id].displayId + '.'
          );
        }
      }
    }
  }

  function logError(id, error) {
    console.warn('Possible Unhandled Promise Rejection (id: ' + id + '):');
    var errStr = (error && (error.stack || error)) + '';
    errStr.split('\n').forEach(function (line) {
      console.warn('  ' + line);
    });
  }

  function matchWhitelist(error, list) {
    return list.some(function (cls) {
      return error instanceof cls;
    });
  }

  var rejectionTracking = {
  	disable: disable_1,
  	enable: enable_1
  };

  // @nolint
  // This file is used to generate InternalBytecode/Promise.js
  // See InternalBytecode/README.md for more details.




  // Expose Promise to global, with the spec attributes for
  // built-in global properties (§19.4):
  // { writable: true, enumerable: false, configurable: true }.
  // Plain `globalThis.Promise = es6Extensions` would create an
  // enumerable property, failing test built-ins/Promise/promise.js.
  Object.defineProperty(globalThis, 'Promise', {
    value: es6Extensions, writable: true,
    enumerable: false, configurable: true,
  });

  // register the JavaScript implemented `enable` function into
  // the Hermes' internal promise rejection tracker.
  var enableHook = rejectionTracking.enable;
  HermesInternal?.setPromiseRejectionTrackingHook?.(enableHook);

  var promise = {

  };

  return promise;

});
initPromise();
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

function initAsyncFn() {
  // promiseCapability.[[Promise]]
  var HermesPromise = globalThis.Promise;

  // %Promise_resolve%
  var HermesPromiseResolve = HermesPromise.resolve.bind(HermesPromise);

  // This spawn function is borrowed from the
  // [original proposal](https://github.com/tc39/proposal-async-await),
  // then it's modified to
  // - use the captured Promise and methods to immune from user-space hijacking.
  // - to take a third argument "args".
  // TODO(the Babel version seem to be a little bit faster.)
  function spawn(genF, self, args) {
    return new HermesPromise(function (resolve, reject) {
      var gen = genF.apply(self, args);
      function step(nextF) {
        var next;
        try {
          next = nextF();
        } catch (e) {
          // finished with failure, reject the promise
          reject(e);
          return;
        }
        if (next.done) {
          // finished with success, resolve the promise
          resolve(next.value);
          return;
        }
        // not finished, chain off the yielded promise and `step` again
        HermesPromiseResolve(next.value).then(
          function (v) {
            step(function () {
              return gen.next(v);
            });
          },
          function (e) {
            step(function () {
              return gen.throw(e);
            });
          }
        );
      }
      step(function () {
        return gen.next(undefined);
      });
    });
  }

  // register as "spawnAsync".
  internalBytecodeResult.spawnAsync = spawn;
}

initAsyncFn();
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

function initAsyncIterators() {
    var HermesPromise = globalThis.Promise;

    /**
     * Creates an asynchronous iterator for the given iterable.
     *
     * This function checks if the iterable already has an async iterator.
     * If it does, it returns the existing async iterator.
     * If not, it constructs an async iterator from the iterable's synchronous iterator.
     * The constructed async iterator resolves any promise values within its methods.
     *
     * @param {Iterable} iterable - The iterable object for which to create an async iterator.
     * @returns {AsyncIterator} - An asynchronous iterator for the given iterable.
     */
    function _makeAsyncIterator(iterable) {
        if (iterable[Symbol.asyncIterator]) {
            return iterable[Symbol.asyncIterator]();
        }

        var syncIterator = iterable[Symbol.iterator]();
        async function handleResult(result) {
            if (result.done) {
                return result;
            }
            var value = result.value;
            var resolvedValue = value instanceof HermesPromise ? await value : value;
            return { done: false, value: resolvedValue };
        }

        return {
            async next() {
                var result = syncIterator.next();
                return handleResult(result);
            },
            async return(value) {
                var result = typeof syncIterator.return === 'function' ? syncIterator.return(value) : { done: true, value };
                return handleResult(result);
            },
            async throw(error) {
                var result = typeof syncIterator.throw === 'function' ? syncIterator.throw(error) : { done: true, value: error };
                return handleResult(result);
            }
        };
    }

    // Register as "makeAsyncIterator"
    internalBytecodeResult.makeAsyncIterator = _makeAsyncIterator;
}

function initAsyncGenerators() {
    var HermesPromise = globalThis.Promise;

    // https://github.com/babel/babel/blob/dcfa42b933299644c4e78168cb4678ecbfae67ed/packages/babel-runtime-corejs3/helpers/esm/wrapAsyncGenerator.js
    function OverloadYield(value, kind) {
        this.value = value, this.kind = kind;
    }

    /**
     * Implements an asynchronous generator to handle async iteration.
     *
     * This function manages state transitions (next, throw, return)
     * through promises to mimic JavaScript's native async generator behavior.
     * https://github.com/babel/babel/blob/dcfa42b933299644c4e78168cb4678ecbfae67ed/packages/babel-runtime-corejs3/helpers/esm/awaitAsyncGenerator.js
     */
    function AsyncGenerator(generatorFunction) {
        var currentPromise, resolveQueue;

        function resume(key, argument) {
            try {
                var nextIteration = generatorFunction[key](argument),
                    iterationValue = nextIteration.value,
                    isOverloadYield = iterationValue instanceof OverloadYield;
                HermesPromise.resolve(isOverloadYield ? iterationValue.value : iterationValue).then(function (resolvedValue) {
                    if (isOverloadYield) {
                        var nextKey = "return" === key ? "return" : "next";
                        if (!iterationValue.kind || resolvedValue.done) {
                            return resume(nextKey, resolvedValue);
                        }
                        resolvedValue = generatorFunction[nextKey](resolvedValue).value;
                    }
                    conclude(nextIteration.done ? "return" : "normal", resolvedValue);
                }, function (error) {
                    resume("throw", error);
                });
            } catch (error) {
                conclude("throw", error);
            }
        }

        function conclude(type, result) {
            switch (type) {
                case "return":
                    currentPromise.resolve({ value: result, done: true });
                    break;
                case "throw":
                    currentPromise.reject(result);
                    break;
                default:
                    currentPromise.resolve({ value: result, done: false });
            }
            (currentPromise = currentPromise.next) ? resume(currentPromise.key, currentPromise.arg) : resolveQueue = null;
        }

        this._invoke = function (key, argument) {
            return new HermesPromise(function (resolve, reject) {
                var promiseCapability = {
                    key: key,
                    arg: argument,
                    resolve: resolve,
                    reject: reject,
                    next: null
                };
                resolveQueue ? resolveQueue = resolveQueue.next = promiseCapability : (currentPromise = resolveQueue = promiseCapability, resume(key, argument));
            });
        };

        if (typeof generatorFunction["return"] !== "function") {
            this["return"] = void 0;
        }
    }

    AsyncGenerator.prototype[Symbol.asyncIterator] = function () {
        return this;
    };
    AsyncGenerator.prototype.next = function (value) {
        return this._invoke("next", value);
    };
    AsyncGenerator.prototype["throw"] = function (error) {
        return this._invoke("throw", error);
    };
    AsyncGenerator.prototype["return"] = function (value) {
        return this._invoke("return", value);
    };

    // https://github.com/babel/babel/blob/dcfa42b933299644c4e78168cb4678ecbfae67ed/packages/babel-runtime-corejs3/helpers/esm/wrapAsyncGenerator.js
    function _wrapAsyncGenerator(generatorFunction) {
        return function () {
            return new AsyncGenerator(generatorFunction.apply(this, arguments));
        };
    }

    // https://github.com/babel/babel/blob/dcfa42b933299644c4e78168cb4678ecbfae67ed/packages/babel-runtime-corejs3/helpers/esm/awaitAsyncGenerator.js
    function _awaitAsyncGenerator(value) {
        return new OverloadYield(value, 0);
    }

    // https://github.com/babel/babel/blob/dcfa42b933299644c4e78168cb4678ecbfae67ed/packages/babel-helpers/src/helpers/asyncGeneratorDelegate.ts
    function _asyncGeneratorDelegate(iterable) {
        var inner;
        var asyncIteratorMethod = iterable[Symbol.asyncIterator];
        if (asyncIteratorMethod != null) {
            inner = asyncIteratorMethod.call(iterable);
        } else {
            inner = iterable[Symbol.iterator]();
        }
        var iter = {}, waiting = false;
        function pump(key, value) {
            waiting = true;
            value = new HermesPromise(function (resolve) {
                resolve(inner[key](value));
            });
            return { done: false, value: new OverloadYield(value, 1) };
        }
        iter[Symbol.iterator] = function () { return this; };
        iter.next = function (value) {
            if (waiting) { waiting = false; return value; }
            return pump("next", value);
        };
        if (typeof inner["throw"] === "function") {
            iter["throw"] = function (value) {
                if (waiting) { waiting = false; throw value; }
                return pump("throw", value);
            };
        }
        if (typeof inner["return"] === "function") {
            iter["return"] = function (value) {
                if (waiting) { waiting = false; return value; }
                return pump("return", value);
            };
        }
        return iter;
    }

    // Register _awaitAsyncGenerator so it can be called via GetBuiltinClosure
    // from IRGen for `for await...of` inside async generators.
    internalBytecodeResult.awaitAsyncGenerator = _awaitAsyncGenerator;

    // Since async generators require an AST transformation, using internalBytecodeResult is not feasible.
    var HermesAsyncIteratorsInternal = {
        _wrapAsyncGenerator,
        _awaitAsyncGenerator,
        _asyncGeneratorDelegate,
    };
    Object.freeze(HermesAsyncIteratorsInternal);
    globalThis.HermesAsyncIteratorsInternal = HermesAsyncIteratorsInternal;
}

initAsyncIterators();
initAsyncGenerators();
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator Helper Dependencies
// Dependencies required by the iterator polyfill in https://github.com/es-shims/iterator-helpers/tree/main
// ==========================

// === Basic Utility Functions ===

var $isNaN = Number.isNaN;

// From math-intrinsics/abs.js
var abs = Math.abs;

// From math-intrinsics/floor.js
var floor = Math.floor;

// From math-intrinsics/max.js
var max = Math.max;

// From math-intrinsics/min.js
var min = Math.min;

// From math-intrinsics/pow.js
var pow = Math.pow;

// From math-intrinsics/round.js
var round = Math.round;

// From math-intrinsics/sign.js
var sign = Math.sign;

// === Object Operations ===

// From es-object-atoms/index.js
var $Object = Object;

var gopd = Object.getOwnPropertyDescriptor;

var $defineProperty = Object.defineProperty;

// From has-property-descriptors/index.js
var hasPropertyDescriptors = function hasPropertyDescriptors() {
	return !!$defineProperty;
};

hasPropertyDescriptors.hasArrayLengthDefineBug = function hasArrayLengthDefineBug() {
	return false;
}

// === Function Binding ===

// From call-bind-apply-helpers/functionCall.js
var $call = Function.prototype.call;

// From call-bind-apply-helpers/functionApply.js
var $apply = Function.prototype.apply;

// From call-bind-apply-helpers/reflectApply.js
var $reflectApply = typeof Reflect !== 'undefined' && Reflect && Reflect.apply;

// From function-bind/index.js
var bind = Function.prototype.bind

// From call-bind-apply-helpers/actualApply.js
var $actualApply = $reflectApply || bind.call($call, $apply);

// From call-bind-apply-helpers/index.js
var callBindBasic = function callBindBasic(args) {
	if (args.length < 1 || typeof args[0] !== 'function') {
				throw new TypeError('a function is required');
	}
	return $actualApply(bind, $call, args);
};

// From hasown/index.js
var hasown = (function() {
    var call = Function.prototype.call;
    var $hasOwn = Object.prototype.hasOwnProperty;
    return bind.call(call, $hasOwn);
})();

// === Symbol Support ===

// Hermes supports Symbols, but to make the polyfill easy to port, keep this variable
var hasSymbols = function hasSymbols() {
	return true;
}

// === Object Keys Implementation ===
var objectKeys = Object.keys;

// === Prototype Utilities ===

// From get-proto/Reflect.getPrototypeOf.js
var $ReflectGPO = (typeof Reflect !== 'undefined' && Reflect.getPrototypeOf) || null;

// From get-proto/Object.getPrototypeOf.js
var $ObjectGPO = $Object.getPrototypeOf;

// From dunder-proto/get.js
var getDunderProto = (function() {
	var hasProtoAccessor;
	try {
		// eslint-disable-next-line no-extra-parens, no-proto
		hasProtoAccessor = [].__proto__ === Array.prototype;
	} catch (e) {
		if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'ERR_PROTO_ACCESS') {
			throw e;
		}
	}

	// eslint-disable-next-line no-extra-parens
	var desc = !!hasProtoAccessor && gopd && gopd(Object.prototype, '__proto__');

	var $getPrototypeOf = $Object.getPrototypeOf;

	return desc && typeof desc.get === 'function'
		? callBindBasic([desc.get])
		: typeof $getPrototypeOf === 'function'
			? function getDunder(value) {
				// eslint-disable-next-line eqeqeq
				return $getPrototypeOf(value == null ? value : $Object(value));
			}
			: false;
})();

// From get-proto/index.js
var getProto = $ReflectGPO
	? function getProto(O) {
		return $ReflectGPO(O);
	}
	: $ObjectGPO
		? function getProto(O) {
			if (!O || (typeof O !== 'object' && typeof O !== 'function')) {
				throw new TypeError('getProto: not an object');
			}
			return $ObjectGPO(O);
		}
		: getDunderProto
			? function getProto(O) {
				return getDunderProto(O);
			}
			: null;

// === Property Definition ===

// From functions-have-names/index.js
var functionsHaveNames = function functionsHaveNames() {
	return typeof function f() {}.name === 'string';
};

functionsHaveNames.functionsHaveConfigurableNames = function functionsHaveConfigurableNames() {
	if (!functionsHaveNames() || !gopd) {
		return false;
	}
	var desc = gopd(function () {}, 'name');
	return !!desc && !!desc.configurable;
};

var $bind = Function.prototype.bind;

functionsHaveNames.boundFunctionsHaveNames = function boundFunctionsHaveNames() {
	return functionsHaveNames() && typeof $bind === 'function' && function f() {}.bind().name !== '';
};

// From define-data-property/index.js
var defineDataProperty = function defineDataProperty(
	obj,
	property,
	value
) {
	if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) {
		throw new TypeError('`obj` must be an object or a function`');
	}
	if (typeof property !== 'string' && typeof property !== 'symbol') {
		throw new TypeError('`property` must be a string or a symbol`');
	}
	if (arguments.length > 3 && typeof arguments[3] !== 'boolean' && arguments[3] !== null) {
		throw new TypeError('`nonEnumerable`, if provided, must be a boolean or null');
	}
	if (arguments.length > 4 && typeof arguments[4] !== 'boolean' && arguments[4] !== null) {
		throw new TypeError('`nonWritable`, if provided, must be a boolean or null');
	}
	if (arguments.length > 5 && typeof arguments[5] !== 'boolean' && arguments[5] !== null) {
		throw new TypeError('`nonConfigurable`, if provided, must be a boolean or null');
	}
	if (arguments.length > 6 && typeof arguments[6] !== 'boolean') {
		throw new TypeError('`loose`, if provided, must be a boolean');
	}

	var nonEnumerable = arguments.length > 3 ? arguments[3] : null;
	var nonWritable = arguments.length > 4 ? arguments[4] : null;
	var nonConfigurable = arguments.length > 5 ? arguments[5] : null;
	var loose = arguments.length > 6 ? arguments[6] : false;

	/* @type {false | TypedPropertyDescriptor<unknown>} */
	var desc = !!gopd && gopd(obj, property);

	if ($defineProperty) {
		$defineProperty(obj, property, {
			configurable: nonConfigurable === null && desc ? desc.configurable : !nonConfigurable,
			enumerable: nonEnumerable === null && desc ? desc.enumerable : !nonEnumerable,
			value: value,
			writable: nonWritable === null && desc ? desc.writable : !nonWritable
		});
	} else if (loose || (!nonEnumerable && !nonWritable && !nonConfigurable)) {
		// must fall back to [[Set]], and was not explicitly asked to make non-enumerable, non-writable, or non-configurable
		obj[property] = value; // eslint-disable-line no-param-reassign
	} else {
		throw new SyntaxError('This environment does not support defining a property as non-configurable, non-writable, or non-enumerable.');
	}
};

// From define-properties/index.js
var defineProperties = function(object, map) {
	var toStr = Object.prototype.toString;
	var concat = Array.prototype.concat;
	var supportsDescriptors = hasPropertyDescriptors();

	var isFunction = function (fn) {
		return typeof fn === 'function' && toStr.call(fn) === '[object Function]';
	};

	var defineProperty = function (object, name, value, predicate) {
		if (name in object) {
			if (predicate === true) {
				if (object[name] === value) {
					return;
				}
			} else if (!isFunction(predicate) || !predicate()) {
				return;
			}
		}

		if (supportsDescriptors) {
			defineDataProperty(object, name, value, true);
		} else {
			defineDataProperty(object, name, value);
		}
	};

	var predicates = arguments.length > 2 ? arguments[2] : {};
	var props = objectKeys(map);
	if (hasSymbols()) {
		props = concat.call(props, Object.getOwnPropertySymbols(map));
	}
	for (var i = 0; i < props.length; i += 1) {
		defineProperty(object, props[i], map[props[i]], predicates[props[i]]);
	}
};

defineProperties.supportsDescriptors = !!hasPropertyDescriptors();

// From set-function-name/index.js
var setFunctionName = function setFunctionName(fn, name) {
	if (typeof fn !== 'function') {
		throw new TypeError('`fn` is not a function');
	}
	var loose = arguments.length > 2 && !!arguments[2];
	if (!loose || functionsHaveNames.functionsHaveConfigurableNames()) {
		if (hasPropertyDescriptors()) {
			defineDataProperty(fn, 'name', name, true, true);
		} else {
			defineDataProperty(fn, 'name', name);
		}
	}
	return fn;
};

// === Get Intrinsics ===

// From call-bound/index.js
var callBound = function callBoundIntrinsic(name, allowMissing) {
	/* eslint no-extra-parens: 0 */

	var intrinsic = GetIntrinsic(name, !!allowMissing);
	var $indexOf = callBindBasic([Function.prototype.indexOf || String.prototype.indexOf]);
	if (typeof intrinsic === 'function' && $indexOf(name, '.prototype.') > -1) {
		return callBindBasic([intrinsic]);
	}
	return intrinsic;
};


// Massive get-intrinsic implementation
// From get-intrinsic/index.js
var GetIntrinsic = (function() {
	var undefined;

	var throwTypeError = function () {
		throw new TypeError();
	};
	var ThrowTypeError = gopd
		? (function () {
			try {
				// eslint-disable-next-line no-unused-expressions, no-caller, no-restricted-properties
				arguments.callee; // IE 8 does not throw here
				return throwTypeError;
			} catch (calleeThrows) {
				try {
					// IE 8 throws on Object.getOwnPropertyDescriptor(arguments, '')
					return gopd(arguments, 'callee').get;
				} catch (gOPDthrows) {
					return throwTypeError;
				}
			}
		}())
		: throwTypeError;

	var TypedArray = typeof Uint8Array === 'undefined' || !getProto ? undefined : getProto(Uint8Array);

	var INTRINSICS = {
		__proto__: null,
		'%AggregateError%': typeof AggregateError === 'undefined' ? undefined : AggregateError,
		'%Array%': Array,
		'%ArrayBuffer%': typeof ArrayBuffer === 'undefined' ? undefined : ArrayBuffer,
		'%ArrayIteratorPrototype%': hasSymbols() && getProto ? getProto([][Symbol.iterator]()) : undefined,
		'%AsyncFromSyncIteratorPrototype%': undefined,
		'%Atomics%': typeof Atomics === 'undefined' ? undefined : Atomics,
		'%BigInt%': typeof BigInt === 'undefined' ? undefined : BigInt,
		'%BigInt64Array%': typeof BigInt64Array === 'undefined' ? undefined : BigInt64Array,
		'%BigUint64Array%': typeof BigUint64Array === 'undefined' ? undefined : BigUint64Array,
		'%Boolean%': Boolean,
		'%DataView%': typeof DataView === 'undefined' ? undefined : DataView,
		'%Date%': Date,
		'%decodeURI%': decodeURI,
		'%decodeURIComponent%': decodeURIComponent,
		'%encodeURI%': encodeURI,
		'%encodeURIComponent%': encodeURIComponent,
		'%Error%': Error,
		'%eval%': eval, // eslint-disable-line no-eval
		'%EvalError%': EvalError,
		'%Float16Array%': typeof Float16Array === 'undefined' ? undefined : Float16Array,
		'%Float32Array%': typeof Float32Array === 'undefined' ? undefined : Float32Array,
		'%Float64Array%': typeof Float64Array === 'undefined' ? undefined : Float64Array,
		'%FinalizationRegistry%': typeof FinalizationRegistry === 'undefined' ? undefined : FinalizationRegistry,
		'%Function%': Function,
		'%Int8Array%': typeof Int8Array === 'undefined' ? undefined : Int8Array,
		'%Int16Array%': typeof Int16Array === 'undefined' ? undefined : Int16Array,
		'%Int32Array%': typeof Int32Array === 'undefined' ? undefined : Int32Array,
		'%isFinite%': isFinite,
		'%isNaN%': isNaN,
		'%IteratorPrototype%': hasSymbols() && getProto ? getProto(getProto([][Symbol.iterator]())) : undefined,
		'%JSON%': typeof JSON === 'object' ? JSON : undefined,
		'%Map%': typeof Map === 'undefined' ? undefined : Map,
		'%MapIteratorPrototype%': typeof Map === 'undefined' || !hasSymbols() || !getProto ? undefined : getProto(new Map()[Symbol.iterator]()),
		'%Math%': Math,
		'%Number%': Number,
		'%Object%': $Object,
		'%Object.getOwnPropertyDescriptor%': gopd,
		'%parseFloat%': parseFloat,
		'%parseInt%': parseInt,
		'%Promise%': typeof Promise === 'undefined' ? undefined : Promise,
		'%Proxy%': typeof Proxy === 'undefined' ? undefined : Proxy,
		'%RangeError%': RangeError,
		'%ReferenceError%': ReferenceError,
		'%Reflect%': typeof Reflect === 'undefined' ? undefined : Reflect,
		'%RegExp%': RegExp,
		'%Set%': typeof Set === 'undefined' ? undefined : Set,
		'%SetIteratorPrototype%': typeof Set === 'undefined' || !hasSymbols() || !getProto ? undefined : getProto(new Set()[Symbol.iterator]()),
		'%SharedArrayBuffer%': typeof SharedArrayBuffer === 'undefined' ? undefined : SharedArrayBuffer,
		'%String%': String,
		'%StringIteratorPrototype%': hasSymbols() && getProto ? getProto(''[Symbol.iterator]()) : undefined,
		'%Symbol%': hasSymbols() ? Symbol : undefined,
		'%SyntaxError%': SyntaxError,
		'%ThrowTypeError%': ThrowTypeError,
		'%TypedArray%': TypedArray,
		'%TypeError%': TypeError,
		'%Uint8Array%': typeof Uint8Array === 'undefined' ? undefined : Uint8Array,
		'%Uint8ClampedArray%': typeof Uint8ClampedArray === 'undefined' ? undefined : Uint8ClampedArray,
		'%Uint16Array%': typeof Uint16Array === 'undefined' ? undefined : Uint16Array,
		'%Uint32Array%': typeof Uint32Array === 'undefined' ? undefined : Uint32Array,
		'%URIError%': URIError,
		'%WeakMap%': typeof WeakMap === 'undefined' ? undefined : WeakMap,
		'%WeakRef%': typeof WeakRef === 'undefined' ? undefined : WeakRef,
		'%WeakSet%': typeof WeakSet === 'undefined' ? undefined : WeakSet,

		'%Function.prototype.call%': $call,
		'%Function.prototype.apply%': $apply,
		'%Object.defineProperty%': $defineProperty,
		'%Object.getPrototypeOf%': $ObjectGPO,
		'%Math.abs%': abs,
		'%Math.floor%': floor,
		'%Math.max%': max,
		'%Math.min%': min,
		'%Math.pow%': pow,
		'%Math.round%': round,
		'%Math.sign%': sign,
		'%Reflect.getPrototypeOf%': $ReflectGPO
	};

	if (getProto) {
		try {
			null.error; // eslint-disable-line no-unused-expressions
		} catch (e) {
			// https://github.com/tc39/proposal-shadowrealm/pull/384#issuecomment-1364264229
			var errorProto = getProto(getProto(e));
			INTRINSICS['%Error.prototype%'] = errorProto;
		}
	}

	var LEGACY_ALIASES = {
		__proto__: null,
		'%ArrayBufferPrototype%': ['ArrayBuffer', 'prototype'],
		'%ArrayPrototype%': ['Array', 'prototype'],
		'%ArrayProto_entries%': ['Array', 'prototype', 'entries'],
		'%ArrayProto_forEach%': ['Array', 'prototype', 'forEach'],
		'%ArrayProto_keys%': ['Array', 'prototype', 'keys'],
		'%ArrayProto_values%': ['Array', 'prototype', 'values'],
		'%AsyncFunctionPrototype%': ['AsyncFunction', 'prototype'],
		'%AsyncGenerator%': ['AsyncGeneratorFunction', 'prototype'],
		'%AsyncGeneratorPrototype%': ['AsyncGeneratorFunction', 'prototype', 'prototype'],
		'%BooleanPrototype%': ['Boolean', 'prototype'],
		'%DataViewPrototype%': ['DataView', 'prototype'],
		'%DatePrototype%': ['Date', 'prototype'],
		'%ErrorPrototype%': ['Error', 'prototype'],
		'%EvalErrorPrototype%': ['EvalError', 'prototype'],
		'%Float32ArrayPrototype%': ['Float32Array', 'prototype'],
		'%Float64ArrayPrototype%': ['Float64Array', 'prototype'],
		'%FunctionPrototype%': ['Function', 'prototype'],
		'%Generator%': ['GeneratorFunction', 'prototype'],
		'%GeneratorPrototype%': ['GeneratorFunction', 'prototype', 'prototype'],
		'%Int8ArrayPrototype%': ['Int8Array', 'prototype'],
		'%Int16ArrayPrototype%': ['Int16Array', 'prototype'],
		'%Int32ArrayPrototype%': ['Int32Array', 'prototype'],
		'%JSONParse%': ['JSON', 'parse'],
		'%JSONStringify%': ['JSON', 'stringify'],
		'%MapPrototype%': ['Map', 'prototype'],
		'%NumberPrototype%': ['Number', 'prototype'],
		'%ObjectPrototype%': ['Object', 'prototype'],
		'%ObjProto_toString%': ['Object', 'prototype', 'toString'],
		'%ObjProto_valueOf%': ['Object', 'prototype', 'valueOf'],
		'%PromisePrototype%': ['Promise', 'prototype'],
		'%PromiseProto_then%': ['Promise', 'prototype', 'then'],
		'%Promise_all%': ['Promise', 'all'],
		'%Promise_reject%': ['Promise', 'reject'],
		'%Promise_resolve%': ['Promise', 'resolve'],
		'%RangeErrorPrototype%': ['RangeError', 'prototype'],
		'%ReferenceErrorPrototype%': ['ReferenceError', 'prototype'],
		'%RegExpPrototype%': ['RegExp', 'prototype'],
		'%SetPrototype%': ['Set', 'prototype'],
		'%SharedArrayBufferPrototype%': ['SharedArrayBuffer', 'prototype'],
		'%StringPrototype%': ['String', 'prototype'],
		'%SymbolPrototype%': ['Symbol', 'prototype'],
		'%SyntaxErrorPrototype%': ['SyntaxError', 'prototype'],
		'%TypedArrayPrototype%': ['TypedArray', 'prototype'],
		'%TypeErrorPrototype%': ['TypeError', 'prototype'],
		'%Uint8ArrayPrototype%': ['Uint8Array', 'prototype'],
		'%Uint8ClampedArrayPrototype%': ['Uint8ClampedArray', 'prototype'],
		'%Uint16ArrayPrototype%': ['Uint16Array', 'prototype'],
		'%Uint32ArrayPrototype%': ['Uint32Array', 'prototype'],
		'%URIErrorPrototype%': ['URIError', 'prototype'],
		'%WeakMapPrototype%': ['WeakMap', 'prototype'],
		'%WeakSetPrototype%': ['WeakSet', 'prototype']
	};

	var $concat = bind.call($call, Array.prototype.concat);
	var $spliceApply = bind.call($apply, Array.prototype.splice);
	var $replace = bind.call($call, String.prototype.replace);
	var $strSlice = bind.call($call, String.prototype.slice);
	var $exec = bind.call($call, RegExp.prototype.exec);

	/* adapted from https://github.com/lodash/lodash/blob/4.17.15/dist/lodash.js#L6735-L6744 */
	var rePropName = /[^%.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|%$))/g;
	var reEscapeChar = /\\(\\)?/g; /** Used to match backslashes in property paths. */
	var stringToPath = function stringToPath(string) {
		var first = $strSlice(string, 0, 1);
		var last = $strSlice(string, -1);
		if (first === '%' && last !== '%') {
			throw new SyntaxError('invalid intrinsic syntax, expected closing `%`');
		} else if (last === '%' && first !== '%') {
			throw new SyntaxError('invalid intrinsic syntax, expected opening `%`');
		}
		var result = [];
		$replace(string, rePropName, function (match, number, quote, subString) {
			result[result.length] = quote ? $replace(subString, reEscapeChar, '$1') : number || match;
		});
		return result;
	};
	/* end adaptation */

	var getBaseIntrinsic = function getBaseIntrinsic(name, allowMissing) {
		var intrinsicName = name;
		var alias;
		if (hasown(LEGACY_ALIASES, intrinsicName)) {
			alias = LEGACY_ALIASES[intrinsicName];
			intrinsicName = '%' + alias[0] + '%';
		}

		if (hasown(INTRINSICS, intrinsicName)) {
			var value = INTRINSICS[intrinsicName];
			if (typeof value === 'undefined' && !allowMissing) {
				throw new TypeError('intrinsic ' + name + ' exists, but is not available. Please file an issue!');
			}

			return {
				alias: alias,
				name: intrinsicName,
				value: value
			};
		}

		throw new SyntaxError('intrinsic ' + name + ' does not exist!');
	};

	return function GetIntrinsic(name, allowMissing) {
		if (typeof name !== 'string' || name.length === 0) {
			throw new TypeError('intrinsic name must be a non-empty string');
		}
		if (arguments.length > 1 && typeof allowMissing !== 'boolean') {
			throw new TypeError('"allowMissing" argument must be a boolean');
		}

		if ($exec(/^%?[^%]*%?$/, name) === null) {
			throw new SyntaxError('`%` may not be present anywhere but at the beginning and end of the intrinsic name');
		}
		var parts = stringToPath(name);
		var intrinsicBaseName = parts.length > 0 ? parts[0] : '';

		var intrinsic = getBaseIntrinsic('%' + intrinsicBaseName + '%', allowMissing);
		var intrinsicRealName = intrinsic.name;
		var value = intrinsic.value;
		var skipFurtherCaching = false;

		var alias = intrinsic.alias;
		if (alias) {
			intrinsicBaseName = alias[0];
			$spliceApply(parts, $concat([0, 1], alias));
		}

		for (var i = 1, isOwn = true; i < parts.length; i += 1) {
			var part = parts[i];
			var first = $strSlice(part, 0, 1);
			var last = $strSlice(part, -1);
			if (
				(
					(first === '"' || first === "'" || first === '`')
					|| (last === '"' || last === "'" || last === '`')
				)
				&& first !== last
			) {
				throw new SyntaxError('property names with quotes must have matching quotes');
			}
			if (part === 'constructor' || !isOwn) {
				skipFurtherCaching = true;
			}

			intrinsicBaseName += '.' + part;
			intrinsicRealName = '%' + intrinsicBaseName + '%';

			if (hasown(INTRINSICS, intrinsicRealName)) {
				value = INTRINSICS[intrinsicRealName];
			} else if (value != null) {
				if (!(part in value)) {
					if (!allowMissing) {
						throw new TypeError('base intrinsic for ' + name + ' exists, but the property is not available.');
					}
					return void undefined;
				}
				if (gopd && (i + 1) >= parts.length) {
					var desc = gopd(value, part);
					isOwn = !!desc;

					// By convention, when a data property is converted to an accessor
					// property to emulate a data property that does not suffer from
					// the override mistake, that accessor's getter is marked with
					// an `originalValue` property. Here, when we detect this, we
					// uphold the illusion by pretending to see that original data
					// property, i.e., returning the value rather than the getter
					// itself.
					if (isOwn && 'get' in desc && !('originalValue' in desc.get)) {
						value = desc.get;
					} else {
						value = value[part];
					}
				} else {
					isOwn = hasown(value, part);
					value = value[part];
				}

				if (isOwn && !skipFurtherCaching) {
					INTRINSICS[intrinsicRealName] = value;
				}
			}
		}
		return value;
	};
})();

// === ES-Abstract Dependencies ===

// From es-object-atoms/isObject.js
var isObject = function isObject(x) {
	return !!x && (typeof x === 'function' || typeof x === 'object');
};

// From es-abstract/helpers/isPropertyKey.js
var isPropertyKey = function isPropertyKey(argument) {
	return typeof argument === 'string' || typeof argument === 'symbol';
};

// From es-abstract/helpers/isPrimitive.js
var isPrimitive = function isPrimitive(value) {
	return value === null || (typeof value !== 'function' && typeof value !== 'object');
};

// From es-abstract/2025/SameValue.js
var SameValue = function SameValue(x, y) {
	if (x === y) { // 0 === -0, but they are not identical.
		if (x === 0) { return 1 / x === 1 / y; }
		return true;
	}
	return $isNaN(x) && $isNaN(y);
};

// From es-abstract/2025/ToBoolean.js
var ToBoolean = function ToBoolean(value) { return !!value; };

// From is-callable/index.js
var isCallable = (function() {
	var fnToStr = Function.prototype.toString;
	var reflectApply = typeof Reflect === 'object' && Reflect !== null && Reflect.apply;
	var badArrayLike;
	var isCallableMarker;
	if (typeof reflectApply === 'function' && typeof Object.defineProperty === 'function') {
		try {
			badArrayLike = Object.defineProperty({}, 'length', {
				get: function () {
					throw isCallableMarker;
				}
			});
			isCallableMarker = {};
			// eslint-disable-next-line no-throw-literal
			reflectApply(function () { throw 42; }, null, badArrayLike);
		} catch (_) {
			if (_ !== isCallableMarker) {
				reflectApply = null;
			}
		}
	} else {
		reflectApply = null;
	}

	var constructorRegex = /^\s*class\b/;
	var isES6ClassFn = function isES6ClassFunction(value) {
		try {
			var fnStr = fnToStr.call(value);
			return constructorRegex.test(fnStr);
		} catch (e) {
			return false; // not a function
		}
	};

	var tryFunctionObject = function tryFunctionToStr(value) {
		try {
			if (isES6ClassFn(value)) { return false; }
			fnToStr.call(value);
			return true;
		} catch (e) {
			return false;
		}
	};
	var toStr = Object.prototype.toString;
	var objectClass = '[object Object]';
	var fnClass = '[object Function]';
	var genClass = '[object GeneratorFunction]';
	var ddaClass = '[object HTMLAllCollection]'; // IE 11
	var ddaClass2 = '[object HTML document.all class]';
	var ddaClass3 = '[object HTMLCollection]'; // IE 9-10
	var hasToStringTag = typeof Symbol === 'function' && !!Symbol.toStringTag; // better: use `has-tostringtag`

	var isIE68 = !(0 in [,]); // eslint-disable-line no-sparse-arrays, comma-spacing

	var isDDA = function isDocumentDotAll() { return false; };
	if (typeof document === 'object') {
		// Firefox 3 canonicalizes DDA to undefined when it's not accessed directly
		var all = document.all;
		if (toStr.call(all) === toStr.call(document.all)) {
			isDDA = function isDocumentDotAll(value) {
				/* globals document: false */
				// in IE 6-8, typeof document.all is "object" and it's truthy
				if ((isIE68 || !value) && (typeof value === 'undefined' || typeof value === 'object')) {
					try {
						var str = toStr.call(value);
						return (
							str === ddaClass
							|| str === ddaClass2
							|| str === ddaClass3 // opera 12.16
							|| str === objectClass // IE 6-8
						) && value('') == null; // eslint-disable-line eqeqeq
					} catch (e) { /**/ }
				}
				return false;
			};
		}
	}

	return reflectApply
		? function isCallable(value) {
			if (isDDA(value)) { return true; }
			if (!value) { return false; }
			if (typeof value !== 'function' && typeof value !== 'object') { return false; }
			try {
				reflectApply(value, null, badArrayLike);
			} catch (e) {
				if (e !== isCallableMarker) { return false; }
			}
			return !isES6ClassFn(value) && tryFunctionObject(value);
		}
		: function isCallable(value) {
			if (isDDA(value)) { return true; }
			if (!value) { return false; }
			if (typeof value !== 'function' && typeof value !== 'object') { return false; }
			if (hasToStringTag) { return tryFunctionObject(value); }
			if (isES6ClassFn(value)) { return false; }
			var strClass = toStr.call(value);
			if (strClass !== fnClass && strClass !== genClass && !(/^\[object HTML/).test(strClass)) { return false; }
			return tryFunctionObject(value);
		};
})();

// From es-abstract/helpers/records/property-descriptor.js
var isPropertyDescriptor = function isPropertyDescriptor(Desc) {
	if (!Desc || typeof Desc !== 'object') {
		return false;
	}

	var allowed = {
		__proto__: null,
		'[[Configurable]]': true,
		'[[Enumerable]]': true,
		'[[Get]]': true,
		'[[Set]]': true,
		'[[Value]]': true,
		'[[Writable]]': true
	};

	for (var key in Desc) { // eslint-disable-line
		if (hasown(Desc, key) && !allowed[key]) {
			return false;
		}
	}

	var isData = hasown(Desc, '[[Value]]') || hasown(Desc, '[[Writable]]');
	var IsAccessor = hasown(Desc, '[[Get]]') || hasown(Desc, '[[Set]]');
	if (isData && IsAccessor) {
		throw new TypeError('Property Descriptors may not be both accessor and data descriptors');
	}
	return true;
};

// From es-abstract/2025/IsAccessorDescriptor.js
var IsAccessorDescriptor = function IsAccessorDescriptor(Desc) {
	if (typeof Desc === 'undefined') {
		return false;
	}

	if (!hasown(Desc, '[[Get]]') && !hasown(Desc, '[[Set]]')) {
		return false;
	}

	return true;
};

// From es-abstract/2025/IsDataDescriptor.js
var IsDataDescriptor = function IsDataDescriptor(Desc) {
	if (typeof Desc === 'undefined') {
		return false;
	}

	if (!hasown(Desc, '[[Value]]') && !hasown(Desc, '[[Writable]]')) {
		return false;
	}

	return true;
};

// From es-abstract/2025/IsGenericDescriptor.js
var IsGenericDescriptor = function IsGenericDescriptor(Desc) {
	if (typeof Desc === 'undefined') {
		return false;
	}

	if (!IsAccessorDescriptor(Desc) && !IsDataDescriptor(Desc)) {
		return true;
	}

	return false;
};

// From es-abstract/2025/IsExtensible.js
var IsExtensible = (function() {
	var $preventExtensions = GetIntrinsic('%Object.preventExtensions%', true);
	var $isExtensible = GetIntrinsic('%Object.isExtensible%', true);

	return $preventExtensions
		? function IsExtensible(obj) {
			return !isPrimitive(obj) && $isExtensible(obj);
		}
		: function IsExtensible(obj) {
			return !isPrimitive(obj);
		};
})();

var IsArray = Array.isArray;

// From es-abstract/helpers/fromPropertyDescriptor.js
var fromPropertyDescriptor = function fromPropertyDescriptor(Desc) {
	if (typeof Desc === 'undefined') {
		return Desc;
	}
	var obj = {};
	if ('[[Value]]' in Desc) {
		obj.value = Desc['[[Value]]'];
	}
	if ('[[Writable]]' in Desc) {
		obj.writable = !!Desc['[[Writable]]'];
	}
	if ('[[Get]]' in Desc) {
		obj.get = Desc['[[Get]]'];
	}
	if ('[[Set]]' in Desc) {
		obj.set = Desc['[[Set]]'];
	}
	if ('[[Enumerable]]' in Desc) {
		obj.enumerable = !!Desc['[[Enumerable]]'];
	}
	if ('[[Configurable]]' in Desc) {
		obj.configurable = !!Desc['[[Configurable]]'];
	}
	return obj;
};

// From es-abstract/2025/FromPropertyDescriptor.js
var FromPropertyDescriptor = function FromPropertyDescriptor(Desc) {
	return fromPropertyDescriptor(Desc);
};

// From es-abstract/2025/ToPropertyDescriptor.js
var ToPropertyDescriptor = function ToPropertyDescriptor(Obj) {
	if (!isObject(Obj)) {
		throw new TypeError('ToPropertyDescriptor requires an object');
	}

	var desc = {};
	if (hasown(Obj, 'enumerable')) {
		desc['[[Enumerable]]'] = ToBoolean(Obj.enumerable);
	}
	if (hasown(Obj, 'configurable')) {
		desc['[[Configurable]]'] = ToBoolean(Obj.configurable);
	}
	if (hasown(Obj, 'value')) {
		desc['[[Value]]'] = Obj.value;
	}
	if (hasown(Obj, 'writable')) {
		desc['[[Writable]]'] = ToBoolean(Obj.writable);
	}
	if (hasown(Obj, 'get')) {
		var getter = Obj.get;
		if (typeof getter !== 'undefined' && !isCallable(getter)) {
			throw new TypeError('getter must be a function');
		}
		desc['[[Get]]'] = getter;
	}
	if (hasown(Obj, 'set')) {
		var setter = Obj.set;
		if (typeof setter !== 'undefined' && !isCallable(setter)) {
			throw new TypeError('setter must be a function');
		}
		desc['[[Set]]'] = setter;
	}

	if ((hasown(desc, '[[Get]]') || hasown(desc, '[[Set]]')) && (hasown(desc, '[[Value]]') || hasown(desc, '[[Writable]]'))) {
		throw new TypeError('Invalid property descriptor. Cannot both specify accessors and a value or writable attribute');
	}
	return desc;
};

// From es-abstract/helpers/isFullyPopulatedPropertyDescriptor.js
var isFullyPopulatedPropertyDescriptor = function isFullyPopulatedPropertyDescriptor(ES, Desc) {
	return isPropertyDescriptor(Desc)
		&& '[[Enumerable]]' in Desc
		&& '[[Configurable]]' in Desc
		&& (ES.IsAccessorDescriptor(Desc) || ES.IsDataDescriptor(Desc));
};

// From es-abstract/helpers/DefineOwnProperty.js
var DefineOwnProperty = function DefineOwnProperty(IsDataDescriptor, SameValue, FromPropertyDescriptor, O, P, desc) {
	var hasArrayLengthDefineBug = hasPropertyDescriptors.hasArrayLengthDefineBug();
	var $isEnumerable = callBound('Object.prototype.propertyIsEnumerable');

	if (!$defineProperty) {
		if (!IsDataDescriptor(desc)) {
			// ES3 does not support getters/setters
			return false;
		}
		if (!desc['[[Configurable]]'] || !desc['[[Writable]]']) {
			return false;
		}

		// fallback for ES3
		if (P in O && $isEnumerable(O, P) !== !!desc['[[Enumerable]]']) {
			// a non-enumerable existing property
			return false;
		}

		// property does not exist at all, or exists but is enumerable
		var V = desc['[[Value]]'];
		// eslint-disable-next-line no-param-reassign
		O[P] = V; // will use [[Define]]
		return SameValue(O[P], V);
	}
	if (
		hasArrayLengthDefineBug
		&& P === 'length'
		&& '[[Value]]' in desc
		&& IsArray(O)
		&& O.length !== desc['[[Value]]']
	) {
		// eslint-disable-next-line no-param-reassign
		O.length = desc['[[Value]]'];
		return O.length === desc['[[Value]]'];
	}

	$defineProperty(O, P, FromPropertyDescriptor(desc));
	return true;
};

// From es-abstract/2025/ValidateAndApplyPropertyDescriptor.js
var ValidateAndApplyPropertyDescriptor = function ValidateAndApplyPropertyDescriptor(O, P, extensible, Desc, current) {
	if (typeof current === 'undefined') { // step 2
		if (!extensible) {
			return false; // step 2.a
		}
		if (typeof O === 'undefined') {
			return true; // step 2.b
		}
		if (IsAccessorDescriptor(Desc)) { // step 2.c
			return DefineOwnProperty(
				IsDataDescriptor,
				SameValue,
				FromPropertyDescriptor,
				O,
				P,
				Desc
			);
		}
		// step 2.d
		return DefineOwnProperty(
			IsDataDescriptor,
			SameValue,
			FromPropertyDescriptor,
			O,
			P,
			{
				'[[Configurable]]': !!Desc['[[Configurable]]'],
				'[[Enumerable]]': !!Desc['[[Enumerable]]'],
				'[[Value]]': Desc['[[Value]]'],
				'[[Writable]]': !!Desc['[[Writable]]']
			}
		);
	}

	// 3. Assert: current is a fully populated Property Descriptor.
	if (
		!isFullyPopulatedPropertyDescriptor(
			{
				IsAccessorDescriptor: IsAccessorDescriptor,
				IsDataDescriptor: IsDataDescriptor
			},
			current
		)
	) {
		throw new TypeError('`current`, when present, must be a fully populated and valid Property Descriptor');
	}

	// 4. If every field in Desc is absent, return true.
	// this can't really match the assertion that it's a Property Descriptor in our JS implementation

	// 5. If current.[[Configurable]] is false, then
	if (!current['[[Configurable]]']) {
		if ('[[Configurable]]' in Desc && Desc['[[Configurable]]']) {
			// step 5.a
			return false;
		}
		if ('[[Enumerable]]' in Desc && !SameValue(Desc['[[Enumerable]]'], current['[[Enumerable]]'])) {
			// step 5.b
			return false;
		}
		if (!IsGenericDescriptor(Desc) && !SameValue(IsAccessorDescriptor(Desc), IsAccessorDescriptor(current))) {
			// step 5.c
			return false;
		}
		if (IsAccessorDescriptor(current)) { // step 5.d
			if ('[[Get]]' in Desc && !SameValue(Desc['[[Get]]'], current['[[Get]]'])) {
				return false;
			}
			if ('[[Set]]' in Desc && !SameValue(Desc['[[Set]]'], current['[[Set]]'])) {
				return false;
			}
		} else if (!current['[[Writable]]']) { // step 5.e
			if ('[[Writable]]' in Desc && Desc['[[Writable]]']) {
				return false;
			}
			if ('[[Value]]' in Desc && !SameValue(Desc['[[Value]]'], current['[[Value]]'])) {
				return false;
			}
		}
	}

	// 6. If O is not undefined, then
	if (typeof O !== 'undefined') {
		var configurable;
		var enumerable;
		if (IsDataDescriptor(current) && IsAccessorDescriptor(Desc)) { // step 6.a
			configurable = ('[[Configurable]]' in Desc ? Desc : current)['[[Configurable]]'];
			enumerable = ('[[Enumerable]]' in Desc ? Desc : current)['[[Enumerable]]'];
			// Replace the property named P of object O with an accessor property having [[Configurable]] and [[Enumerable]] attributes as described by current and each other attribute set to its default value.
			return DefineOwnProperty(
				IsDataDescriptor,
				SameValue,
				FromPropertyDescriptor,
				O,
				P,
				{
					'[[Configurable]]': !!configurable,
					'[[Enumerable]]': !!enumerable,
					'[[Get]]': ('[[Get]]' in Desc ? Desc : current)['[[Get]]'],
					'[[Set]]': ('[[Set]]' in Desc ? Desc : current)['[[Set]]']
				}
			);
		} else if (IsAccessorDescriptor(current) && IsDataDescriptor(Desc)) {
			configurable = ('[[Configurable]]' in Desc ? Desc : current)['[[Configurable]]'];
			enumerable = ('[[Enumerable]]' in Desc ? Desc : current)['[[Enumerable]]'];
			// i. Replace the property named P of object O with a data property having [[Configurable]] and [[Enumerable]] attributes as described by current and each other attribute set to its default value.
			return DefineOwnProperty(
				IsDataDescriptor,
				SameValue,
				FromPropertyDescriptor,
				O,
				P,
				{
					'[[Configurable]]': !!configurable,
					'[[Enumerable]]': !!enumerable,
					'[[Value]]': ('[[Value]]' in Desc ? Desc : current)['[[Value]]'],
					'[[Writable]]': !!('[[Writable]]' in Desc ? Desc : current)['[[Writable]]']
				}
			);
		}

		// For each field of Desc that is present, set the corresponding attribute of the property named P of object O to the value of the field.
		return DefineOwnProperty(
			IsDataDescriptor,
			SameValue,
			FromPropertyDescriptor,
			O,
			P,
			Desc
		);
	}

	return true; // step 7
};

// From es-abstract/2025/OrdinaryDefineOwnProperty.js
var OrdinaryDefineOwnProperty = function OrdinaryDefineOwnProperty(O, P, Desc) {
	if (!gopd) {
		// ES3/IE 8 fallback
		if (IsAccessorDescriptor(Desc)) {
			throw new SyntaxError('This environment does not support accessor property descriptors.');
		}
		var creatingNormalDataProperty = !(P in O)
			&& Desc['[[Writable]]']
			&& Desc['[[Enumerable]]']
			&& Desc['[[Configurable]]']
			&& '[[Value]]' in Desc;
		var settingExistingDataProperty = (P in O)
			&& (!('[[Configurable]]' in Desc) || Desc['[[Configurable]]'])
			&& (!('[[Enumerable]]' in Desc) || Desc['[[Enumerable]]'])
			&& (!('[[Writable]]' in Desc) || Desc['[[Writable]]'])
			&& '[[Value]]' in Desc;
		if (creatingNormalDataProperty || settingExistingDataProperty) {
			O[P] = Desc['[[Value]]']; // eslint-disable-line no-param-reassign
			return SameValue(O[P], Desc['[[Value]]']);
		}
		throw new SyntaxError('This environment does not support defining non-writable, non-enumerable, or non-configurable properties');
	}
	var desc = gopd(O, P);
	var current = desc && ToPropertyDescriptor(desc);
	var extensible = IsExtensible(O);
	return ValidateAndApplyPropertyDescriptor(O, P, extensible, Desc, current);
};

// From es-abstract/2025/CreateDataProperty.js
var CreateDataProperty = function CreateDataProperty(O, P, V) {
	var newDesc = {
		'[[Configurable]]': true,
		'[[Enumerable]]': true,
		'[[Value]]': V,
		'[[Writable]]': true
	};
	return OrdinaryDefineOwnProperty(O, P, newDesc);
};

// From es-abstract/2025/CreateDataPropertyOrThrow.js
var CreateDataPropertyOrThrow = function CreateDataPropertyOrThrow(O, P, V) {
	var success = CreateDataProperty(O, P, V);
	if (!success) {
		throw new TypeError('unable to create data property');
	}
};

// From es-abstract/2025/Set.js
var Set = function Set(O, P, V, Throw) {
	// IE 9 does not throw in strict mode when writability/configurability/extensibility is violated
	var noThrowOnStrictViolation = (function () {
		try {
			delete [].length;
			return true;
		} catch (e) {
			return false;
		}
	}());

	if (Throw) {
		O[P] = V; // eslint-disable-line no-param-reassign
		if (noThrowOnStrictViolation && !SameValue(O[P], V)) {
			throw new TypeError('Attempted to assign to readonly property.');
		}
		return true;
	}
	try {
		O[P] = V; // eslint-disable-line no-param-reassign
		return noThrowOnStrictViolation ? SameValue(O[P], V) : true;
	} catch (e) {
		return false;
	}
};

// From es-abstract/2025/SetterThatIgnoresPrototypeProperties.js
var SetterThatIgnoresPrototypeProperties = function SetterThatIgnoresPrototypeProperties(thisValue, home, p, v) {
	if (SameValue(thisValue, home)) { // step 2
		throw new TypeError('Throwing here emulates assignment to a non-writable data property on the `home` object in strict mode code'); // step 2.b
	}

	var desc = gopd(thisValue, p); // step 3

	if (typeof desc === 'undefined') { // step 4
		CreateDataPropertyOrThrow(thisValue, p, v); // step 4.a
	} else { // step 5
		Set(thisValue, p, v, true); // step 5.a
	}
};

// === Iterator Helper Prototype Dependencies ===

// Hermes supports proto, so set to true by default
var hasProto = function() {
	return true;
}

// From es-abstract/2025/CreateIterResultObject.js
var CreateIterResultObject = function CreateIterResultObject(value, done) {
	return {
		value: value,
		done: done
	};
};

// === Side Channel Implementation ===

// Simplified object-inspect for our needs
var objectInspect = function inspect(obj) {
	if (typeof obj === 'string') {
		return '"' + obj + '"';
	}
	if (typeof obj === 'number' || typeof obj === 'boolean') {
		return String(obj);
	}
	if (obj === null) {
		return 'null';
	}
	if (typeof obj === 'undefined') {
		return 'undefined';
	}
	return Object.prototype.toString.call(obj);
};

// From side-channel-list/index.js
var getSideChannelList = function getSideChannelList() {
	var listGetNode = function (list, key, isDelete) {
		var prev = list;
		var curr;
		for (; (curr = prev.next) != null; prev = curr) {
			if (curr.key === key) {
				prev.next = curr.next;
				if (!isDelete) {
					curr.next = list.next;
					list.next = curr;
				}
				return curr;
			}
		}
	};

	var listGet = function (objects, key) {
		if (!objects) {
			return void undefined;
		}
		var node = listGetNode(objects, key);
		return node && node.value;
	};

	var listSet = function (objects, key, value) {
		var node = listGetNode(objects, key);
		if (node) {
			node.value = value;
		} else {
			objects.next = {
				key: key,
				next: objects.next,
				value: value
			};
		}
	};

	var listHas = function (objects, key) {
		if (!objects) {
			return false;
		}
		return !!listGetNode(objects, key);
	};

	var listDelete = function (objects, key) {
		if (objects) {
			return listGetNode(objects, key, true);
		}
	};

	var $o;

	var channel = {
		assert: function (key) {
			if (!channel.has(key)) {
				throw new TypeError('Side channel does not contain ' + objectInspect(key));
			}
		},
		'delete': function (key) {
			var root = $o && $o.next;
			var deletedNode = listDelete($o, key);
			if (deletedNode && root && root === deletedNode) {
				$o = void undefined;
			}
			return !!deletedNode;
		},
		get: function (key) {
			return listGet($o, key);
		},
		has: function (key) {
			return listHas($o, key);
		},
		set: function (key, value) {
			if (!$o) {
				$o = {
					next: void undefined
				};
			}
			listSet($o, key, value);
		}
	};
	return channel;
};

// From side-channel-map/index.js
var getSideChannelMap = (function() {
	var $Map = GetIntrinsic('%Map%', true);

	if (!$Map) {
		return false;
	}

	var $mapGet = callBound('Map.prototype.get', true);
	var $mapSet = callBound('Map.prototype.set', true);
	var $mapHas = callBound('Map.prototype.has', true);
	var $mapDelete = callBound('Map.prototype.delete', true);
	var $mapSize = callBound('Map.prototype.size', true);

	return function getSideChannelMap() {
		var $m;

		var channel = {
			assert: function (key) {
				if (!channel.has(key)) {
					throw new TypeError('Side channel does not contain ' + objectInspect(key));
				}
			},
			'delete': function (key) {
				if ($m) {
					var result = $mapDelete($m, key);
					if ($mapSize($m) === 0) {
						$m = void undefined;
					}
					return result;
				}
				return false;
			},
			get: function (key) {
				if ($m) {
					return $mapGet($m, key);
				}
			},
			has: function (key) {
				if ($m) {
					return $mapHas($m, key);
				}
				return false;
			},
			set: function (key, value) {
				if (!$m) {
					$m = new $Map();
				}
				$mapSet($m, key, value);
			}
		};

		return channel;
	};
})();

// From side-channel-weakmap/index.js
var getSideChannelWeakMap = (function() {
	var $WeakMap = GetIntrinsic('%WeakMap%', true);

	if (!$WeakMap) {
		return false;
	}

	var $weakMapGet = callBound('WeakMap.prototype.get', true);
	var $weakMapSet = callBound('WeakMap.prototype.set', true);
	var $weakMapHas = callBound('WeakMap.prototype.has', true);
	var $weakMapDelete = callBound('WeakMap.prototype.delete', true);

	return function getSideChannelWeakMap() {
		var $wm;
		var $m;

		var channel = {
			assert: function (key) {
				if (!channel.has(key)) {
					throw new TypeError('Side channel does not contain ' + objectInspect(key));
				}
			},
			'delete': function (key) {
				if ($WeakMap && key && (typeof key === 'object' || typeof key === 'function')) {
					if ($wm) {
						return $weakMapDelete($wm, key);
					}
				} else if (getSideChannelMap) {
					if ($m) {
						return $m['delete'](key);
					}
				}
				return false;
			},
			get: function (key) {
				if ($WeakMap && key && (typeof key === 'object' || typeof key === 'function')) {
					if ($wm) {
						return $weakMapGet($wm, key);
					}
				}
				return $m && $m.get(key);
			},
			has: function (key) {
				if ($WeakMap && key && (typeof key === 'object' || typeof key === 'function')) {
					if ($wm) {
						return $weakMapHas($wm, key);
					}
				}
				return !!$m && $m.has(key);
			},
			set: function (key, value) {
				if ($WeakMap && key && (typeof key === 'object' || typeof key === 'function')) {
					if (!$wm) {
						$wm = new $WeakMap();
					}
					$weakMapSet($wm, key, value);
				} else if (getSideChannelMap) {
					if (!$m) {
						$m = getSideChannelMap();
					}
					$m.set(key, value);
				}
			}
		};

		return channel;
	};
})();

// From side-channel/index.js
var sideChannel = function getSideChannel() {
	var makeChannel = getSideChannelWeakMap || getSideChannelMap || getSideChannelList;
	var $channelData;

	var channel = {
		assert: function (key) {
			if (!channel.has(key)) {
				throw new TypeError('Side channel does not contain ' + objectInspect(key));
			}
		},
		'delete': function (key) {
			return !!$channelData && $channelData['delete'](key);
		},
		get: function (key) {
			return $channelData && $channelData.get(key);
		},
		has: function (key) {
			return !!$channelData && $channelData.has(key);
		},
		set: function (key, value) {
			if (!$channelData) {
				$channelData = makeChannel();
			}

			$channelData.set(key, value);
		}
	};
	return channel;
};

// From internal-slot/index.js
var SLOT = (function() {
	var channel = sideChannel();
	return {
		assert: function (O, slot) {
			if (!O || (typeof O !== 'object' && typeof O !== 'function')) {
				throw new TypeError('`O` is not an object');
			}
			if (typeof slot !== 'string') {
				throw new TypeError('`slot` must be a string');
			}
			if (!SLOT.has(O, slot)) {
				throw new TypeError('`' + slot + '` is not present on `O`');
			}
		},
		get: function (O, slot) {
			if (!O || (typeof O !== 'object' && typeof O !== 'function')) {
				throw new TypeError('`O` is not an object');
			}
			if (typeof slot !== 'string') {
				throw new TypeError('`slot` must be a string');
			}
			var slots = channel.get(O);
			return slots && slots['$' + slot];
		},
		has: function (O, slot) {
			if (!O || (typeof O !== 'object' && typeof O !== 'function')) {
				throw new TypeError('`O` is not an object');
			}
			if (typeof slot !== 'string') {
				throw new TypeError('`slot` must be a string');
			}
			var slots = channel.get(O);
			return !!slots && hasown(slots, '$' + slot);
		},
		set: function (O, slot, V) {
			if (!O || (typeof O !== 'object' && typeof O !== 'function')) {
				throw new TypeError('`O` is not an object');
			}
			if (typeof slot !== 'string') {
				throw new TypeError('`slot` must be a string');
			}
			var slots = channel.get(O);
			if (!slots) {
				slots = {};
				channel.set(O, slots);
			}
			slots['$' + slot] = V;
		}
	};
})();

// From es-abstract/2025/CompletionRecord.js
var CompletionRecord = function CompletionRecord(type, value) {
	if (!(this instanceof CompletionRecord)) {
		return new CompletionRecord(type, value);
	}
	SLOT.set(this, '[[Type]]', type);
	SLOT.set(this, '[[Value]]', value);
	// [[Target]] slot?
};

CompletionRecord.prototype.type = function Type() {
	return SLOT.get(this, '[[Type]]');
};

CompletionRecord.prototype.value = function Value() {
	return SLOT.get(this, '[[Value]]');
};

CompletionRecord.prototype['?'] = function ReturnIfAbrupt() {
	var type = SLOT.get(this, '[[Type]]');
	var value = SLOT.get(this, '[[Value]]');

	if (type === 'throw') {
		throw value;
	}
	return value;
};

CompletionRecord.prototype['!'] = function assert() {
	var type = SLOT.get(this, '[[Type]]');
	return SLOT.get(this, '[[Value]]');
};

// From es-abstract/2025/NormalCompletion.js
var NormalCompletion = function NormalCompletion(value) {
	return new CompletionRecord('normal', value);
};

// From es-abstract/2025/ThrowCompletion.js
var ThrowCompletion = function ThrowCompletion(argument) {
	return new CompletionRecord('throw', argument);
};

// From es-abstract/helpers/every.js
var every = function every(array, predicate) {
	for (var i = 0; i < array.length; i += 1) {
		if (!predicate(array[i], i, array)) {
			return false;
		}
	}
	return true;
};

// From es-abstract/helpers/records/iterator-record.js
var isIteratorRecord = function isIteratorRecord(value) {
	return !!value
		&& typeof value === 'object'
		&& hasown(value, '[[Iterator]]')
		&& hasown(value, '[[NextMethod]]')
		&& hasown(value, '[[Done]]')
		&& typeof value['[[Done]]'] === 'boolean';
};

// From es-abstract/2025/IteratorClose.js
var IteratorClose = function IteratorClose(iteratorRecord, completion) {
	var completionThunk = completion instanceof CompletionRecord ? function () { return completion['?'](); } : completion;

	var iterator = iteratorRecord['[[Iterator]]']; // step 3

	var iteratorReturn;
	try {
		iteratorReturn = GetMethod(iterator, 'return'); // step 4
	} catch (e) {
		completionThunk(); // throws if `completion` is a throw completion // step 6
		completionThunk = null; // ensure it's not called twice.
		throw e; // step 7
	}
	if (typeof iteratorReturn === 'undefined') {
		return completionThunk(); // step 5.a - 5.b
	}

	var innerResult;
	try {
		innerResult = Call(iteratorReturn, iterator, []);
	} catch (e) {
		// if we hit here, then "e" is the innerResult completion that needs re-throwing

		completionThunk(); // throws if `completion` is a throw completion // step 6
		completionThunk = null; // ensure it's not called twice.

		// if not, then return the innerResult completion
		throw e; // step 7
	}
	var completionRecord = completionThunk(); // if innerResult worked, then throw if the completion does
	completionThunk = null; // ensure it's not called twice.

	if (!isObject(innerResult)) {
		throw new TypeError('iterator .return must return an object');
	}

	return completionRecord;
};

// From es-iterator-helpers/aos/ReturnCompletion.js
var ReturnCompletion = function ReturnCompletion(value) {
	return new CompletionRecord('return', value);
};

// From es-iterator-helpers/aos/GeneratorValidate.js
var GeneratorValidate = function GeneratorValidate(generator, generatorBrand) {
	SLOT.assert(generator, '[[GeneratorState]]'); // step 1
	SLOT.assert(generator, '[[GeneratorBrand]]'); // step 2

	var state = SLOT.get(generator, '[[GeneratorState]]'); // step 5
	if (state === 'EXECUTING') {
		throw new TypeError('generator is executing');
	}

	return state; // step 7
};

// From es-iterator-helpers/aos/GeneratorResume.js
var GeneratorResume = function GeneratorResume(generator, value, generatorBrand) {
	var state = GeneratorValidate(generator, generatorBrand); // step 1
	if (state === 'COMPLETED') {
		return CreateIterResultObject(void undefined, true); // step 2
	}

	var genContext = SLOT.get(generator, '[[GeneratorContext]]');

	SLOT.set(generator, '[[GeneratorState]]', 'EXECUTING'); // step 7

	var result = genContext(value); // steps 5-6, 8-10

	return result;
};

// From es-iterator-helpers/aos/GeneratorResumeAbrupt.js
var GeneratorResumeAbrupt = function GeneratorResumeAbrupt(generator, abruptCompletion, generatorBrand) {
	var state = GeneratorValidate(generator, generatorBrand); // step 1

	if (state === 'SUSPENDED-START') { // step 2
		SLOT.set(generator, '[[GeneratorState]]', 'COMPLETED'); // step 2.a
		SLOT.set(generator, '[[GeneratorContext]]', null); // step 2.b
		state = 'COMPLETED'; // step 2.c
	}

	var value = abruptCompletion.value();

	if (state === 'COMPLETED') { // step 3
		if (abruptCompletion.type() === 'return') { // step 3.a
			return CreateIterResultObject(value, true); // step 3.a.i
		}
		return abruptCompletion['?'](); // step 3.b - throw
	}

	var genContext = SLOT.get(generator, '[[GeneratorContext]]'); // step 5

	SLOT.set(generator, '[[GeneratorState]]', 'EXECUTING'); // step 8

	if (abruptCompletion.type() === 'return') {
		// due to representing `GeneratorContext` as a function, we can't safely re-invoke it, so we can't support sending it a return completion
		var closeResult = SLOT.get(generator, '[[CloseIfAbrupt]]')(NormalCompletion(value));
		SLOT.set(generator, '[[GeneratorState]]', 'COMPLETED'); // step 10
		return CreateIterResultObject(closeResult, true);
	}

	var result = genContext(value); // steps 6-7, 9-11

	return result; // step 12
};

// From es-iterator-helpers/aos/IteratorCloseAll.js
var IteratorCloseAll = function IteratorCloseAll(iters, completion) {
	for (var i = iters.length - 1; i >= 0; i -= 1) { // step 1
		try {
			IteratorClose(iters[i], completion); // step 1.a
		} catch (e) {
			// eslint-disable-next-line no-param-reassign
			completion = ThrowCompletion(e); // step 1.a
		}
	}

	return completion['?'](); // step 2
};

// === Iterator.prototype.drop Dependencies ===

// From isarray/index.js
var isarray = Array.isArray || function (arr) {
	return {}.toString.call(arr) == '[object Array]';
};

// From es-abstract/2025/floor.js
var floor = function floor(x) {
	if (typeof x === 'bigint') {
		return x;
	}
	return Math.floor(x);
};

// From es-abstract/2025/truncate.js
var truncate = function truncate(x) {
	if (typeof x !== 'number' && typeof x !== 'bigint') {
		throw new TypeError('argument must be a Number or a BigInt');
	}
	var result = x < 0 ? -floor(-x) : floor(x);
	return result === 0 ? 0 : result; // filter out -0
};

// Simplified ToPrimitive for common cases
var ToPrimitive = function ToPrimitive(input) {
	if (typeof input === 'object' && input !== null) {
		if (typeof Symbol !== 'undefined' && Symbol.toPrimitive) {
			var exoticToPrim = input[Symbol.toPrimitive];
			if (typeof exoticToPrim === 'function') {
				var result = exoticToPrim.call(input, 'number');
				if (isPrimitive(result)) {
					return result;
				}
				throw new TypeError('Cannot convert object to primitive value');
			}
		}
		if (typeof input.valueOf === 'function') {
			var valueOf = input.valueOf();
			if (typeof valueOf !== 'object') return valueOf;
		}
		if (typeof input.toString === 'function') {
			var toString = input.toString();
			if (typeof toString !== 'object') return toString;
		}
		throw new TypeError('Cannot convert object to primitive value');
	}
	return input;
};

// Simplified StringToNumber for common cases
var StringToNumber = function StringToNumber(argument) {
	var trimmed = argument.replace(/^\s+|\s+$/g, ''); // basic trim
	if (trimmed === '') return 0;
	if (trimmed === 'Infinity') return Infinity;
	if (trimmed === '-Infinity') return -Infinity;
	var num = +trimmed;
	return num;
};

// From es-abstract/2025/ToNumber.js
var ToNumber = function ToNumber(argument) {
	var value = isPrimitive(argument) ? argument : ToPrimitive(argument);
	if (typeof value === 'symbol') {
		throw new TypeError('Cannot convert a Symbol value to a number');
	}
	if (typeof value === 'bigint') {
		throw new TypeError('Conversion from \'BigInt\' to \'number\' is not allowed.');
	}
	if (typeof value === 'string') {
		return StringToNumber(value);
	}
	return +value;
};

// From es-abstract/2025/ToIntegerOrInfinity.js
var ToIntegerOrInfinity = function ToIntegerOrInfinity(value) {
	var number = ToNumber(value);
	if ($isNaN(number) || number === 0) { return 0; }
	if (!$isFinite(number)) { return number; }
	return truncate(number);
};

// From es-abstract/helpers/isNaN.js
var isNaN = Number.isNaN || function isNaN(a) {
	return a !== a;
};

// From es-abstract/helpers/isFinite.js
var $isFinite = Number.isFinite || function isFinite(a) {
	return typeof a === 'number' && isFinite(a);
};

// From es-abstract/helpers/forEach.js
var forEach = function forEach(array, callback) {
	for (var i = 0; i < array.length; i += 1) {
		callback(array[i], i, array);
	}
};

// From es-abstract/2025/IteratorComplete.js
var IteratorComplete = function IteratorComplete(iterResult) {
	return ToBoolean(Get(iterResult, 'done'));
};

// From es-abstract/2025/IteratorNext.js
var IteratorNext = function IteratorNext(iteratorRecord) {
	var result;
	try {
		if (arguments.length < 2) { // step 1
			result = Call(iteratorRecord['[[NextMethod]]'], iteratorRecord['[[Iterator]]']); // step 1.a
		} else { // step 2
			result = Call(iteratorRecord['[[NextMethod]]'], iteratorRecord['[[Iterator]]'], [arguments[1]]); // step 2.a
		}
	} catch (e) { // step 3
		iteratorRecord['[[Done]]'] = true; // step 3.a
		throw e; // step 3.b
	}

	if (!isObject(result)) { // step 5
		iteratorRecord['[[Done]]'] = true; // step 5.a
		throw new TypeError('iterator next must return an object'); // step 5.b
	}
	return result; // step 6
};

// From es-abstract/2025/IteratorStep.js
var IteratorStep = function IteratorStep(iteratorRecord) {
	var result = IteratorNext(iteratorRecord); // step 1
	var done;
	try {
		done = IteratorComplete(result); // step 2
	} catch (e) { // step 3
		iteratorRecord['[[Done]]'] = true; // step 3.a
		throw e; // step 3.b
	}
	if (done) { // step 5
		iteratorRecord['[[Done]]'] = true; // step 5.a
		return false; // step 5.b
	}
	return result; // step 6
};

// From es-abstract/2025/IteratorStepValue.js
var IteratorStepValue = function IteratorStepValue(iteratorRecord) {
	/* eslint no-param-reassign: 0 */

	var result = IteratorStep(iteratorRecord); // step 1
	if (!result || result === 'DONE') { // step 2
		return result; // step 2.a
	}

	var value;
	try {
		value = Get(result, 'value'); // step 3
	} catch (e) { // step 4
		iteratorRecord['[[Done]]'] = true; // step 4.a
		throw e; // step 5
	}

	return value; // step 5
};

// From es-iterator-helpers/aos/GeneratorStart.js
var GeneratorStart = function GeneratorStart(generator, closure) {
	var sentinel = SLOT.get(closure, '[[Sentinel]]');
	SLOT.set(generator, '[[GeneratorContext]]', function () { // steps 2-5
		try {
			var result = closure();
			if (result === sentinel) {
				SLOT.set(generator, '[[GeneratorState]]', 'COMPLETED');
				SLOT.set(generator, '[[GeneratorContext]]', null);
				return CreateIterResultObject(void undefined, true);
			}
			SLOT.set(generator, '[[GeneratorState]]', 'SUSPENDED-YIELD');
			return CreateIterResultObject(result, false);
		} catch (e) {
			SLOT.set(generator, '[[GeneratorState]]', 'COMPLETED');
			SLOT.set(generator, '[[GeneratorContext]]', null);
			throw e;
		}
	});

	SLOT.set(generator, '[[GeneratorState]]', 'SUSPENDED-START'); // step 6
};

// From es-iterator-helpers/aos/CreateIteratorFromClosure.js
var CreateIteratorFromClosure = function CreateIteratorFromClosure(closure, generatorBrand, proto) {
	var extraSlots = arguments.length > 3 ? arguments[3] : [];
	var internalSlotsList = extraSlots.concat(['[[GeneratorContext]]', '[[GeneratorBrand]]', '[[GeneratorState]]']); // step 3
	var generator = OrdinaryObjectCreate(proto, internalSlotsList); // steps 4, 6
	SLOT.set(generator, '[[GeneratorBrand]]', generatorBrand); // step 5

	SLOT.set(generator, '[[Sentinel]]', SLOT.get(closure, '[[Sentinel]]')); // our userland slot
	SLOT.set(generator, '[[CloseIfAbrupt]]', SLOT.get(closure, '[[CloseIfAbrupt]]')); // our second userland slot

	GeneratorStart(generator, closure); // step 13

	return generator; // step 15
};

// === Type System ===

// From es-abstract/5/Type.js
var ES5Type = function Type(x) {
	if (x === null) {
		return 'Null';
	}
	if (typeof x === 'undefined') {
		return 'Undefined';
	}
	if (isObject(x)) {
		return 'Object';
	}
	if (typeof x === 'number') {
		return 'Number';
	}
	if (typeof x === 'boolean') {
		return 'Boolean';
	}
	if (typeof x === 'string') {
		return 'String';
	}
};

// From es-abstract/2025/Type.js
var Type = function Type(x) {
	if (typeof x === 'symbol') {
		return 'Symbol';
	}
	if (typeof x === 'bigint') {
		return 'BigInt';
	}
	return ES5Type(x);
};

// === Iterator Helper Operations ===

// From es-abstract/2025/Get.js
var Get = function Get(O, P) {
	return O[P];
};

// From es-abstract/2025/GetV.js
var GetV = function GetV(V, P) {
	return V[P];
};

// From es-abstract/2025/GetMethod.js
var GetMethod = function GetMethod(O, P) {
	var func = GetV(O, P);

	if (func == null) {
		return void 0;
	}

	if (!isCallable(func)) {
		throw new TypeError(P + ' is not a function: ' + func);
	}

	return func;
};

// From es-abstract/2025/Call.js
var Call = function Call(F, V) {
	var argumentsList = arguments.length > 2 ? arguments[2] : [];
	var $apply = GetIntrinsic('%Reflect.apply%', true) || callBound('Function.prototype.apply');
	return $apply(F, V, argumentsList);
};

// From es-abstract/2025/OrdinaryObjectCreate.js
var OrdinaryObjectCreate = function OrdinaryObjectCreate(proto) {
	var additionalInternalSlotsList = arguments.length < 2 ? [] : arguments[1];
	var $ObjectCreate = GetIntrinsic('%Object.create%', true);
	var O;
	if (hasProto()) {
		O = { __proto__: proto };
	} else if ($ObjectCreate) {
		O = $ObjectCreate(proto);
	} else {
		if (proto === null) {
			throw new SyntaxError('native Object.create support is required to create null objects');
		}
		var T = function T() {};
		T.prototype = proto;
		O = new T();
	}

	if (additionalInternalSlotsList.length > 0) {
		forEach(additionalInternalSlotsList, function (slot) {
			SLOT.set(O, slot, void undefined);
		});
	}

	return O;
};

// From es-iterator-helpers/aos/GetIteratorDirect.js
var GetIteratorDirect = function GetIteratorDirect(obj) {
	var nextMethod = Get(obj, 'next'); // step 2

	var iteratorRecord = { '[[Iterator]]': obj, '[[NextMethod]]': nextMethod, '[[Done]]': false }; // step 3

	return iteratorRecord; // step 4
};

// === Additional Dependencies for FlatMap ===

// From math-intrinsics/isInteger.js (simplified)
var isInteger = Number.isInteger || function isInteger(value) {
	return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
};

// From math-intrinsics/constants/maxSafeInteger.js
var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER || 9007199254740991;

// From es-abstract/helpers/isLeadingSurrogate.js
var isLeadingSurrogate = function isLeadingSurrogate(charCode) {
	return charCode >= 0xD800 && charCode <= 0xDBFF;
};

// From es-abstract/helpers/isTrailingSurrogate.js
var isTrailingSurrogate = function isTrailingSurrogate(charCode) {
	return charCode >= 0xDC00 && charCode <= 0xDFFF;
};

// From es-abstract/2025/UTF16SurrogatePairToCodePoint.js
var UTF16SurrogatePairToCodePoint = function UTF16SurrogatePairToCodePoint(lead, trail) {
	if (!isLeadingSurrogate(lead) || !isTrailingSurrogate(trail)) {
		throw new TypeError('Assertion failed: `lead` must be a leading surrogate, and `trail` must be a trailing surrogate');
	}
	// https://tc39.es/ecma262/#sec-utf16decodesurrogatepair
	return (lead - 0xD800) * 0x400 + (trail - 0xDC00) + 0x10000;
};

// From es-abstract/2025/CodePointAt.js
var CodePointAt = function CodePointAt(string, position) {
	if (typeof string !== 'string') {
		throw new TypeError('Assertion failed: `string` must be a String');
	}
	var size = string.length;
	if (position < 0 || position >= size) {
		throw new TypeError('Assertion failed: `position` must be >= 0, and < the length of `string`');
	}
	var $charAt = callBound('String.prototype.charAt');
	var $charCodeAt = callBound('String.prototype.charCodeAt');

	var first = $charCodeAt(string, position);
	var cp = $charAt(string, position);
	var firstIsLeading = isLeadingSurrogate(first);
	var firstIsTrailing = isTrailingSurrogate(first);
	if (!firstIsLeading && !firstIsTrailing) {
		return {
			'[[CodePoint]]': cp,
			'[[CodeUnitCount]]': 1,
			'[[IsUnpairedSurrogate]]': false
		};
	}
	if (firstIsTrailing || (position + 1 === size)) {
		return {
			'[[CodePoint]]': cp,
			'[[CodeUnitCount]]': 1,
			'[[IsUnpairedSurrogate]]': true
		};
	}
	var second = $charCodeAt(string, position + 1);
	if (!isTrailingSurrogate(second)) {
		return {
			'[[CodePoint]]': cp,
			'[[CodeUnitCount]]': 1,
			'[[IsUnpairedSurrogate]]': true
		};
	}

	return {
		'[[CodePoint]]': UTF16SurrogatePairToCodePoint(first, second),
		'[[CodeUnitCount]]': 2,
		'[[IsUnpairedSurrogate]]': false
	};
};

// From es-abstract/2025/AdvanceStringIndex.js
var AdvanceStringIndex = function AdvanceStringIndex(S, index, unicode) {
	if (typeof S !== 'string') {
		throw new TypeError('Assertion failed: `S` must be a String');
	}
	if (!isInteger(index) || index < 0 || index > MAX_SAFE_INTEGER) {
		throw new TypeError('Assertion failed: `length` must be an integer >= 0 and <= 2**53');
	}
	if (typeof unicode !== 'boolean') {
		throw new TypeError('Assertion failed: `unicode` must be a Boolean');
	}
	if (!unicode) {
		return index + 1;
	}
	var length = S.length;
	if ((index + 1) >= length) {
		return index + 1;
	}
	var cp = CodePointAt(S, index);
	return index + cp['[[CodeUnitCount]]'];
};

// From is-string/index.js (simplified)
var isString = function isString(value) {
	return typeof value === 'string' || (typeof value === 'object' && value !== null && Object.prototype.toString.call(value) === '[object String]');
};

// From es-abstract/helpers/getIteratorMethod.js
var getIteratorMethod = function getIteratorMethod(ES, iterable) {
	var usingIterator;
	if (hasSymbols() && typeof Symbol !== 'undefined' && Symbol.iterator) {
		usingIterator = ES.GetMethod(iterable, Symbol.iterator);
	} else if (IsArray(iterable)) {
		usingIterator = function () {
			var i = -1;
			var arr = this; // eslint-disable-line no-invalid-this
			return {
				next: function () {
					i += 1;
					return {
						done: i >= arr.length,
						value: arr[i]
					};
				}
			};
		};
	} else if (isString(iterable)) {
		var $stringSlice = callBound('String.prototype.slice');
		var $String = GetIntrinsic('%String%');
		usingIterator = function () {
			var i = 0;
			return {
				next: function () {
					var nextIndex = ES.AdvanceStringIndex($String(iterable), i, true);
					var value = $stringSlice(iterable, i, nextIndex);
					i = nextIndex;
					var done = nextIndex > iterable.length;
					return {
						done: done,
						value: done ? void undefined : value
					};
				}
			};
		};
	}
	return usingIterator;
};

// From es-iterator-helpers/aos/GetIteratorFlattenable.js
var GetIteratorFlattenable = function GetIteratorFlattenable(obj, stringHandling) {
	if (stringHandling !== 'REJECT-PRIMITIVES' && stringHandling !== 'ITERATE-STRING-PRIMITIVES') {
		throw new TypeError('Assertion failed: `stringHandling` must be "REJECT-PRIMITIVES" or "ITERATE-STRING-PRIMITIVES"');
	}

	if (!isObject(obj)) {
		if (stringHandling === 'REJECT-PRIMITIVES' || typeof obj !== 'string') {
			throw new TypeError('obj must be an Object'); // step 1.a
		}
	}

	var method = void undefined; // step 2

	// method = GetMethod(obj, Symbol.iterator); // step 5.a
	method = getIteratorMethod(
		{
			AdvanceStringIndex: AdvanceStringIndex,
			GetMethod: GetMethod,
			IsArray: IsArray
		},
		obj
	);

	var iterator;
	if (typeof method === 'undefined') { // step 3
		iterator = obj; // step 3.a
	} else { // step 4
		iterator = Call(method, obj); // step 4.a
	}

	if (!isObject(iterator)) {
		throw new TypeError('iterator must be an Object'); // step 5
	}
	return GetIteratorDirect(iterator); // step 6
};

// === Iterator.from Dependencies ===

// From es-abstract/2025/OrdinaryHasInstance.js
var OrdinaryHasInstance = function OrdinaryHasInstance(C, O) {
	if (!isCallable(C)) {
		return false;
	}
	if (!isObject(O)) {
		return false;
	}
	var P = Get(C, 'prototype');
	if (!isObject(P)) {
		throw new TypeError('OrdinaryHasInstance called on an object with an invalid prototype property.');
	}
	return O instanceof C;
};
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

var arrayIterProto = GetIntrinsic('%ArrayIteratorPrototype%', true);
var iterProto = arrayIterProto && getProto(arrayIterProto);

var result = (iterProto !== Object.prototype && iterProto) || {};

// Check for symbol support and add Symbol.iterator if needed
if (typeof Symbol !== 'undefined' && Symbol.iterator) {
	if (!(Symbol.iterator in result)) {
		// needed when result === iterProto, or, node 0.11.15 - 3
		var iter = setFunctionName(function SymbolIterator() {
			return this;
		}, '[Symbol.iterator]', true);

		defineDataProperty(result, Symbol.iterator, iter, true);
	}
}

var iteratorPrototype = result;

// === Main Iterator Constructor ===
// From Iterator/implementation.js

var $defineProperty = hasPropertyDescriptors() && GetIntrinsic('%Object.defineProperty%', true);

var $isPrototypeOf = callBound('Object.prototype.isPrototypeOf');

var $Iterator = typeof Iterator === 'function' ? Iterator : function Iterator() {
	if (
		!(this instanceof Iterator)
		|| this.constructor === Iterator
		|| !$isPrototypeOf(Iterator, this.constructor)
	) {
		throw new TypeError('`Iterator` can not be called or constructed directly');
	}
};

defineProperties(
	iteratorPrototype,
	{ constructor: $Iterator },
	{ constructor: function () { return $Iterator.constructor !== $Iterator; } }
);

Object.defineProperty(iteratorPrototype, 'constructor', {
	configurable: true,
	enumerable: false,
	get: function () {
		return $Iterator;
	},
	set: function (v) {
		SetterThatIgnoresPrototypeProperties(this, iteratorPrototype, 'constructor', v);
		return undefined;
	}
});

Object.defineProperty(iteratorPrototype, Symbol.toStringTag, {
	configurable: true,
	enumerable: false,
	get: function () {
		return 'Iterator';
	},
	set: function (v) {
		SetterThatIgnoresPrototypeProperties(this, iteratorPrototype, Symbol.toStringTag, v);
		return undefined;
	}
});

$Iterator.prototype = iteratorPrototype;

$defineProperty($Iterator, 'prototype', { writable: false });

defineProperties(
	globalThis,
	{ Iterator: $Iterator },
	{ Iterator: function () { return Iterator !== $Iterator; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator Helper Prototype Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/IteratorHelperPrototype at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/IteratorHelperPrototype/index.js
var o = { // in an object, for name inference
	'return': function () {
		var O = this; // step 1

		SLOT.assert(O, '[[UnderlyingIterators]]'); // step 2

		SLOT.assert(O, '[[GeneratorState]]'); // step 3

		if (SLOT.get(O, '[[GeneratorState]]') === 'SUSPENDED-START') { // step 4
			SLOT.set(O, '[[GeneratorState]]', 'COMPLETED'); // step 4.a
			IteratorCloseAll(SLOT.get(O, '[[UnderlyingIterators]]'), ReturnCompletion(void undefined)); // step 4.c
			return CreateIterResultObject(void undefined, true); // step 4.d
		}

		var C = ReturnCompletion(void undefined); // step 5

		return GeneratorResumeAbrupt(O, C, 'Iterator Helper'); // step 6
	}
};

var IteratorHelperPrototype = {
	__proto__: Iterator.prototype,
	next: function next() {
		return GeneratorResume(this, void undefined, 'Iterator Helper');
	},
	'return': o['return']
};
Object.defineProperty(IteratorHelperPrototype, Symbol.toStringTag, {
	configurable: true,
	enumerable: false,
	value: 'Iterator Helper'
});
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
*/

// ==========================
// Iterator.prototype.drop Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.prototype.drop at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/Iterator.prototype.drop/implementation.js
var IteratorPrototypeDrop = function drop(limit) {
	if (new.target !== undefined) {
		throw new TypeError('`drop` is not a constructor');
	}

	var O = this; // step 1
	if (!isObject(O)) {
		throw new TypeError('`this` value must be an Object'); // step 2
	}

	var iterated = { '[[Iterator]]': O, '[[NextMethod]]': undefined, '[[Done]]': false }; // step 3

	var numLimit;
	try {
		numLimit = ToNumber(limit); // step 4
	} catch (e) {
		// step 5
		IteratorClose(
			iterated,
			ThrowCompletion(e)
		);
	}
	if (isNaN(numLimit)) {
		IteratorClose(
			iterated,
			ThrowCompletion(new RangeError('`limit` must be a non-NaN number'))
		); // step 6
	}

	var integerLimit = ToIntegerOrInfinity(numLimit); // step 7
	if (integerLimit < 0) {
		IteratorClose(
			iterated,
			ThrowCompletion(new RangeError('`limit` must be a >= 0'))
		); // step 8
	}

	iterated = GetIteratorDirect(O); // step 9

	// step 10
	var closeIfAbrupt = function (abruptCompletion) {
		if (!(abruptCompletion instanceof CompletionRecord)) {
			throw new TypeError('`abruptCompletion` must be a Completion Record');
		}
		IteratorClose(
			iterated,
			abruptCompletion
		);
	};

	var sentinel = {};
	var remaining = integerLimit; // step 10.a
	var closure = function () { // step 10
		var next;
		while (remaining > 0) { // step 10.b
			if (remaining !== Infinity) { // step 10.b.i
				remaining -= 1; // step 10.b.i.1
			}

			next = IteratorStep(iterated); // step 10.b.ii
			if (!next) {
				// return void undefined; // step 10.b.iii
				return sentinel;
			}
		}
		// while (true) { // step 10.c
		var value = IteratorStepValue(iterated); // step 10.c.i
		if (iterated['[[Done]]']) {
			return sentinel; // step 10.c.ii
		}
		return value;
		// }
		// return void undefined;
	};
	SLOT.set(closure, '[[Sentinel]]', sentinel); // for the userland implementation
	SLOT.set(closure, '[[CloseIfAbrupt]]', closeIfAbrupt); // for the userland implementation

	var result = CreateIteratorFromClosure(closure, 'Iterator Helper', IteratorHelperPrototype, ['[[UnderlyingIterators]]']); // step 4

	SLOT.set(result, '[[UnderlyingIterators]]', [iterated]); // step 5

	return result; // step 6
};

defineProperties(
	Iterator.prototype,
	{ drop: IteratorPrototypeDrop },
	{ drop: function () { return Iterator.prototype.drop !== IteratorPrototypeDrop; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.prototype.every Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.prototype.every at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/Iterator.prototype.every/implementation.js
var IteratorPrototypeEvery = function every(predicate) {
	if (new.target !== undefined) {
		throw new TypeError('`every` is not a constructor');
	}

	var O = this; // step 1
	if (!isObject(O)) {
		throw new TypeError('`this` value must be an Object'); // step 2
	}

	var iterated = { '[[Iterator]]': O, '[[NextMethod]]': undefined, '[[Done]]': false }; // step 3

	if (!isCallable(predicate)) {
		IteratorClose(
			iterated,
			ThrowCompletion(new TypeError('`predicate` must be a function'))
		); // step 4
	}

	iterated = GetIteratorDirect(O); // step 5

	var counter = 0; // step 6

	// eslint-disable-next-line no-constant-condition
	while (true) { // step 6
		var value = IteratorStepValue(iterated); // step 6.a
		if (iterated['[[Done]]']) {
			return true; // step 6.b
		}
		var result;
		try {
			result = Call(predicate, void undefined, [value, counter]); // step 6.c
		} catch (e) {
			// close iterator // step 6.d
			IteratorClose(
				iterated,
				ThrowCompletion(e)
			);
		} finally {
			counter += 1; // step 6.f
		}
		if (!ToBoolean(result)) {
			return IteratorClose(
				iterated,
				NormalCompletion(false)
			); // step 6.e
		}
	}
};

defineProperties(
	Iterator.prototype,
	{ every: IteratorPrototypeEvery },
	{ every: function () { return Iterator.prototype.every !== IteratorPrototypeEvery; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.prototype.filter Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.prototype.filter at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/Iterator.prototype.filter/implementation.js
var IteratorPrototypeFilter = function filter(predicate) {
	if (new.target !== undefined) {
		throw new TypeError('`filter` is not a constructor');
	}

	var O = this; // step 1
	if (!isObject(O)) {
		throw new TypeError('`this` value must be an Object'); // step 2
	}

	var iterated = { '[[Iterator]]': O, '[[NextMethod]]': undefined, '[[Done]]': false }; // step 3

	if (!isCallable(predicate)) {
		IteratorClose(
			iterated,
			ThrowCompletion(new TypeError('`predicate` must be a function'))
		); // step 4
	}

	iterated = GetIteratorDirect(O); // step 5

	var closeIfAbrupt = function (abruptCompletion) {
		if (!(abruptCompletion instanceof CompletionRecord)) {
			throw new TypeError('`abruptCompletion` must be a Completion Record');
		}
		IteratorClose(
			iterated,
			abruptCompletion
		);
	};

	var sentinel = {};
	var counter = 0; // step 6.a
	var closure = function () {
		// eslint-disable-next-line no-constant-condition
		while (true) { // step 6.b
			var value = IteratorStepValue(iterated); // step 6.b.i
			if (iterated['[[Done]]']) {
				return sentinel; // step 6.b.ii
			}

			var selected;
			try {
				selected = Call(predicate, void undefined, [value, counter]); // step 6.b.iv
				// yield mapped // step 6.b.vi
				if (ToBoolean(selected)) {
					return value;
				}
			} catch (e) {
				// close iterator // step 6.b.v, 6.b.vii
				closeIfAbrupt(ThrowCompletion(e));
				throw e;
			} finally {
				counter += 1; // step 6.b.viii
			}
		}
	};
	SLOT.set(closure, '[[Sentinel]]', sentinel); // for the userland implementation
	SLOT.set(closure, '[[CloseIfAbrupt]]', closeIfAbrupt); // for the userland implementation

	var result = CreateIteratorFromClosure(closure, 'Iterator Helper', IteratorHelperPrototype, ['[[UnderlyingIterators]]']); // step 7

	SLOT.set(result, '[[UnderlyingIterators]]', [iterated]); // step 8

	return result; // step 9
};

defineProperties(
	Iterator.prototype,
	{ filter: IteratorPrototypeFilter },
	{ filter: function () { return Iterator.prototype.filter !== IteratorPrototypeFilter; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.prototype.find Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.prototype.find at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/Iterator.prototype.find/implementation.js
var IteratorPrototypeFind = function find(predicate) {
	if (new.target !== undefined) {
		throw new TypeError('`find` is not a constructor');
	}

	var O = this; // step 1

	if (!isObject(O)) {
		throw new TypeError('`this` value must be an Object'); // step 2
	}

	var iterated = { '[[Iterator]]': O, '[[NextMethod]]': undefined, '[[Done]]': false }; // step 3

	if (!isCallable(predicate)) {
		IteratorClose(
			iterated,
			ThrowCompletion(new TypeError('`predicate` must be a function'))
		); // step 4
	}

	iterated = GetIteratorDirect(O); // step 5

	var counter = 0; // step 6

	// eslint-disable-next-line no-constant-condition
	while (true) { // step 6
		var value = IteratorStepValue(iterated); // step 6.a
		if (iterated['[[Done]]']) {
			return void undefined; // step 6.b
		}
		var result;
		try {
			result = Call(predicate, void undefined, [value, counter]); // step 6.c
		} catch (e) {
			// close iterator // step 6.d
			IteratorClose(
				iterated,
				ThrowCompletion(e)
			);
		} finally {
			counter += 1; // step 6.f
		}
		if (ToBoolean(result)) {
			return IteratorClose(
				iterated,
				NormalCompletion(value)
			); // step 6.e
		}
	}
};

defineProperties(
	Iterator.prototype,
	{ find: IteratorPrototypeFind },
	{ find: function () { return Iterator.prototype.find !== IteratorPrototypeFind; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.prototype.flatMap Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.prototype.flatMap at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/Iterator.prototype.flatMap/implementation.js
var IteratorPrototypeFlatMap = function flatMap(mapper) {
	if (new.target !== undefined) {
		throw new TypeError('`flatMap` is not a constructor');
	}

	var O = this; // step 1
	if (!isObject(O)) {
		throw new TypeError('`this` value must be an Object'); // step 2
	}

	var iterated = { '[[Iterator]]': O, '[[NextMethod]]': undefined, '[[Done]]': false }; // step 3

	if (!isCallable(mapper)) {
		IteratorClose(
			iterated,
			ThrowCompletion(new TypeError('`mapper` must be a function'))
		); // step 4
	}

	iterated = GetIteratorDirect(O); // step 5

	var sentinel = { sentinel: true };
	var innerIterator = sentinel;

	var closeIfAbrupt = function (abruptCompletion) {
		if (!(abruptCompletion instanceof CompletionRecord)) {
			throw new TypeError('`abruptCompletion` must be a Completion Record');
		}
		try {
			if (innerIterator !== sentinel) {
				IteratorClose(
					innerIterator,
					abruptCompletion
				);
			}
		} finally {
			innerIterator = sentinel;

			IteratorClose(
				iterated,
				abruptCompletion
			);
		}
	};

	var counter = 0; // step 5.a
	var innerAlive = false;
	var closure = function () {
		// while (true) { // step 5.b
		if (innerIterator === sentinel) {
			var value = IteratorStepValue(iterated); // step 5.b.i
			if (iterated['[[Done]]']) {
				innerAlive = false;
				innerIterator = sentinel;
				// return void undefined; // step 5.b.ii
				return sentinel;
			}
		}

		if (innerIterator === sentinel) {
			innerAlive = true; // step 5.b.viii
			try {
				var mapped = Call(mapper, void undefined, [value, counter]); // step 5.b.iv
				// yield mapped // step 5.b.vi
				innerIterator = GetIteratorFlattenable(mapped, 'REJECT-PRIMITIVES'); // step 5.b.vi
			} catch (e) {
				innerAlive = false;
				innerIterator = sentinel;
				closeIfAbrupt(ThrowCompletion(e)); // steps 5.b.v, 5.b.vii
			} finally {
				counter += 1; // step 5.b.x
			}
		}
		// while (innerAlive) { // step 5.b.ix
		if (innerAlive) {
			// step 5.b.ix.4
			var innerValue;
			try {
				innerValue = IteratorStepValue(innerIterator); // step 5.b.ix.4.a
			} catch (e) {
				innerAlive = false;
				innerIterator = sentinel;
				closeIfAbrupt(ThrowCompletion(e)); // step 5.b.ix.4.b
			}
			if (innerIterator['[[Done]]']) {
				innerAlive = false;
				innerIterator = sentinel;
				return closure();
			}
			return innerValue; // step 5.b.ix.4.c
		}
		// }
		// return void undefined;
		return sentinel;
	};
	SLOT.set(closure, '[[Sentinel]]', sentinel); // for the userland implementation
	SLOT.set(closure, '[[CloseIfAbrupt]]', closeIfAbrupt); // for the userland implementation

	var result = CreateIteratorFromClosure(closure, 'Iterator Helper', IteratorHelperPrototype, ['[[UnderlyingIterators]]']); // step 7

	SLOT.set(result, '[[UnderlyingIterators]]', [iterated]); // step 8

	return result; // step 9
};

defineProperties(
	Iterator.prototype,
	{ flatMap: IteratorPrototypeFlatMap },
	{ flatMap: function () { return Iterator.prototype.flatMap !== IteratorPrototypeFlatMap; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.prototype.forEach Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.prototype.forEach at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/Iterator.prototype.forEach/implementation.js
var IteratorPrototypeForEach = function forEach(fn) {
	if (new.target !== undefined) {
		throw new TypeError('`forEach` is not a constructor');
	}

	var O = this; // step 1
	if (!isObject(O)) {
		throw new TypeError('`this` value must be an Object'); // step 2
	}

	var iterated = { '[[Iterator]]': O, '[[NextMethod]]': undefined, '[[Done]]': false }; // step 3

	if (!isCallable(fn)) {
		IteratorClose(
			iterated,
			ThrowCompletion(new TypeError('`fn` must be a function'))
		); // step 4
	}

	iterated = GetIteratorDirect(O); // step 5

	var counter = 0; // step 6

	// eslint-disable-next-line no-constant-condition
	while (true) { // step 6
		var value = IteratorStepValue(iterated); // step 6.a
		if (iterated['[[Done]]']) {
			return void undefined; // step 6.b
		}
		try {
			Call(fn, void undefined, [value, counter]); // step 6.c
		} catch (e) {
			IteratorClose(
				iterated,
				ThrowCompletion(e)
			); // steps 6.d
			throw e;
		} finally {
			counter += 1; // step 6.e
		}
	}
};

defineProperties(
	Iterator.prototype,
	{ forEach: IteratorPrototypeForEach },
	{ forEach: function () { return Iterator.prototype.forEach !== IteratorPrototypeForEach; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.prototype.map Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.prototype.map at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/Iterator.prototype.map/implementation.js
var IteratorPrototypeMap = function map(mapper) {
	if (new.target !== undefined) {
		throw new TypeError('`map` is not a constructor');
	}

	var O = this; // step 1
	if (!isObject(O)) {
		throw new TypeError('`this` value must be an Object'); // step 2
	}

	var iterated = { '[[Iterator]]': O, '[[NextMethod]]': undefined, '[[Done]]': false }; // step 3

	if (!isCallable(mapper)) {
		IteratorClose(
			iterated,
			ThrowCompletion(new TypeError('`mapper` must be a function'))
		); // step 4
	}

	iterated = GetIteratorDirect(O); // step 5

	var closeIfAbrupt = function (abruptCompletion) {
		if (!(abruptCompletion instanceof CompletionRecord)) {
			throw new TypeError('`abruptCompletion` must be a Completion Record');
		}
		IteratorClose(
			iterated,
			abruptCompletion
		);
	};

	var sentinel = {};
	var counter = 0; // step 6.a
	var closure = function () {
		// while (true) { // step 6.b
		var value = IteratorStepValue(iterated); // step 6.b.i
		if (iterated['[[Done]]']) {
			return sentinel; // step 6.b.ii
		}

		var mapped;
		try {
			mapped = Call(mapper, void undefined, [value, counter]); // step 6.b.iii
			// yield mapped // step 6.b.vi
			return mapped;
		} catch (e) {
			// close iterator // step 6.b.v, 6.b.vii
			closeIfAbrupt(ThrowCompletion(e));
			throw e;
		} finally {
			counter += 1; // step 6.b.viii
		}
		// }
	};
	SLOT.set(closure, '[[Sentinel]]', sentinel); // for the userland implementation
	SLOT.set(closure, '[[CloseIfAbrupt]]', closeIfAbrupt); // for the userland implementation

	var result = CreateIteratorFromClosure(closure, 'Iterator Helper', IteratorHelperPrototype, ['[[UnderlyingIterators]]']); // step 7

	SLOT.set(result, '[[UnderlyingIterators]]', [iterated]); // step 8

	return result; // step 9
};

defineProperties(
	Iterator.prototype,
	{ map: IteratorPrototypeMap },
	{ map: function () { return Iterator.prototype.map !== IteratorPrototypeMap; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.prototype.reduce Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.prototype.reduce at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/Iterator.prototype.reduce/implementation.js
var IteratorPrototypeReduce = function reduce(reducer) {
	if (new.target !== undefined) {
		throw new TypeError('`reduce` is not a constructor');
	}

	var O = this; // step 1
	if (!isObject(O)) {
		throw new TypeError('`this` value must be an Object'); // step 2
	}

	var iterated = { '[[Iterator]]': O, '[[NextMethod]]': undefined, '[[Done]]': false }; // step 3

	if (!isCallable(reducer)) {
		IteratorClose(
			iterated,
			ThrowCompletion(new TypeError('`reducer` must be a function'))
		); // step 4
	}

	iterated = GetIteratorDirect(O); // step 5

	var accumulator;
	var counter;
	if (arguments.length < 2) { // step 6
		accumulator = IteratorStepValue(iterated); // step 6.a
		if (iterated['[[Done]]']) {
			throw new TypeError('Reduce of empty iterator with no initial value');
		}
		counter = 1;
	} else { // step 7
		accumulator = arguments[1]; // step 7.a
		counter = 0;
	}

	// eslint-disable-next-line no-constant-condition
	while (true) { // step 8
		var value = IteratorStepValue(iterated); // step 8.a
		if (iterated['[[Done]]']) {
			return accumulator; // step 8.b
		}
		try {
			var result = Call(reducer, void undefined, [accumulator, value, counter]); // step 8.d
			accumulator = result; // step 8.f
		} catch (e) {
			// close iterator // step 8.e
			IteratorClose(
				iterated,
				ThrowCompletion(e)
			);
		}
		counter += 1; // step 8.g
	}
};

defineProperties(
	Iterator.prototype,
	{ reduce: IteratorPrototypeReduce },
	{ reduce: function () { return Iterator.prototype.reduce !== IteratorPrototypeReduce; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.prototype.some Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.prototype.some at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/Iterator.prototype.some/implementation.js
var IteratorPrototypeSome = function some(predicate) {
	if (new.target !== undefined) {
		throw new TypeError('`some` is not a constructor');
	}

	var O = this; // step 1
	if (!isObject(O)) {
		throw new TypeError('`this` value must be an Object'); // step 2
	}

	var iterated = { '[[Iterator]]': O, '[[NextMethod]]': undefined, '[[Done]]': false }; // step 3

	if (!isCallable(predicate)) {
		IteratorClose(
			iterated,
			ThrowCompletion(new TypeError('`predicate` must be a function'))
		); // step 4
	}

	iterated = GetIteratorDirect(O); // step 5

	var counter = 0; // step 6

	// eslint-disable-next-line no-constant-condition
	while (true) { // step 6
		var value = IteratorStepValue(iterated); // step 6.a
		if (iterated['[[Done]]']) {
			return false; // step 6.b
		}
		var result;
		try {
			result = Call(predicate, void undefined, [value, counter]); // step 6.c
		} catch (e) {
			// close iterator // step 6.d
			IteratorClose(
				iterated,
				ThrowCompletion(e)
			);
		} finally {
			counter += 1; // step 6.f
		}
		if (ToBoolean(result)) {
			return IteratorClose(
				iterated,
				NormalCompletion(true)
			); // step 6.e
		}
	}
};

defineProperties(
	Iterator.prototype,
	{ some: IteratorPrototypeSome },
	{ some: function () { return Iterator.prototype.some !== IteratorPrototypeSome; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.prototype.take Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.prototype.take at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/Iterator.prototype.take/implementation.js
var IteratorPrototypeTake = function take(limit) {
	if (new.target !== undefined) {
		throw new TypeError('`take` is not a constructor');
	}

	var O = this; // step 1
	if (!isObject(O)) {
		throw new TypeError('`this` value must be an Object'); // step 2
	}

	var iterated = { '[[Iterator]]': O, '[[NextMethod]]': undefined, '[[Done]]': false }; // step 3

	var numLimit;
	try {
		numLimit = ToNumber(limit); // step 4
	} catch (e) {
		IteratorClose(
			iterated,
			ThrowCompletion(e)
		);
	}
	if (isNaN(numLimit)) {
		IteratorClose(
			iterated,
			ThrowCompletion(new RangeError('`limit` must be a non-NaN number'))
		); // step 5
	}

	var integerLimit = ToIntegerOrInfinity(numLimit); // step 6
	if (integerLimit < 0) {
		IteratorClose(
			iterated,
			ThrowCompletion(new RangeError('`limit` must be a >= 0'))
		); // step 7
	}

	iterated = GetIteratorDirect(O); // step 8

	var closeIfAbrupt = function (abruptCompletion) {
		if (!(abruptCompletion instanceof CompletionRecord)) {
			throw new TypeError('`abruptCompletion` must be a Completion Record');
		}
		IteratorClose(
			iterated,
			abruptCompletion
		);
	};

	var sentinel = {};
	var remaining = integerLimit; // step 9.a
	var closure = function () { // step 9
		// while (true) { // step 9.b
		if (remaining === 0) { // step 9.b.i
			return IteratorClose( // step 9.b.i.1
				iterated,
				NormalCompletion(sentinel)
			);
		}
		if (remaining !== Infinity) { // step 9.b.ii
			remaining -= 1; // step 9.b.ii.1
		}

		var value = IteratorStepValue(iterated); // step 6.b.i
		if (iterated['[[Done]]']) {
			return sentinel; // step 6.b.ii
		}

		return value; // step 9.b.iv
		// }
	};
	SLOT.set(closure, '[[Sentinel]]', sentinel); // for the userland implementation
	SLOT.set(closure, '[[CloseIfAbrupt]]', closeIfAbrupt); // for the userland implementation

	var result = CreateIteratorFromClosure(closure, 'Iterator Helper', IteratorHelperPrototype, ['[[UnderlyingIterators]]']); // step 7

	SLOT.set(result, '[[UnderlyingIterators]]', [iterated]); // step 8

	return result; // step 9
};

defineProperties(
	Iterator.prototype,
	{ take: IteratorPrototypeTake },
	{ take: function () { return Iterator.prototype.take !== IteratorPrototypeTake; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.prototype.toArray Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.prototype.toArray at fbd6ffe (v1.2.2)
// ==========================

// From es-iterator-helpers/Iterator.prototype.toArray/implementation.js
var IteratorPrototypeToArray = function toArray() {
	if (new.target !== undefined) {
		throw new TypeError('`toArray` is not a constructor');
	}

	var O = this; // step 1

	if (!isObject(O)) {
		throw new TypeError('`this` value must be an Object'); // step 2
	}

	var iterated = GetIteratorDirect(O); // step 3

	var items = []; // step 4

	// eslint-disable-next-line no-constant-condition
	while (true) { // step 5
		var value = IteratorStepValue(iterated); // step 5.a
		if (iterated['[[Done]]']) {
			return items; // step 5.b
		}
		items[items.length] = value; // step 5.d
	}
};

defineProperties(
	Iterator.prototype,
	{ toArray: IteratorPrototypeToArray },
	{ toArray: function () { return Iterator.prototype.toArray !== IteratorPrototypeToArray; } }
);
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.from Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.from at fbd6ffe (v1.2.2)
// ==========================

	// From es-iterator-helpers/WrapForValidIteratorPrototype/index.js
var $WrapForValidIteratorPrototype = /* GetIntrinsic('%WrapForValidIteratorPrototype%', true) || */ {
		__proto__: Iterator.prototype,
		next: function next() {
			var O = this; // step 1

			// RequireInternalSlot(O, [[Iterated]]); // step 2
			SLOT.assert(O, '[[Iterated]]');

			var iteratorRecord = SLOT.get(O, '[[Iterated]]'); // step 3

			return Call(iteratorRecord['[[NextMethod]]'], iteratorRecord['[[Iterator]]']); // step 4
		},
		'return': function () {
			var O = this; // step 1

			// RequireInternalSlot(O, [[Iterated]]); // step 2
			SLOT.assert(O, '[[Iterated]]');

			var iterator = SLOT.get(O, '[[Iterated]]')['[[Iterator]]']; // step 3

			if (!isObject(iterator)) {
				throw new TypeError('iterator must be an Object'); // step 4
			}

			var returnMethod = GetMethod(iterator, 'return'); // step 5

			if (typeof returnMethod === 'undefined') { // step 6
				return CreateIterResultObject(undefined, true); // step 6.a
			}
			return Call(returnMethod, iterator); // step 7
		}
	};

var IteratorFrom = function from(O) {
	if (new.target !== undefined) {
		throw new TypeError('`Iterator.from` is not a constructor');
	}

	var iteratorRecord = GetIteratorFlattenable(O, 'ITERATE-STRING-PRIMITIVES'); // step 1

	var hasInstance = OrdinaryHasInstance(Iterator, iteratorRecord['[[Iterator]]']); // step 2

	if (hasInstance) { // step 3
		return iteratorRecord['[[Iterator]]']; // step 3.a
	}

	var wrapper = OrdinaryObjectCreate($WrapForValidIteratorPrototype); // , ['[[Iterated]]']); // step 4

	SLOT.set(wrapper, '[[Iterated]]', iteratorRecord); // step 5

	return wrapper; // step 6
};

// Note: Iterator.from is attached to the Iterator constructor, not Iterator.prototype
defineProperties(
	Iterator,
	{ from: IteratorFrom },
	{ from: function () { return Iterator.from !== IteratorFrom; } }
);
/* @nolint */
/**
 * BSD 3-Clause License
 *
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2024 Kevin Gibbons
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *  this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation
 *  and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *  may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 *  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 *  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 *  DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 *  FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 *  DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 *  SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 *  CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 *  OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 *  OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

// Math.sumPrecise polyfill from TC39 proposal
// https://github.com/tc39/proposal-math-sum
// Algorithm based on:
// - Shewchuk's algorithm for exact floating point addition
//   https://www-2.cs.cmu.edu/afs/cs/project/quake/public/papers/robust-arithmetic.ps
// - Python's math.fsum implementation
//   https://github.com/python/cpython/blob/48dfd74a9db9d4aa9c6f23b4a67b461e5d977173/Modules/mathmodule.c#L1359-L1474
//   Portions derived from Python - Copyright (c) 2001 Python Software Foundation; All Rights Reserved
// - Adapted to handle overflow via an additional "biased" partial, representing 2**1024 times its actual value

Object.defineProperty(Math, 'sumPrecise', {
  value: function sumPrecise(iterable) {
  // Type check - ensure iterable has Symbol.iterator
  if (!iterable || typeof iterable[Symbol.iterator] !== 'function') {
    throw new TypeError('Math.sumPrecise requires an iterable');
  }

  // exponent 11111111110, significand all 1s
  const MAX_DOUBLE = 1.79769313486231570815e+308; // i.e. (2**1024 - 2**(1023 - 52))

  // exponent 11111111110, significand all 1s except final 0
  const PENULTIMATE_DOUBLE = 1.79769313486231550856e+308; // i.e. (2**1024 - 2 * 2**(1023 - 52))

  // exponent 11111001010, significand all 0s
  const MAX_ULP = MAX_DOUBLE - PENULTIMATE_DOUBLE; // 1.99584030953471981166e+292, i.e. 2**(1023 - 52)

  // prerequisite: Math.abs(x) >= Math.abs(y)
  function twosum(x, y) {
    let hi = x + y;
    let lo = y - (hi - x);
    return { hi, lo };
  }

  let partials = [];

  let overflow = 0; // conceptually 2**1024 times this value; the final partial

  // State machine states
  const STATE_LEADING_ZEROS = 0;   // Skipping leading -0 values
  const STATE_PROCESSING = 1;      // Main Shewchuk algorithm
  const STATE_DRAIN_NON_FINITE = 2; // Draining after non-finite found

  let state = STATE_LEADING_ZEROS;
  let nonFiniteResult;

  for (let value of iterable) {
    switch (state) {
      case STATE_LEADING_ZEROS:
        // Skip leading -0 values
        if (Object.is(value, -0)) continue;
        // Check if value is not a number type
        if (typeof value !== 'number') {
          throw new TypeError('Math.sumPrecise expects numbers');
        }
        if (!Number.isFinite(value)) {
          nonFiniteResult = value;
          state = STATE_DRAIN_NON_FINITE;
          continue;
        }
        partials.push(value);
        state = STATE_PROCESSING;
        break;

      case STATE_PROCESSING: {
        // Check if value is not a number type (reject BigInt, objects, etc)
        if (typeof value !== 'number') {
          throw new TypeError('Math.sumPrecise expects numbers');
        }
        let x = value;
        if (!Number.isFinite(x)) {
          nonFiniteResult = x;
          state = STATE_DRAIN_NON_FINITE;
          continue;
        }

        // we're updating partials in place, but it is maybe easier to understand if you think of it as making a new copy
        let actuallyUsedPartials = 0;
        // let newPartials = [];
        for (let y of partials) {
          if (Math.abs(x) < Math.abs(y)) {
            [x, y] = [y, x];
          }
          let { hi, lo } = twosum(x, y);
          if (Math.abs(hi) === Infinity) {
            let sign = hi === Infinity ? 1 : -1;
            overflow += sign;
            if (Math.abs(overflow) >= 2**53) {
              throw new RangeError('overflow');
            }

            x = (x - sign * 2**1023) - sign * 2**1023;
            if (Math.abs(x) < Math.abs(y)) {
              [x, y] = [y, x];
            }
            ({ hi, lo } = twosum(x, y));
          }
          if (lo !== 0) {
            partials[actuallyUsedPartials] = lo;
            ++actuallyUsedPartials;
            // newPartials.push(lo);
          }
          x = hi;
        }
        partials.length = actuallyUsedPartials;
        // assert.deepStrictEqual(partials, newPartials)
        // partials = newPartials

        if (x !== 0) {
          partials.push(x);
        }
        break;
      }

      case STATE_DRAIN_NON_FINITE:
        // Check if value is not a number type (reject BigInt, objects, etc)
        if (typeof value !== 'number') {
          throw new TypeError('Math.sumPrecise expects numbers');
        }
        // Drain remaining values, checking for conflicting non-finite values
        if (!Number.isFinite(value)) {
          // summing any distinct two of the three non-finite values gives NaN
          // summing any one of them with itself gives itself
          if (!Object.is(value, nonFiniteResult)) {
            nonFiniteResult = NaN;
          }
        }
        break;
    }
  }

  // Handle completion based on state
  if (state === STATE_LEADING_ZEROS) return -0;
  if (state === STATE_DRAIN_NON_FINITE) return nonFiniteResult;

  // compute the exact sum of partials, stopping once we lose precision
  let n = partials.length - 1;
  let hi = 0;
  let lo = 0;

  if (overflow !== 0) {
    let next = n >= 0 ? partials[n] : 0;
    --n;
    if (Math.abs(overflow) > 1 || (overflow > 0 && next > 0 || overflow < 0 && next < 0)) {
      return overflow > 0 ? Infinity : -Infinity;
    }
    // here we actually have to do the arithmetic
    // drop a factor of 2 so we can do it without overflow
    // assert(Math.abs(overflow) === 1)
    ({ hi, lo } = twosum(overflow * 2**1023, next / 2));
    lo *= 2;
    if (Math.abs(2 * hi) === Infinity) {
      // stupid edge case: rounding to the maximum value
      // MAX_DOUBLE has a 1 in the last place of its significand, so if we subtract exactly half a ULP from 2**1024, the result rounds away from it (i.e. to infinity) under ties-to-even
      // but if the next partial has the opposite sign of the current value, we need to round towards MAX_DOUBLE instead
      // this is the same as the "handle rounding" case below, but there's only one potentially-finite case we need to worry about, so we just hardcode that one
      if (hi > 0) {
        if (hi === 2**1023 && lo === -(MAX_ULP / 2) && n >= 0 && partials[n] < 0) {
          return MAX_DOUBLE;
        }
        return Infinity;
      } else {
        if (hi === -(2**1023) && lo === (MAX_ULP / 2) && n >= 0 && partials[n] > 0) {
          return -MAX_DOUBLE;
        }
        return -Infinity;
      }
    }
    if (lo !== 0) {
      partials[n + 1] = lo;
      ++n;
      lo = 0;
    }
    hi *= 2;
  }

  while (n >= 0) {
    let x = hi;
    let y = partials[n];
    --n;
    // assert: Math.abs(x) > Math.abs(y)
    ({ hi, lo } = twosum(x, y));
    if (lo !== 0) {
      break;
    }
  }

  // handle rounding
  // when the roundoff error is exactly half of the ULP for the result, we need to check one more partial to know which way to round
  if (n >= 0 && ((lo < 0.0 && partials[n] < 0.0) ||
                (lo > 0.0 && partials[n] > 0.0))) {
    let y = lo * 2.0;
    let x = hi + y;
    let yr = x - hi;
    if (y === yr) {
      hi = x;
    }
  }

  return hi;
  },
  writable: true,
  enumerable: false,
  configurable: true
});
/* @nolint */
/**
 * MIT License
 * Portions Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright (c) 2022 ECMAScript Shims
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// ==========================
// Iterator.concat Implementation
// Adapted from https://github.com/es-shims/iterator-helpers/tree/main/Iterator.concat at b790e7409435f3bd3f43edbf9dc1d962818d8f46
// ==========================

// From es-iterator-helpers/Iterator.concat/implementation.js
var IteratorConcat = function concat() {
	if (this instanceof concat) {
		throw new TypeError('`Iterator.concat` is not a constructor');
	}

	var iterables = []; // step 1

	for (var i = 0; i < arguments.length; i += 1) { // step 2
		var item = arguments[i];
		if (!isObject(item)) {
			throw new TypeError('`Iterator.concat` requires all arguments to be objects'); // step 2.1
		}
		var method = getIteratorMethod(
			{
				AdvanceStringIndex: AdvanceStringIndex,
				GetMethod: GetMethod,
				IsArray: IsArray
			},
			item
		);
		if (typeof method === 'undefined') {
			throw new TypeError('`Iterator.concat` requires all arguments to be iterable'); // step 2.3
		}
		iterables[iterables.length] = { '[[OpenMethod]]': method, '[[Iterable]]': item }; // step 2.4
	}

	var sentinel = {};
	var iterablesIndex = 0;
	var iteratorRecord;
	var innerAlive = false;
	var openIters = []; // track the current open iterator for return() forwarding
	var closure = function () { // step 3
		if (iterablesIndex >= iterables.length) {
			return sentinel;
		}
		var iterable = iterables[iterablesIndex]; // step 3.a
		if (!innerAlive) {
			var iter = Call(iterable['[[OpenMethod]]'], iterable['[[Iterable]]']); // step 3.a.i
			if (!isObject(iter)) {
				throw new TypeError('`Iterator.concat` iterator method did not return an object'); // step 3.a.ii
			}
			iteratorRecord = GetIteratorDirect(iter); // step 3.a.iii
			openIters[0] = iteratorRecord; // track the open iterator
			innerAlive = true; // step 3.a.iv
		}

		if (innerAlive) { // step 3.a.v
			var innerValue = IteratorStepValue(iteratorRecord); // step 3.a.v.1
			if (iteratorRecord['[[Done]]']) { // step 3.a.v.2
				innerAlive = false; // step 3.a.v.2.a
				openIters.length = 0; // no open iterator now
			} else { // step 3.a.v.3
				return innerValue; // step 3.a.v.3.a
			}
		}

		iterablesIndex += 1;
		return closure();
	};

	var closeIfAbrupt = function (abruptCompletion) {
		if (!(abruptCompletion instanceof CompletionRecord)) {
			throw new TypeError('`abruptCompletion` must be a Completion Record');
		}
		iterablesIndex = iterables.length;
		innerAlive = false;
		if (openIters.length > 0) {
			var toClose = openIters.slice();
			openIters.length = 0; // prevent double-closing
			IteratorCloseAll(toClose, abruptCompletion);
		}
	};

	SLOT.set(closure, '[[Sentinel]]', sentinel); // for the userland implementation
	SLOT.set(closure, '[[CloseIfAbrupt]]', closeIfAbrupt); // for the userland implementation

	var gen = CreateIteratorFromClosure(closure, 'Iterator Helper', IteratorHelperPrototype, ['[[UnderlyingIterators]]']); // step 5
	SLOT.set(gen, '[[UnderlyingIterators]]', openIters); // step 6 - share the array reference
	return gen; // step 7
};

defineProperties(
	Iterator,
	{ concat: IteratorConcat },
	{ concat: function () { return Iterator.concat !== IteratorConcat; } }
);
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// See header.js for documentation

  // Returning the result object as the completion value of the IIFE.
  return internalBytecodeResult;
})();

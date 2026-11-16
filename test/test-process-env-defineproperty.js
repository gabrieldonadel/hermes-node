// RUN: %hermes-node %s | %FileCheck %s
// Object.defineProperty on process.env must not break the Proxy invariants.

'use strict';
Object.defineProperties(process.env, {
  HN_READONLY: { enumerable: true, value: 'ro' },
});
Object.defineProperty(process.env, 'HN_PLAIN', {
  value: 'plain', writable: true, enumerable: true, configurable: true,
});

var keys = Object.keys(process.env);
console.log(keys.indexOf('HN_READONLY') >= 0, keys.indexOf('HN_PLAIN') >= 0);
// CHECK: true true
console.log(process.env.HN_READONLY, process.env.HN_PLAIN);
// CHECK-NEXT: ro plain
console.log(Object.getOwnPropertyDescriptor(process.env, 'HN_READONLY').configurable);
// CHECK-NEXT: false

var copy = Object.assign({}, process.env);
console.log(copy.HN_READONLY, copy.HN_PLAIN);
// CHECK-NEXT: ro plain

// Both reach child processes.
var out = require('child_process').execFileSync(
    '/bin/sh', ['-c', 'echo $HN_READONLY $HN_PLAIN']).toString().trim();
console.log(out);
// CHECK-NEXT: ro plain
console.log('PASS');
// CHECK-NEXT: PASS

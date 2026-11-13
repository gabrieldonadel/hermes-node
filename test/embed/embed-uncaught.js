// RUN: %hermes-node-embed-test %s 2>&1 | %FileCheck %s
// An uncaught exception in a Node callback must not end the host process.

var timers = nodeRequire('timers');

timers.setTimeout(function() {
  throw new Error('boom in timer');
}, 10);
// CHECK: Error: boom in timer

timers.setTimeout(function() {
  process.nextTick(function() {
    throw new Error('boom in tick');
  });
}, 50);
// CHECK: Error: boom in tick

// Timers still fire after both throws, and 'exit' was not emitted.
var exited = false;
process.on('exit', function() { exited = true; });
timers.setTimeout(function() {
  print('alive', exited);
  hostDone(0);
}, 200);
// CHECK: alive false

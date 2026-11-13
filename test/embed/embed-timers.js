// RUN: %hermes-node-embed-test %s | %FileCheck %s
// A timer that is due long after the last loop activity must still fire:
// nothing but the timer itself wakes the host here.

var timers = nodeRequire('timers');

timers.setTimeout(function() { print('first'); }, 10);
// CHECK: first

timers.setTimeout(function() {
  print('second');
  hostDone(0);
}, 200);
// CHECK-NEXT: second

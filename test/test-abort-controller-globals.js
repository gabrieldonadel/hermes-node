// RUN: %hermes-node %s | %FileCheck %s

'use strict';
console.log(typeof AbortController, typeof AbortSignal, typeof EventTarget,
            typeof Event);
// CHECK: function function function function

const ac = new AbortController();
ac.signal.addEventListener('abort', () => console.log('aborted',
                                                       ac.signal.aborted));
ac.abort();
// CHECK-NEXT: aborted true

const s = AbortSignal.timeout(10);
s.addEventListener('abort', () => {
  console.log('timeout', s.reason.name);
  // CHECK-NEXT: timeout TimeoutError
  console.log('PASS');
  // CHECK-NEXT: PASS
});

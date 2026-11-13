// RUN: %hermes-node-embed-test %s | %FileCheck %s
// Runs inside a host-owned runtime: only `nodeRequire`, `print`,
// `hostSetTimeout` and `hostDone` exist; Node's globals are not installed.

var fs = nodeRequire('fs');
var os = nodeRequire('node:os');
var path = nodeRequire('path');
var cp = nodeRequire('child_process');
var net = nodeRequire('net');
var timers = nodeRequire('timers');

print('globals', typeof setTimeout, typeof Buffer, typeof console);
// CHECK: globals undefined undefined undefined

print('sync', fs.existsSync('/'), typeof os.homedir(), path.join('a', 'b'));
// CHECK-NEXT: sync true string a/b

var steps = [];
var expected = 6;
function step(name) {
  steps.push(name);
  if (steps.length === expected) {
    steps.sort();
    print('async', steps.join(','));
    try {
      process.exit(3);
    } catch (e) {
      print('exit', e.message);
    }
    hostDone(0);
  }
}

// Started from host JS, outside any libuv iteration.
fs.readFile(__filename_or_self(), 'utf8', function(err, data) {
  step(err ? 'readFile:' + err.code : 'readFile');
});
fs.promises.readdir('/').then(function() { step('promises'); });
timers.setTimeout(function() { step('timer'); }, 30);
process.nextTick(function() { step('nextTick'); });
cp.execFile('/bin/echo', ['hi'], function(err, stdout) {
  step(err ? 'execFile:' + err.message : 'execFile:' + stdout.trim());
});

// I/O started later from a host task (not from a Node callback).
hostSetTimeout(function() {
  var server = net.createServer(function(sock) {
    sock.end('pong');
  });
  server.listen(0, '127.0.0.1', function() {
    var port = server.address().port;
    var c = net.connect(port, '127.0.0.1');
    var got = '';
    c.on('data', function(d) { got += d; });
    c.on('end', function() {
      server.close();
      step('tcp:' + got);
    });
  });
}, 50);

function __filename_or_self() {
  return process.argv[1];
}

// CHECK-NEXT: async execFile:hi,nextTick,promises,readFile,tcp:pong,timer
// CHECK-NEXT: exit process.exit(3) is not available in an embedded hermes-node runtime

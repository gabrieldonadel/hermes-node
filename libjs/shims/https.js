// Stub https module -- TLS is not yet implemented.
// Allows packages that require('https') at top level to load without
// crashing, as long as they only use http at runtime.
'use strict';

const { Agent: HttpAgent } = require('http');

function notImplemented() {
  throw new Error('https is not supported (TLS not implemented)');
}

// An Agent is an inert configuration holder -- it carries `ca`, `keepAlive`,
// `maxSockets` and friends, and does nothing until a request actually uses it.
// Modules routinely construct one at import time and only reach for it later
// (eas-shared's fetch.ts builds `new https.Agent({ ca })` at module scope),
// so throwing from the constructor turns a module-load into a hard failure for
// code paths that may never make an HTTPS request at all.
//
// Subclass the http Agent so option parsing, defaults and the `options`
// property behave as callers expect. Anything that actually needs TLS still
// fails, but it fails at request time with a clear message.
class Agent extends HttpAgent {
  createConnection() {
    notImplemented();
  }
}

module.exports = {
  Agent,
  Server: notImplemented,
  createServer: notImplemented,
  get: notImplemented,
  globalAgent: new Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5000 }),
  request: notImplemented,
};

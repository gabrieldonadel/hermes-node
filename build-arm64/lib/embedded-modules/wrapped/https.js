(function(exports, require, module, __filename, __dirname) {// https on top of the http client and the tls module.
//
// Node's https.js leans on _tls_wrap internals; this builds the same surface
// out of the pieces that exist here. http's client already drives its socket
// through ordinary stream events (the parser is fed from JS rather than
// attached as a native StreamListener), so handing it a TLSSocket -- itself a
// Duplex -- is enough to make HTTPS work without any further native support.
'use strict';

var http = require('http');
var tls = require('tls');
var url = require('url');

function notImplemented(what) {
  return function() {
    throw new Error('https: ' + what + ' is not implemented (server-side ' +
      'TLS is out of scope)');
  };
}

// An https.Agent is an http.Agent that dials with TLS instead of TCP.
function Agent(options) {
  if (!(this instanceof Agent))
    return new Agent(options);
  options = options || {};
  http.Agent.call(this, options);
  this.defaultPort = 443;
  this.protocol = 'https:';
  // Carried through to tls.connect so `ca`, `cert`, `key` and
  // `rejectUnauthorized` set on the agent apply to every connection it makes.
  // eas-shared constructs `new https.Agent({ ca })` once and reuses it.
  this._tlsOptions = options;
}
Object.setPrototypeOf(Agent.prototype, http.Agent.prototype);
Object.setPrototypeOf(Agent, http.Agent);

Agent.prototype.createConnection = function createConnection(options) {
  var opts = {};
  var k;
  for (k in this._tlsOptions)
    opts[k] = this._tlsOptions[k];
  for (k in options)
    if (options[k] !== undefined)
      opts[k] = options[k];

  if (!opts.servername && typeof opts.host === 'string')
    opts.servername = opts.host;
  if (!opts.port)
    opts.port = 443;

  return tls.connect(opts);
};

// Keyed so that connections differing in TLS material are never pooled
// together -- otherwise a request with a custom `ca` could be handed a socket
// established under the default roots.
Agent.prototype.getName = function getName(options) {
  options = options || {};
  var name = http.Agent.prototype.getName.call(this, options);
  var opts = this._tlsOptions || {};

  name += ':' + (options.servername || opts.servername || '');
  name += ':' + (options.rejectUnauthorized !== undefined
    ? options.rejectUnauthorized
    : opts.rejectUnauthorized !== undefined ? opts.rejectUnauthorized : '');
  name += ':' + (options.ca || opts.ca ? 'ca' : '');
  name += ':' + (options.cert || opts.cert ? 'cert' : '');
  return name;
};

var globalAgent = new Agent({ keepAlive: false });

function request(a, b, c) {
  var options = {};
  var cb;

  // request(url[, options][, cb]) / request(options[, cb])
  if (typeof a === 'string') {
    var parsed = new url.URL(a);
    options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      host: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
    };
    if (typeof b === 'object' && b !== null) {
      for (var k in b)
        options[k] = b[k];
      cb = c;
    } else {
      cb = b;
    }
  } else if (a instanceof url.URL) {
    options = {
      protocol: a.protocol,
      hostname: a.hostname,
      host: a.hostname,
      port: a.port || 443,
      path: a.pathname + (a.search || ''),
    };
    if (typeof b === 'object' && b !== null) {
      for (var k2 in b)
        options[k2] = b[k2];
      cb = c;
    } else {
      cb = b;
    }
  } else {
    for (var k3 in a)
      options[k3] = a[k3];
    cb = b;
  }

  options.protocol = 'https:';
  if (!options.port)
    options.port = 443;

  // A caller that passes TLS material without an agent gets an agent built
  // for it, rather than silently connecting under the default roots.
  if (options.agent === undefined && !options._defaultAgent) {
    if (options.ca || options.cert || options.key ||
        options.rejectUnauthorized !== undefined ||
        options.servername) {
      options.agent = new Agent(options);
    }
  }
  if (!options._defaultAgent)
    options._defaultAgent = globalAgent;

  return http.request(options, cb);
}

function get(a, b, c) {
  var req = request(a, b, c);
  req.end();
  return req;
}

module.exports = {
  Agent: Agent,
  globalAgent: globalAgent,
  request: request,
  get: get,
  Server: notImplemented('Server'),
  createServer: notImplemented('createServer'),
};

});
//# sourceURL=https

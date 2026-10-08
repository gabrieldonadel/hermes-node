// TLS implemented on top of the native memory-BIO engine.
//
// The engine (internalBinding('tls')) does the handshake and record crypto but
// performs no I/O. This module owns the pumping: ciphertext from the socket
// goes into the engine, ciphertext the engine produces goes out to the socket,
// and plaintext crosses the Duplex interface that callers see.
//
// Node does this natively instead: TLSWrap is both a StreamBase and a
// StreamListener on its parent stream. hermes-node has no StreamBase
// abstraction -- LibuvStreamBase is bound to a real uv_stream_t -- so
// Node's _tls_wrap.js cannot be used as-is here.
//
// The upside of pumping in JS is that the underlying stream only has to be a
// Duplex. `tls.connect({ socket })` over an arbitrary stream therefore works
// on the same code path as a plain TCP connection, which is what the
// lockdownd/usbmux flow for physical iOS devices needs.
'use strict';

var net = require('net');
var { Duplex } = require('stream');
var { Buffer } = require('buffer');
var binding = internalBinding('tls');

var TlsEngine = binding.TlsEngine;
var STATUS = binding.status;

// Big enough for a TLS record (max ~16 KiB plus header and MAC overhead), so
// a single readCiphertext/readPlaintext call usually drains one record.
var CHUNK = 17 * 1024;

var DEFAULT_MIN_VERSION = 'TLSv1.2';
var DEFAULT_MAX_VERSION = 'TLSv1.3';

function TLSSocket(socket, options) {
  if (!(this instanceof TLSSocket))
    return new TLSSocket(socket, options);

  options = options || {};
  Duplex.call(this, { allowHalfOpen: true });

  this._tlsOptions = options;
  this._socket = socket;
  this._engine = new TlsEngine({
    isServer: !!options.isServer,
    servername: options.servername || options.host || '',
    rejectUnauthorized: options.rejectUnauthorized !== false,
    requestCert: !!options.requestCert,
    ca: options.ca,
    cert: options.cert,
    key: options.key,
  });

  this.authorized = false;
  this.authorizationError = null;
  this.encrypted = true;
  this._secureEstablished = false;
  this._pendingWrites = [];
  this._readingPaused = false;
  this._closed = false;

  var self = this;

  this._onSocketData = function(chunk) {
    self._receive(chunk);
  };
  this._onSocketEnd = function() {
    // A peer that disappears without close_notify is a truncation. Surface it
    // as end-of-stream rather than inventing an error: HTTP/1.1 responses
    // delimited by connection close rely on this.
    self.push(null);
  };
  this._onSocketError = function(err) {
    self.destroy(err);
  };
  this._onSocketClose = function() {
    if (!self._closed) {
      self._closed = true;
      self.push(null);
    }
  };

  socket.on('data', this._onSocketData);
  socket.on('end', this._onSocketEnd);
  socket.on('error', this._onSocketError);
  socket.on('close', this._onSocketClose);

  // Kick the handshake off. For a client this produces the ClientHello; for a
  // server it just reports WANT_READ until the peer speaks.
  this._step();
}

Object.setPrototypeOf(TLSSocket.prototype, Duplex.prototype);
Object.setPrototypeOf(TLSSocket, Duplex);

/// Move any ciphertext the engine has produced out to the socket.
TLSSocket.prototype._flushOutbound = function() {
  if (!this._socket || this._socket.destroyed)
    return;
  for (;;) {
    var buf = Buffer.allocUnsafe(CHUNK);
    var n = this._engine.readCiphertext(buf);
    if (n <= 0)
      break;
    this._socket.write(buf.subarray(0, n));
  }
};

/// Advance the handshake if needed, then flush whatever it produced.
TLSSocket.prototype._step = function() {
  if (this._secureEstablished) {
    this._flushOutbound();
    return true;
  }

  var status = this._engine.handshake();
  this._flushOutbound();

  if (status === STATUS.ERROR) {
    this.destroy(new Error(this._engine.lastError() || 'TLS handshake failed'));
    return false;
  }

  if (this._engine.isHandshakeComplete()) {
    this._secureEstablished = true;

    var verifyError = this._engine.verifyError();
    this.authorized = !verifyError;
    this.authorizationError = verifyError || null;

    if (verifyError && this._tlsOptions.rejectUnauthorized !== false) {
      var err = new Error(verifyError);
      err.code = 'CERT_' + String(verifyError).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      this.destroy(err);
      return false;
    }

    // Writes issued before the handshake finished were held back; they can go
    // now, in order.
    var pending = this._pendingWrites;
    this._pendingWrites = [];
    for (var i = 0; i < pending.length; i++)
      this._writeNow(pending[i].chunk, pending[i].cb);

    this.emit('secureConnect');
    this.emit('secure');
  }

  return true;
};

/// Handle ciphertext arriving from the socket.
TLSSocket.prototype._receive = function(chunk) {
  if (this._engine.writeCiphertext(chunk) < 0) {
    this.destroy(new Error('TLS: failed to buffer incoming data'));
    return;
  }

  if (!this._step())
    return;
  if (!this._secureEstablished)
    return;

  this._drainPlaintext();
};

/// Pull all currently available plaintext out of the engine and push it to
/// the readable side.
TLSSocket.prototype._drainPlaintext = function() {
  for (;;) {
    var buf = Buffer.allocUnsafe(CHUNK);
    var res = this._engine.readPlaintext(buf);

    if (res.n > 0) {
      // A false return means the consumer wants us to stop; the socket's own
      // backpressure then keeps the rest buffered in the kernel.
      if (!this.push(buf.subarray(0, res.n)) && this._socket.pause) {
        this._readingPaused = true;
        this._socket.pause();
        return;
      }
      continue;
    }

    if (res.status === STATUS.WANT_READ)
      return; // need more ciphertext
    if (res.status === STATUS.CLOSED) {
      this.push(null);
      return;
    }
    if (res.status === STATUS.ERROR) {
      this.destroy(new Error(this._engine.lastError() || 'TLS read failed'));
      return;
    }
    return;
  }
};

TLSSocket.prototype._read = function() {
  if (this._readingPaused) {
    this._readingPaused = false;
    if (this._socket.resume)
      this._socket.resume();
  }
  // Records already buffered in the engine have to be delivered here:
  // without this a consumer that paused mid-record would stall, because no
  // further socket 'data' event is required to make progress.
  if (this._secureEstablished)
    this._drainPlaintext();
};

TLSSocket.prototype._writeNow = function(chunk, cb) {
  var offset = 0;
  while (offset < chunk.length) {
    var n = this._engine.writePlaintext(chunk.subarray(offset));
    if (n > 0) {
      offset += n;
      this._flushOutbound();
      continue;
    }
    // Negative values carry the status code negated.
    var status = -n;
    if (status === STATUS.WANT_READ) {
      // Mid-renegotiation: hold the remainder until more ciphertext arrives.
      this._pendingWrites.push({ chunk: chunk.subarray(offset), cb: cb });
      this._flushOutbound();
      return;
    }
    this._flushOutbound();
    var err = new Error(this._engine.lastError() || 'TLS write failed');
    if (cb) cb(err);
    else this.destroy(err);
    return;
  }
  this._flushOutbound();
  if (cb) cb();
};

TLSSocket.prototype._write = function(chunk, encoding, cb) {
  if (!Buffer.isBuffer(chunk))
    chunk = Buffer.from(chunk, encoding);

  if (!this._secureEstablished) {
    this._pendingWrites.push({ chunk: chunk, cb: cb });
    return;
  }
  this._writeNow(chunk, cb);
};

TLSSocket.prototype._final = function(cb) {
  try {
    this._engine.shutdown();
    this._flushOutbound();
    if (this._socket && this._socket.end)
      this._socket.end();
  } catch (e) {
    // Shutting down a connection that is already gone is not an error worth
    // propagating.
  }
  cb();
};

TLSSocket.prototype._destroy = function(err, cb) {
  this._closed = true;
  if (this._socket) {
    this._socket.removeListener('data', this._onSocketData);
    this._socket.removeListener('end', this._onSocketEnd);
    this._socket.removeListener('error', this._onSocketError);
    this._socket.removeListener('close', this._onSocketClose);
    if (this._socket.destroy)
      this._socket.destroy();
  }
  cb(err);
};

// --- introspection, mirroring tls.TLSSocket ------------------------------

TLSSocket.prototype.getProtocol = function() {
  return this._engine.getProtocol() || null;
};
TLSSocket.prototype.getCipher = function() {
  return this._engine.getCipher();
};
TLSSocket.prototype.getPeerCertificate = function() {
  return this._engine.getPeerCertificate();
};
TLSSocket.prototype.isSessionReused = function() {
  return false;
};
TLSSocket.prototype.getSession = function() {
  return undefined;
};
TLSSocket.prototype.getEphemeralKeyInfo = function() {
  return {};
};
TLSSocket.prototype.getFinished = function() {
  return undefined;
};
TLSSocket.prototype.getPeerFinished = function() {
  return undefined;
};
TLSSocket.prototype.setServername = function() {
  // SNI is fixed when the engine is constructed.
};

// http's client calls these on whatever socket an agent hands it, so they have
// to exist. Delegate the ones the underlying socket can answer.
TLSSocket.prototype.setNoDelay = function(enable) {
  if (this._socket && this._socket.setNoDelay)
    this._socket.setNoDelay(enable);
  return this;
};
TLSSocket.prototype.setKeepAlive = function(enable, delay) {
  if (this._socket && this._socket.setKeepAlive)
    this._socket.setKeepAlive(enable, delay);
  return this;
};
TLSSocket.prototype.setTimeout = function(msecs, cb) {
  if (this._socket && this._socket.setTimeout)
    this._socket.setTimeout(msecs, cb);
  return this;
};
TLSSocket.prototype.ref = function() {
  if (this._socket && this._socket.ref)
    this._socket.ref();
  return this;
};
TLSSocket.prototype.unref = function() {
  if (this._socket && this._socket.unref)
    this._socket.unref();
  return this;
};
TLSSocket.prototype.address = function() {
  return this._socket && this._socket.address ? this._socket.address() : {};
};

Object.defineProperty(TLSSocket.prototype, 'remoteAddress', {
  configurable: true,
  get: function() {
    return this._socket ? this._socket.remoteAddress : undefined;
  },
});
Object.defineProperty(TLSSocket.prototype, 'remotePort', {
  configurable: true,
  get: function() {
    return this._socket ? this._socket.remotePort : undefined;
  },
});
Object.defineProperty(TLSSocket.prototype, 'localAddress', {
  configurable: true,
  get: function() {
    return this._socket ? this._socket.localAddress : undefined;
  },
});
Object.defineProperty(TLSSocket.prototype, 'localPort', {
  configurable: true,
  get: function() {
    return this._socket ? this._socket.localPort : undefined;
  },
});

// --- connect --------------------------------------------------------------

/// tls.connect(options[, cb])
/// tls.connect(port[, host][, options][, cb])
function normalizeConnectArgs(args) {
  var options = {};
  var cb = null;
  var i = 0;

  if (typeof args[0] === 'number') {
    options.port = args[0];
    i = 1;
    if (typeof args[i] === 'string') {
      options.host = args[i];
      i++;
    }
  }
  if (args[i] && typeof args[i] === 'object') {
    var given = args[i];
    for (var k in given)
      options[k] = given[k];
    i++;
  }
  if (typeof args[i] === 'function')
    cb = args[i];

  return { options: options, cb: cb };
}

function connect() {
  var norm = normalizeConnectArgs(Array.prototype.slice.call(arguments));
  var options = norm.options;
  var cb = norm.cb;

  if (!options.servername && typeof options.host === 'string')
    options.servername = options.host;

  var socket = options.socket;
  var ownSocket = false;
  if (!socket) {
    if (options.path) {
      socket = net.connect({ path: options.path });
    } else {
      socket = net.connect({
        port: options.port,
        host: options.host || 'localhost',
        family: options.family,
        localAddress: options.localAddress,
        localPort: options.localPort,
      });
    }
    ownSocket = true;
  }

  var tlsSock = new TLSSocket(socket, options);

  if (cb)
    tlsSock.once('secureConnect', cb);

  if (ownSocket) {
    // Nothing is sent until the TCP connection is up; the ClientHello the
    // engine already produced is buffered on the socket and flushed on
    // connect, so no extra sequencing is needed here. Surface connect errors.
    socket.once('connect', function() {
      tlsSock._step();
    });
  }

  return tlsSock;
}

function createSecureContext(options) {
  // The engine takes its configuration directly, so a context is just the
  // options carried to the point of use. Shape matches what callers read.
  return { context: options || {}, options: options || {} };
}

function notImplemented(what) {
  return function() {
    throw new Error('tls: ' + what + ' is not implemented');
  };
}

module.exports = {
  TLSSocket: TLSSocket,
  connect: connect,
  createSecureContext: createSecureContext,
  // Server-side TLS is deliberately out of scope: nothing in this runtime's
  // intended use terminates TLS.
  createServer: notImplemented('createServer'),
  Server: notImplemented('Server'),
  createSecurePair: notImplemented('createSecurePair'),
  getCiphers: function() {
    return [];
  },
  rootCertificates: [],
  DEFAULT_ECDH_CURVE: 'auto',
  DEFAULT_MIN_VERSION: DEFAULT_MIN_VERSION,
  DEFAULT_MAX_VERSION: DEFAULT_MAX_VERSION,
  CLIENT_RENEG_LIMIT: 3,
  CLIENT_RENEG_WINDOW: 600,
};

/*!
 * compression
 * Copyright(c) 2010 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

const accepts = require('accepts');
const bytes = require('bytes');
const compressible = require('compressible');
const debug = require('debug')('compression');
const onHeaders = require('on-headers');
const vary = require('vary');
const zlib = require('zlib');

const defaultThreshold = 1024;

const shouldCompress = (req, res) => {
  const type = res.getHeader('Content-Type');

  if (type === undefined || !compressible(type)) {
    debug('%s not compressible', type);
    return false;
  }

  return true;
};

const chunkLength = (chunk, encoding) => {
  if (!chunk) {
    return 0;
  }

  return Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
};

const shouldTransform = (req, res) => {
  const cacheControlNoTransformRegExp = /(?:^|,)\s*?no-transform\s*?(?:,|$)/;
  const cacheControl = res.getHeader('Cache-Control');

  // Don't compress for Cache-Control: no-transform
  // https://tools.ietf.org/html/rfc7234#section-5.2.2.4
  return !cacheControl || !cacheControlNoTransformRegExp.test(cacheControl);
};

function compressionMiddleware(options) {
  const BROTLI_DEFAULT_QUALITY = 4;

  const opts = options || {};

  // options
  const filter = opts.filter || shouldCompress;
  const brotli = opts.brotli || {
    enabled: true,
  };
  const brotliZlib = brotli.zlib || {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_DEFAULT_QUALITY },
  };
  let threshold = bytes.parse(opts.threshold);
  const supportsBrotli = typeof zlib.createBrotliCompress === 'function';
  const brotliEnabled = brotli.enabled && supportsBrotli;

  if (threshold === null) {
    threshold = defaultThreshold;
  }

  const filterBrotliIfNotSupported = (encoding) => encoding !== 'br' || brotliEnabled;
  const checkEncoding = (accept) => (encoding) => accept.encoding(encoding);

  return function compression(req, res, next) {
    const addListeners = (stream, on, listeners) =>
      listeners.forEach((listener) => on.apply(stream, listener));

    let ended = false;
    let length;
    let listeners = [];
    let stream;

    const origEnd = res.end;
    const origOn = res.on;
    const origWrite = res.write;

    res.flush = () => stream && stream.flush();

    res.write = function write(chunk, encoding) {
      if (ended) {
        return false;
      }

      if (!this.headersSent) {
        this.writeHead(this.statusCode);
      }

      return stream ? stream.write(chunk, encoding) : origWrite.call(this, chunk, encoding);
    };

    res.end = function end(chunk, encoding) {
      if (ended) {
        return false;
      }

      if (!this.headersSent) {
        // estimate the length
        if (!this.getHeader('Content-Length')) {
          length = chunkLength(chunk, encoding);
        }

        this.writeHead(this.statusCode);
      }

      if (!stream) {
        return origEnd.call(this, chunk, encoding);
      }

      // mark ended
      ended = true;

      return chunk ? stream.end(chunk, encoding) : stream.end();
    };

    res.on = function on(type, listener) {
      if (!listeners || type !== 'drain') {
        return origOn.call(this, type, listener);
      }

      if (stream) {
        return stream.on(type, listener);
      }

      // buffer listeners for future stream
      listeners.push([type, listener]);

      return this;
    };

    onHeaders(res, () => {
      const noCompress = (msg) => {
        debug('no compression: %s', msg);
        addListeners(res, origOn, listeners);
        listeners = null;
      };

      // determine if request is filtered
      if (!filter(req, res)) {
        noCompress('filtered');
        return;
      }

      // determine if the entity should be transformed
      if (!shouldTransform(req, res)) {
        noCompress('no transform');
        return;
      }

      // vary
      vary(res, 'Accept-Encoding');

      // content-length below threshold
      if (Number(res.getHeader('Content-Length')) < threshold || length < threshold) {
        noCompress('size below threshold');
        return;
      }

      const encoding = res.getHeader('Content-Encoding') || 'identity';

      // already encoded
      if (encoding !== 'identity') {
        noCompress('already encoded');
        return;
      }

      // head
      if (req.method === 'HEAD') {
        noCompress('HEAD request');
        return;
      }

      // compression method
      const accept = accepts(req);
      const method =
        ['br', 'gzip', 'deflate']
          .filter(filterBrotliIfNotSupported)
          .filter(checkEncoding(accept))[0] || 'identity';

      // negotiation failed
      if (method === 'identity') {
        noCompress('not acceptable');
        return;
      }

      // compression stream
      debug('%s compression', method);
      switch (method) {
        case 'br':
          stream = zlib.createBrotliCompress(brotliZlib);
          break;
        case 'gzip':
          stream = zlib.createGzip(opts);
          break;
        case 'deflate':
          stream = zlib.createDeflate(opts);
          break;
        default:
      }

      // add buffered listeners to stream
      addListeners(stream, stream.on, listeners);

      // header fields
      res.setHeader('Content-Encoding', method);
      res.removeHeader('Content-Length');

      // compression
      stream.on('data', (chunk) => {
        if (origWrite.call(res, chunk) === false) {
          stream.pause();
        }
      });

      stream.on('end', () => origEnd.call(res));
      origOn.call(res, 'drain', () => stream.resume());
    });

    next();
  };
}

module.exports = compressionMiddleware;
module.exports.filter = shouldCompress;

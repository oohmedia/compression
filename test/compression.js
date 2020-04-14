const after = require("after");
const assert = require("assert");
const bytes = require("bytes");
const crypto = require("crypto");
const http = require("http");
const http2 = require("http2");
const request = require("supertest");
const zlib = require("zlib");
const compression = require("..");

const shouldHaveBodyLength = (length) => (res) => {
  assert.strictEqual(
    res.text.length,
    length,
    `should have body length of ${length}`
  );
};

function shouldNotHaveHeader(header) {
  return (res) => {
    assert.ok(
      !(header.toLowerCase() in res.headers),
      `should not have header ${header}`
    );
  };
}

function writeAndFlush(stream, count, buf) {
  let writes = 0;

  return () => {
    if (writes++ >= count) return;
    if (writes === count) {
      stream.end(buf);
      return;
    }
    stream.write(buf);
    stream.flush();
  };
}

function unchunk(encoding, onchunk, onend) {
  return (res) => {
    let stream;

    assert.strictEqual(res.headers["content-encoding"], encoding);

    switch (encoding) {
      case "deflate":
        stream = res.pipe(zlib.createInflate());
        break;
      case "gzip":
        stream = res.pipe(zlib.createGunzip());
        break;
      case "br":
        stream = res.pipe(zlib.createBrotliDecompress());
        break;
      default:
    }

    stream.on("data", onchunk);
    stream.on("end", onend);
  };
}

function createServer(opts, fn) {
  const _compression = compression(opts);
  return http.createServer((req, res) => {
    _compression(req, res, (err) => {
      if (err) {
        res.statusCode = err.status || 500;
        res.end(err.message);
        return;
      }

      fn(req, res);
    });
  });
}

describe("compression()", () => {
  it("should skip HEAD", (done) => {
    const server = createServer({ threshold: 0 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("hello, world");
    });

    request(server)
      .head("/")
      .set("Accept-Encoding", "gzip")
      .expect(shouldNotHaveHeader("Content-Encoding"))
      .expect(200, done);
  });

  it("should skip unknown accept-encoding", (done) => {
    const server = createServer({ threshold: 0 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("hello, world");
    });

    request(server)
      .get("/")
      .set("Accept-Encoding", "bogus")
      .expect(shouldNotHaveHeader("Content-Encoding"))
      .expect(200, done);
  });

  it("should skip if content-encoding already set", (done) => {
    const server = createServer({ threshold: 0 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Content-Encoding", "x-custom");
      res.end("hello, world");
    });

    request(server)
      .get("/")
      .set("Accept-Encoding", "gzip")
      .expect("Content-Encoding", "x-custom")
      .expect(200, "hello, world", done);
  });

  it("should set Vary", (done) => {
    const server = createServer({ threshold: 0 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("hello, world");
    });

    request(server)
      .get("/")
      .set("Accept-Encoding", "gzip")
      .expect("Content-Encoding", "gzip")
      .expect("Vary", "Accept-Encoding", done);
  });

  it("should set Vary even if Accept-Encoding is not set", (done) => {
    const server = createServer({ threshold: 1000 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("hello, world");
    });

    request(server)
      .get("/")
      .expect("Vary", "Accept-Encoding")
      .expect(shouldNotHaveHeader("Content-Encoding"))
      .expect(200, done);
  });

  it("should not set Vary if Content-Type does not pass filter", (done) => {
    const server = createServer(null, (req, res) => {
      res.setHeader("Content-Type", "image/jpeg");
      res.end();
    });

    request(server)
      .get("/")
      .expect(shouldNotHaveHeader("Vary"))
      .expect(200, done);
  });

  it("should set Vary for HEAD request", (done) => {
    const server = createServer({ threshold: 0 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("hello, world");
    });

    request(server)
      .head("/")
      .set("Accept-Encoding", "gzip")
      .expect("Vary", "Accept-Encoding", done);
  });

  it("should transfer chunked", (done) => {
    const server = createServer({ threshold: 0 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("hello, world");
    });

    request(server)
      .get("/")
      .set("Accept-Encoding", "gzip")
      .expect("Transfer-Encoding", "chunked", done);
  });

  it("should remove Content-Length for chunked", (done) => {
    const server = createServer({ threshold: 0 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("hello, world");
    });

    request(server)
      .get("/")
      .expect("Content-Encoding", "gzip")
      .expect(shouldNotHaveHeader("Content-Length"))
      .expect(200, done);
  });

  it("should work with encoding arguments", (done) => {
    const server = createServer({ threshold: 0 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.write("hello, ", "utf8");
      res.end("world", "utf8");
    });

    request(server)
      .get("/")
      .set("Accept-Encoding", "gzip")
      .expect("Transfer-Encoding", "chunked")
      .expect(200, "hello, world", done);
  });

  it("should allow writing after close", (done) => {
    // UGH
    const server = createServer({ threshold: 0 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.once("close", () => {
        res.write("hello, ");
        res.end("world");
        done();
      });
      res.destroy();
    });

    request(server)
      .get("/")
      .end(() => {});
  });

  it("should back-pressure when compressed", (done) => {
    let buf;
    const cb = after(2, done);
    let client;
    let drained = false;
    let resp;

    function pressure() {
      if (!buf || !resp || !client) return;

      assert.ok(!drained);

      while (resp.write(buf) !== false) {
        resp.flush();
      }

      resp.on("drain", () => {
        assert.ok(resp.write("end"));
        resp.end();
      });

      resp.on("finish", cb);
      client.resume();
    }

    const server = createServer({ threshold: 0 }, (req, res) => {
      resp = res;

      res.on("drain", () => {
        drained = true;
      });

      res.setHeader("Content-Type", "text/plain");
      res.write("start");
      pressure();
    });

    crypto.pseudoRandomBytes(1024 * 128, (err, chunk) => {
      if (err) return done(err);
      buf = chunk;
      return pressure();
    });

    request(server)
      .get("/")
      .request()
      .on("response", (res) => {
        client = res;
        assert.strictEqual(res.headers["content-encoding"], "gzip");
        res.pause();
        res.on("end", () => {
          server.close(cb);
        });
        pressure();
      })
      .end();
  });

  it("should back-pressure when uncompressed", (done) => {
    let buf;
    const cb = after(2, done);
    let client;
    let drained = false;
    let resp;

    function pressure() {
      if (!buf || !resp || !client) return;

      while (resp.write(buf) !== false) {
        resp.flush();
      }

      resp.on("drain", () => {
        assert.ok(drained);
        assert.ok(resp.write("end"));
        resp.end();
      });
      resp.on("finish", cb);
      client.resume();
    }

    const server = createServer(
      {
        filter() {
          return false;
        },
      },
      (req, res) => {
        resp = res;

        res.on("drain", () => {
          drained = true;
        });

        res.setHeader("Content-Type", "text/plain");
        res.write("start");
        pressure();
      }
    );

    crypto.pseudoRandomBytes(1024 * 128, (err, chunk) => {
      if (err) return done(err);
      buf = chunk;
      return pressure();
    });

    request(server)
      .get("/")
      .request()
      .on("response", (res) => {
        client = res;
        shouldNotHaveHeader("Content-Encoding")(res);
        res.pause();
        res.on("end", () => {
          server.close(cb);
        });
        pressure();
      })
      .end();
  });

  it("should transfer large bodies", (done) => {
    const len = bytes("1mb");
    const buf = Buffer.alloc(len, ".");
    const server = createServer({ threshold: 0 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end(buf);
    });

    request(server)
      .get("/")
      .set("Accept-Encoding", "gzip")
      .expect("Transfer-Encoding", "chunked")
      .expect("Content-Encoding", "gzip")
      .expect(shouldHaveBodyLength(len))
      .expect(200, buf.toString(), done);
  });

  it("should transfer large bodies with multiple writes", (done) => {
    const len = bytes("40kb");
    const buf = Buffer.alloc(len, ".");
    const server = createServer({ threshold: 0 }, (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.write(buf);
      res.write(buf);
      res.write(buf);
      res.end(buf);
    });

    request(server)
      .get("/")
      .set("Accept-Encoding", "gzip")
      .expect("Transfer-Encoding", "chunked")
      .expect("Content-Encoding", "gzip")
      .expect(shouldHaveBodyLength(len * 4))
      .expect(200, done);
  });

  describe("http2", () => {
    function createHttp2Server(opts, fn) {
      const _compression = compression(opts);
      const server = http2.createServer((req, res) => {
        _compression(req, res, (err) => {
          if (err) {
            res.statusCode = err.status || 500;
            res.end(err.message);
            return;
          }

          fn(req, res);
        });
      });
      server.listen(0, "127.0.0.1");
      return server;
    }

    function createHttp2Client(port) {
      return http2.connect(`http://127.0.0.1:${port}`);
    }

    function closeHttp2(request, client, server, callback) {
      if (typeof client.shutdown === "function") {
        // this is the node v8.x way of closing the connections
        request.destroy(http2.constants.NGHTTP2_NO_ERROR, () => {
          client.shutdown({}, () => {
            server.close(() => {
              callback();
            });
          });
        });
      } else {
        // this is the node v9.x onwards way of closing the connections
        request.close(http2.constants.NGHTTP2_NO_ERROR, () => {
          client.close(() => {
            // force existing connections to time out after 1ms.
            // this is done to force the server to close in some cases where it wouldn't do it otherwise.
            server.close(() => {
              callback();
            });
          });
        });
      }
    }

    it("should work with http2 server", (done) => {
      const server = createHttp2Server({ threshold: 0 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
      });
      server.on("listening", () => {
        const client = createHttp2Client(server.address().port);
        const request = client.request({
          "Accept-Encoding": "gzip",
        });
        request.on("response", (headers) => {
          assert.strictEqual(headers["content-encoding"], "gzip");
        });
        request.on("data", () => {
          // no-op without which the request will stay open and cause a test timeout
        });
        request.on("end", () => {
          closeHttp2(request, client, server, done);
        });
        request.end();
      });
    });
  });

  describe("threshold", () => {
    it("should not compress responses below the threshold size", (done) => {
      const server = createServer({ threshold: "1kb" }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Length", "12");
        res.end("hello, world");
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect(shouldNotHaveHeader("Content-Encoding"))
        .expect(200, done);
    });

    it("should compress responses above the threshold size", (done) => {
      const server = createServer({ threshold: "1kb" }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Length", "2048");
        res.end(Buffer.alloc(2048));
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect("Content-Encoding", "gzip", done);
    });

    it("should compress when streaming without a content-length", (done) => {
      const server = createServer({ threshold: "1kb" }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.write("hello, ");
        setTimeout(() => {
          res.end("world");
        }, 10);
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect("Content-Encoding", "gzip", done);
    });

    it("should not compress when streaming and content-length is lower than threshold", (done) => {
      const server = createServer({ threshold: "1kb" }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Length", "12");
        res.write("hello, ");
        setTimeout(() => {
          res.end("world");
        }, 10);
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect(shouldNotHaveHeader("Content-Encoding"))
        .expect(200, done);
    });

    it("should compress when streaming and content-length is larger than threshold", (done) => {
      const server = createServer({ threshold: "1kb" }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Length", "2048");
        res.write(Buffer.alloc(1024));
        setTimeout(() => {
          res.end(Buffer.alloc(1024));
        }, 10);
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect("Content-Encoding", "gzip", done);
    });

    // res.end(str, encoding) broken in node.js 0.8
    const run = /^v0\.8\./.test(process.version) ? it.skip : it;
    run("should handle writing hex data", (done) => {
      const server = createServer({ threshold: 6 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("2e2e2e2e", "hex");
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect(shouldNotHaveHeader("Content-Encoding"))
        .expect(200, "....", done);
    });

    it("should consider res.end() as 0 length", (done) => {
      const server = createServer({ threshold: 1 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end();
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect(shouldNotHaveHeader("Content-Encoding"))
        .expect(200, "", done);
    });

    it("should work with res.end(null)", (done) => {
      const server = createServer({ threshold: 1000 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(null);
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect(shouldNotHaveHeader("Content-Encoding"))
        .expect(200, "", done);
    });
  });

  describe('when "Accept-Encoding: gzip"', () => {
    it("should respond with gzip", (done) => {
      const server = createServer({ threshold: 0 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect("Content-Encoding", "gzip", done);
    });

    it("should return false writing after end", (done) => {
      const server = createServer({ threshold: 0 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
        assert.ok(res.write() === false);
        assert.ok(res.end() === false);
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect("Content-Encoding", "gzip", done);
    });
  });

  describe('when "Accept-Encoding: deflate"', () => {
    it("should respond with deflate", (done) => {
      const server = createServer({ threshold: 0 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "deflate")
        .expect("Content-Encoding", "deflate", done);
    });
  });

  describe('when "Accept-Encoding: br"', () => {
    it("should respond with br", (done) => {
      const server = createServer({ threshold: 0 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
      });

      if (zlib.createBrotliCompress) {
        request(server)
          .get("/")
          .set("Accept-Encoding", "br")
          .expect("Content-Encoding", "br", done);
      } else {
        request(server)
          .get("/")
          .set("Accept-Encoding", "br")
          .expect(shouldNotHaveHeader("Content-Encoding"))
          .expect(200, "hello, world", done);
      }
    });
    it("should respond with br, gzip", (done) => {
      const server = createServer({ threshold: 0 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
      });

      if (zlib.createBrotliCompress) {
        request(server)
          .get("/")
          .set("Accept-Encoding", "br, gzip")
          .expect("Content-Encoding", "br", done);
      } else {
        request(server)
          .get("/")
          .set("Accept-Encoding", "br, gzip")
          .expect("Content-Encoding", "gzip", done);
      }
    });

    it("should respond with gzip when br is disabled disabled", (done) => {
      const server = createServer(
        { threshold: 0, brotli: { enabled: false } },
        (req, res) => {
          res.setHeader("Content-Type", "text/plain");
          res.end("hello, world");
        }
      );

      if (zlib.createBrotliCompress) {
        request(server)
          .get("/")
          .set("Accept-Encoding", "gzip")
          .expect("Content-Encoding", "gzip", done);
      } else {
        request(server)
          .get("/")
          .set("Accept-Encoding", "gzip")
          .expect("Content-Encoding", "gzip", done);
      }
    });
  });

  describe('when "Accept-Encoding: gzip, deflate, br"', () => {
    it("should respond with br", (done) => {
      const server = createServer({ threshold: 0 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
      });

      if (zlib.createBrotliCompress) {
        request(server)
          .get("/")
          .set("Accept-Encoding", "gzip, deflate, br")
          .expect("Content-Encoding", "br", done);
      } else {
        request(server)
          .get("/")
          .set("Accept-Encoding", "gzip, deflate, br")
          .expect("Content-Encoding", "gzip", done);
      }
    });
  });

  describe('when "Accept-Encoding: gzip, deflate"', () => {
    it("should respond with gzip", (done) => {
      const server = createServer({ threshold: 0 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip, deflate")
        .expect("Content-Encoding", "gzip", done);
    });
  });

  describe('when "Accept-Encoding: deflate, gzip"', () => {
    it("should respond with gzip", (done) => {
      const server = createServer({ threshold: 0 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "deflate, gzip")
        .expect("Content-Encoding", "gzip", done);
    });
  });

  describe('when "Cache-Control: no-transform" response header', () => {
    it("should not compress response", (done) => {
      const server = createServer({ threshold: 0 }, (req, res) => {
        res.setHeader("Cache-Control", "no-transform");
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect("Cache-Control", "no-transform")
        .expect(shouldNotHaveHeader("Content-Encoding"))
        .expect(200, "hello, world", done);
    });

    it("should not set Vary headerh", (done) => {
      const server = createServer({ threshold: 0 }, (req, res) => {
        res.setHeader("Cache-Control", "no-transform");
        res.setHeader("Content-Type", "text/plain");
        res.end("hello, world");
      });

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .expect("Cache-Control", "no-transform")
        .expect(shouldNotHaveHeader("Vary"))
        .expect(200, done);
    });
  });

  describe(".filter", () => {
    it("should be a function", () => {
      assert.strictEqual(typeof compression.filter, "function");
    });

    it("should return false on empty response", (done) => {
      const server = http.createServer((req, res) => {
        res.end(String(compression.filter(req, res)));
      });

      request(server).get("/").expect(200, "false", done);
    });

    it('should return true for "text/plain"', (done) => {
      const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(String(compression.filter(req, res)));
      });

      request(server).get("/").expect(200, "true", done);
    });

    it('should return false for "application/x-bogus"', (done) => {
      const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/x-bogus");
        res.end(String(compression.filter(req, res)));
      });

      request(server).get("/").expect(200, "false", done);
    });
  });

  describe("res.flush()", () => {
    it("should always be present", (done) => {
      const server = createServer(null, (req, res) => {
        res.statusCode = typeof res.flush === "function" ? 200 : 500;
        res.flush();
        res.end();
      });

      request(server).get("/").expect(200, done);
    });

    it("should flush the response", (done) => {
      let chunks = 0;
      let next;
      const server = createServer({ threshold: 0 }, (req, res) => {
        next = writeAndFlush(res, 2, Buffer.alloc(1024));
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Content-Length", "2048");
        next();
      });

      function onchunk(chunk) {
        assert.ok(chunks++ < 2);
        assert.strictEqual(chunk.length, 1024);
        next();
      }

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .request()
        .on(
          "response",
          unchunk("gzip", onchunk, (err) => {
            if (err) return done(err);
            server.close(done);
            return undefined;
          })
        )
        .end();
    });

    it("should flush small chunks for gzip", (done) => {
      let chunks = 0;
      let next;
      const server = createServer({ threshold: 0 }, (req, res) => {
        next = writeAndFlush(res, 2, Buffer.from(".."));
        res.setHeader("Content-Type", "text/plain");
        next();
      });

      function onchunk(chunk) {
        assert.ok(chunks++ < 20);
        assert.strictEqual(chunk.toString(), "..");
        next();
      }

      request(server)
        .get("/")
        .set("Accept-Encoding", "gzip")
        .request()
        .on(
          "response",
          unchunk("gzip", onchunk, (err) => {
            if (err) return done(err);
            server.close(done);
            return undefined;
          })
        )
        .end();
    });

    it("should flush small chunks for deflate", (done) => {
      let chunks = 0;
      let next;
      const server = createServer({ threshold: 0 }, (req, res) => {
        next = writeAndFlush(res, 2, Buffer.from(".."));
        res.setHeader("Content-Type", "text/plain");
        next();
      });

      function onchunk(chunk) {
        assert.ok(chunks++ < 20);
        assert.strictEqual(chunk.toString(), "..");
        next();
      }

      request(server)
        .get("/")
        .set("Accept-Encoding", "deflate")
        .request()
        .on(
          "response",
          unchunk("deflate", onchunk, (err) => {
            if (err) return done(err);
            server.close(done);
            return undefined;
          })
        )
        .end();
    });

    it("should flush small chunks for br", (done) => {
      let chunks = 0;
      let next;
      const server = createServer(
        { threshold: 0, brotli: { enabled: true } },
        (req, res) => {
          next = writeAndFlush(res, 2, Buffer.from(".."));
          res.setHeader("Content-Type", "text/plain");
          next();
        }
      );

      function onchunk(chunk) {
        assert.ok(chunks++ < 20);
        assert.strictEqual(chunk.toString(), "..");
        next();
      }

      if (zlib.createBrotliCompress) {
        request(server)
          .get("/")
          .set("Accept-Encoding", "br")
          .request()
          .on(
            "response",
            unchunk("br", onchunk, (err) => {
              if (err) return done(err);
              server.close(done);
              return undefined;
            })
          )
          .end();
      } else {
        done();
      }
    });
  });
});

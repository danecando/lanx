const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const test = require("node:test");
const assert = require("node:assert/strict");
const { getPaths } = require("../lib/paths");
const { saveState, loadState } = require("../lib/state");
const { ensureLeafCertificate } = require("../lib/certs");
const { CA_HELP_HOST, startProxy, sanitizeHeaders, buildUpstreamPath, isPermissionError } = require("../lib/proxy");

function withHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lanx-proxy-"));
  const configHome = path.join(root, "config");
  const stateHome = path.join(root, "state");
  fs.mkdirSync(configHome, { recursive: true });
  fs.mkdirSync(stateHome, { recursive: true });
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  return root;
}

function listenHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(addr.port);
    });
  });
}

test("sanitizeHeaders removes hop-by-hop headers", () => {
  const headers = sanitizeHeaders({
    connection: "keep-alive",
    "keep-alive": "timeout=5",
    host: "example.local",
    upgrade: "websocket",
    "x-forwarded-for": "127.0.0.1"
  });
  assert.equal(headers.connection, undefined);
  assert.equal(headers["keep-alive"], undefined);
  assert.equal(headers.upgrade, undefined);
  assert.equal(headers.host, "example.local");
});

test("buildUpstreamPath respects upstream path prefix", () => {
  const upstream = new URL("http://127.0.0.1:9999/base");
  assert.equal(buildUpstreamPath(upstream, "/hello?q=1"), "/base/hello?q=1");
});

test("isPermissionError matches expected bind failures", () => {
  assert.equal(isPermissionError({ code: "EACCES" }), true);
  assert.equal(isPermissionError({ code: "EPERM" }), true);
  assert.equal(isPermissionError({ code: "EADDRINUSE" }), false);
});

test("startProxy falls back to unprivileged ports on permission errors", async () => {
  withHome();
  const paths = getPaths();
  ensureLeafCertificate("app.local", paths);

  const attempts = [];
  const proxy = await startProxy(paths, {
    logger: () => {},
    listenFn: async (server, port, host) => {
      attempts.push({ port, host });
      if (port === 80 || port === 443) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return port;
    },
  });

  assert.equal(proxy.httpPort, 8088);
  assert.equal(proxy.httpsPort, 8443);
  assert.equal(proxy.warnings.length, 1);
  assert.match(proxy.warnings[0], /Falling back to unprivileged ports 8088\/8443/);
  assert.deepEqual(
    attempts.map((attempt) => attempt.port),
    [80, 8088, 8443],
  );

  await proxy.stop();
});

test("proxy forwards HTTPS requests to configured upstream", async (t) => {
  withHome();
  const paths = getPaths();
  ensureLeafCertificate("app.local", paths);

  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/hello" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  let upstreamPort;
  try {
    upstreamPort = await listenHttpServer(upstream);
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Port binding is restricted in this environment");
      return;
    }
    throw error;
  }

  const state = loadState(paths);
  state.domains["app.local"] = {
    domain: "app.local",
    mode: "proxy",
    target: `http://127.0.0.1:${upstreamPort}`,
    protocol: "https",
    port: 443,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    certificate: null
  };
  saveState(state, paths);

  const logs = [];
  let proxy;
  try {
    proxy = await startProxy(paths, {
      httpPort: 0,
      httpsPort: 0,
      logger: (level, event, fields) => logs.push({ level, event, fields })
    });
  } catch (error) {
    await new Promise((resolve) => upstream.close(resolve));
    if (error.code === "EPERM") {
      t.skip("Port binding is restricted in this environment");
      return;
    }
    throw error;
  }

  const body = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: proxy.httpsPort,
        method: "GET",
        path: "/api/hello",
        rejectUnauthorized: false,
        headers: {
          host: "app.local"
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk);
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Expected 200, got ${res.statusCode}`));
            return;
          }
          resolve(raw);
        });
      }
    );
    req.once("error", reject);
    req.end();
  });

  const parsed = JSON.parse(body);
  assert.equal(parsed.ok, true);
  assert.match(parsed.host, /127\.0\.0\.1/);
  assert.equal(logs.some((line) => line.event === "proxy.request"), true);

  await proxy.stop();
  await new Promise((resolve) => upstream.close(resolve));
});

test("proxy serves CA install helper page from internal route", async (t) => {
  withHome();
  const paths = getPaths();
  ensureLeafCertificate("app.local", paths);

  const upstream = http.createServer((req, res) => {
    res.writeHead(500);
    res.end("upstream should not be hit");
  });
  let upstreamPort;
  try {
    upstreamPort = await listenHttpServer(upstream);
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Port binding is restricted in this environment");
      return;
    }
    throw error;
  }

  const state = loadState(paths);
  state.domains["app.local"] = {
    domain: "app.local",
    mode: "proxy",
    target: `http://127.0.0.1:${upstreamPort}`,
    protocol: "https",
    port: 443,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    certificate: null
  };
  saveState(state, paths);

  let proxy;
  try {
    proxy = await startProxy(paths, {
      httpPort: 0,
      httpsPort: 0,
      logger: () => {}
    });
  } catch (error) {
    await new Promise((resolve) => upstream.close(resolve));
    if (error.code === "EPERM") {
      t.skip("Port binding is restricted in this environment");
      return;
    }
    throw error;
  }

  const response = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: proxy.httpsPort,
        method: "GET",
        path: "/",
        rejectUnauthorized: false,
        headers: {
          host: CA_HELP_HOST
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk);
        });
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: raw }));
      }
    );
    req.once("error", reject);
    req.end();
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/html/);
  assert.match(response.body, /Trust the lanx root certificate/);
  assert.match(response.body, /Download lanx root CA/);

  await proxy.stop();
  await new Promise((resolve) => upstream.close(resolve));
});

test("proxy does not serve CA helper routes on app domains", async (t) => {
  withHome();
  const paths = getPaths();
  ensureLeafCertificate("app.local", paths);
  ensureLeafCertificate(CA_HELP_HOST, paths);

  const upstream = http.createServer((req, res) => {
    if (req.url === "/.lanx/ca") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("upstream route");
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });

  let upstreamPort;
  try {
    upstreamPort = await listenHttpServer(upstream);
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Port binding is restricted in this environment");
      return;
    }
    throw error;
  }

  const state = loadState(paths);
  state.domains["app.local"] = {
    domain: "app.local",
    mode: "proxy",
    target: `http://127.0.0.1:${upstreamPort}`,
    protocol: "https",
    port: 443,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    certificate: null
  };
  saveState(state, paths);

  let proxy;
  try {
    proxy = await startProxy(paths, {
      httpPort: 0,
      httpsPort: 0,
      logger: () => {}
    });
  } catch (error) {
    await new Promise((resolve) => upstream.close(resolve));
    if (error.code === "EPERM") {
      t.skip("Port binding is restricted in this environment");
      return;
    }
    throw error;
  }

  const response = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: proxy.httpsPort,
        method: "GET",
        path: "/.lanx/ca",
        rejectUnauthorized: false,
        headers: {
          host: "app.local"
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk);
        });
        res.on("end", () => resolve({ statusCode: res.statusCode, body: raw }));
      }
    );
    req.once("error", reject);
    req.end();
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "upstream route");

  await proxy.stop();
  await new Promise((resolve) => upstream.close(resolve));
});

test("proxy keeps the legacy CA helper path working on the internal host", async (t) => {
  withHome();
  const paths = getPaths();
  ensureLeafCertificate(CA_HELP_HOST, paths);

  let proxy;
  try {
    proxy = await startProxy(paths, {
      httpPort: 0,
      httpsPort: 0,
      logger: () => {}
    });
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Port binding is restricted in this environment");
      return;
    }
    throw error;
  }

  const response = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: proxy.httpsPort,
        method: "GET",
        path: "/.lanx/ca",
        rejectUnauthorized: false,
        headers: {
          host: CA_HELP_HOST
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += String(chunk);
        });
        res.on("end", () => resolve({ statusCode: res.statusCode, body: raw }));
      }
    );
    req.once("error", reject);
    req.end();
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Trust the lanx root certificate/);

  await proxy.stop();
});

test("proxy serves CA certificate download from internal route", async (t) => {
  withHome();
  const paths = getPaths();
  ensureLeafCertificate(CA_HELP_HOST, paths);

  let proxy;
  try {
    proxy = await startProxy(paths, {
      httpPort: 0,
      httpsPort: 0,
      logger: () => {}
    });
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Port binding is restricted in this environment");
      return;
    }
    throw error;
  }

  const response = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: proxy.httpsPort,
        method: "GET",
        path: "/.lanx/ca/lanx-root-ca.pem",
        rejectUnauthorized: false,
        headers: {
          host: CA_HELP_HOST
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    req.once("error", reject);
    req.end();
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /application\/x-pem-file/);
  assert.match(response.headers["content-disposition"], /lanx-root-ca\.pem/);
  assert.match(response.body, /BEGIN CERTIFICATE/);

  await proxy.stop();
});

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
const { startProxy, sanitizeHeaders, buildUpstreamPath } = require("../lib/proxy");

function withHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanx-proxy-"));
  process.env.LANX_HOME = home;
  return home;
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
    port: 8443,
    published: true,
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

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const { URL } = require("node:url");
const { loadState, getDomainPaths } = require("./state");
const { getPaths } = require("./paths");

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;
const FALLBACK_HTTP_PORT = 8088;
const FALLBACK_HTTPS_PORT = 8443;
const DEFAULT_HOST = "0.0.0.0";
const REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 2_000;
const CA_HELP_HOST = "lanx.local";
const CA_HELP_ROOT_PATH = "/";
const CA_HELP_PATH = "/.lanx/ca";
const CA_DOWNLOAD_PATH = "/.lanx/ca/lanx-root-ca.pem";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function defaultLogger(level, event, fields = {}) {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields
  };
  const line = JSON.stringify(record);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function normalizeHost(hostHeader = "") {
  return hostHeader.split(":")[0].toLowerCase();
}

function isProxyDomain(entry) {
  return Boolean(entry && entry.mode === "proxy" && entry.target);
}

function getProxyDomain(host, state) {
  const matches = Object.values(state.domains).filter((entry) => entry.domain === host && isProxyDomain(entry));
  if (matches.length === 0) {
    return null;
  }
  const preferred = matches.find((entry) => entry.protocol === "https");
  return preferred || matches[0];
}

function getDomain(host, state) {
  const matches = Object.values(state.domains).filter((entry) => entry.domain === host);
  if (matches.length === 0) {
    return null;
  }
  const preferred = matches.find((entry) => entry.protocol === "https");
  return preferred || matches[0];
}

function sanitizeHeaders(headers) {
  const next = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      next[key] = value;
    }
  }
  return next;
}

function buildUpstreamPath(upstream, incomingUrl) {
  const prefix = upstream.pathname.endsWith("/") ? upstream.pathname.slice(0, -1) : upstream.pathname;
  return `${prefix}${incomingUrl || "/"}`;
}

function isInternalCaRequest(url = "/") {
  return url === CA_HELP_ROOT_PATH || url === CA_HELP_PATH || url === CA_DOWNLOAD_PATH;
}

function renderCaInstructions(host) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>lanx CA Install</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; margin: 0; color: #111; background: #f6f6f2; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 20px 48px; }
    h1, h2 { line-height: 1.1; }
    a.button { display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 16px; border-radius: 10px; margin: 12px 0 24px; }
    code { background: #ecece4; padding: 2px 6px; border-radius: 6px; }
    ol, ul { padding-left: 20px; }
  </style>
</head>
<body>
  <main>
    <h1>Trust the lanx root certificate</h1>
    <p>Use this page on your phone to install the lanx development CA so HTTPS works for <code>${host}</code> and other lanx domains.</p>
    <p><a class="button" href="${CA_DOWNLOAD_PATH}">Download lanx root CA</a></p>
    <h2>iPhone and iPad</h2>
    <ol>
      <li>Download the certificate above and open it.</li>
      <li>Install the profile when iOS prompts you.</li>
      <li>Open <code>Settings &gt; General &gt; About &gt; Certificate Trust Settings</code>.</li>
      <li>Enable full trust for the installed lanx root certificate.</li>
    </ol>
    <h2>Android</h2>
    <ol>
      <li>Download the certificate above.</li>
      <li>Open <code>Settings &gt; Security</code> and install the certificate.</li>
      <li>Use the browser for testing. Some apps do not trust user-installed CAs.</li>
    </ol>
    <h2>Notes</h2>
    <ul>
      <li>If the browser still blocks the page, make sure this device can resolve <code>.local</code> names on your network.</li>
      <li>Restart the browser after trusting the certificate if it still shows an old TLS error.</li>
    </ul>
  </main>
</body>
</html>
`;
}

function serveInternalCaRequest(req, res, paths) {
  if (req.url === CA_DOWNLOAD_PATH) {
    const body = fs.readFileSync(paths.caCert);
    res.writeHead(200, {
      "content-type": "application/x-pem-file",
      "content-disposition": 'attachment; filename="lanx-root-ca.pem"',
      "content-length": Buffer.byteLength(body)
    });
    res.end(body);
    return true;
  }

  if (req.url === CA_HELP_PATH) {
    const host = normalizeHost(req.headers.host) || "this lanx domain";
    const body = renderCaInstructions(host);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
    return true;
  }

  if (req.url === CA_HELP_ROOT_PATH) {
    const host = normalizeHost(req.headers.host) || "this lanx domain";
    const body = renderCaInstructions(host);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
    return true;
  }

  return false;
}

function isInternalCaHost(host) {
  return host === CA_HELP_HOST;
}

function proxyRequest(req, res, targetUrl, { logger, domain }) {
  const started = Date.now();
  const upstream = new URL(targetUrl);
  const client = upstream.protocol === "https:" ? https : http;
  const headers = sanitizeHeaders({
    ...req.headers,
    host: upstream.host,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": "https",
    "x-forwarded-for": req.socket.remoteAddress || ""
  });

  const upstreamReq = client.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
      path: buildUpstreamPath(upstream, req.url),
      method: req.method,
      headers
    },
    (upstreamRes) => {
      const responseHeaders = sanitizeHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on("end", () => {
        logger("info", "proxy.request", {
          domain,
          method: req.method,
          path: req.url,
          status: upstreamRes.statusCode || 0,
          duration_ms: Date.now() - started
        });
      });
    }
  );

  upstreamReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
    upstreamReq.destroy(new Error("Upstream request timeout"));
  });

  upstreamReq.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`Proxy error: ${error.message}\n`);
    logger("error", "proxy.request.error", {
      domain,
      method: req.method,
      path: req.url,
      error: error.message,
      duration_ms: Date.now() - started
    });
  });

  req.pipe(upstreamReq);
}

function tunnelSockets(clientSocket, upstreamSocket, head) {
  if (head && head.length > 0) {
    upstreamSocket.write(head);
  }
  clientSocket.pipe(upstreamSocket);
  upstreamSocket.pipe(clientSocket);
}

function proxyWebSocket(req, clientSocket, head, targetUrl, { logger, domain }) {
  const started = Date.now();
  const upstream = new URL(targetUrl);
  const isTlsUpstream = upstream.protocol === "https:";
  const port = upstream.port || (isTlsUpstream ? 443 : 80);
  const transport = isTlsUpstream ? tls : net;
  const upstreamSocket = transport.connect(
    isTlsUpstream
      ? { host: upstream.hostname, port: Number(port), servername: upstream.hostname }
      : { host: upstream.hostname, port: Number(port) }
  );

  const headers = sanitizeHeaders({
    ...req.headers,
    host: upstream.host,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": "https",
    "x-forwarded-for": req.socket.remoteAddress || ""
  });
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  const headerLines = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\r\n");
  const requestLine = `${req.method} ${buildUpstreamPath(upstream, req.url)} HTTP/1.1`;

  upstreamSocket.setTimeout(REQUEST_TIMEOUT_MS, () => {
    upstreamSocket.destroy(new Error("WebSocket upstream timeout"));
  });
  clientSocket.setTimeout(REQUEST_TIMEOUT_MS, () => {
    clientSocket.destroy(new Error("WebSocket client timeout"));
  });

  upstreamSocket.once("connect", () => {
    upstreamSocket.write(`${requestLine}\r\n${headerLines}\r\n\r\n`);
    tunnelSockets(clientSocket, upstreamSocket, head);
    logger("info", "proxy.websocket", {
      domain,
      path: req.url,
      duration_ms: Date.now() - started
    });
  });

  const onError = (error) => {
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      clientSocket.destroy();
    }
    if (!upstreamSocket.destroyed) {
      upstreamSocket.destroy();
    }
    logger("error", "proxy.websocket.error", {
      domain,
      path: req.url,
      error: error.message,
      duration_ms: Date.now() - started
    });
  };

  upstreamSocket.once("error", onError);
  clientSocket.once("error", onError);
}

function trackSocket(server, socketSet) {
  server.on("connection", (socket) => {
    socketSet.add(socket);
    socket.on("close", () => socketSet.delete(socket));
  });
}

function createProxyServers(paths = getPaths(), options = {}) {
  const logger = options.logger || defaultLogger;
  const secureContextCache = new Map();
  const sockets = new Set();

  const httpsServer = https.createServer(
    {
      key: fs.readFileSync(paths.caKey),
      cert: fs.readFileSync(paths.caCert),
      SNICallback(servername, callback) {
        try {
          const domainPaths = getDomainPaths(servername, paths);
          if (!fs.existsSync(domainPaths.key) || !fs.existsSync(domainPaths.cert)) {
            callback(null, null);
            return;
          }
          if (!secureContextCache.has(servername)) {
            secureContextCache.set(
              servername,
              tls.createSecureContext({
                key: fs.readFileSync(domainPaths.key),
                cert: fs.readFileSync(domainPaths.cert)
              })
            );
          }
          callback(null, secureContextCache.get(servername));
        } catch (error) {
          callback(error);
        }
      }
    },
    (req, res) => {
      const host = normalizeHost(req.headers.host);
      const state = loadState(paths);
      if (isInternalCaHost(host) && isInternalCaRequest(req.url) && serveInternalCaRequest(req, res, paths)) {
        logger("info", "proxy.request.internal", { domain: host, method: req.method, path: req.url });
        return;
      }
      const domain = getDomain(host, state);
      const entry = getProxyDomain(host, state);
      if (!entry) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("No proxy domain matches this host.\n");
        logger("info", "proxy.request.miss", { domain: host, method: req.method, path: req.url });
        return;
      }
      proxyRequest(req, res, entry.target, { logger, domain: host });
    }
  );

  const httpServer = http.createServer((req, res) => {
    const host = normalizeHost(req.headers.host);
    if (isInternalCaHost(host)) {
      const httpsPort = options.httpsPort ?? DEFAULT_HTTPS_PORT;
      const location = httpsPort === 443 ? `https://${host}${req.url}` : `https://${host}:${httpsPort}${req.url}`;
      res.writeHead(308, { location });
      res.end();
      return;
    }
    const entry = getProxyDomain(host, loadState(paths));
    if (!entry) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("No proxy domain matches this host.\n");
      logger("info", "proxy.request.miss", { domain: host, method: req.method, path: req.url });
      return;
    }

    const httpsPort = options.httpsPort ?? DEFAULT_HTTPS_PORT;
    const location = httpsPort === 443 ? `https://${host}${req.url}` : `https://${host}:${httpsPort}${req.url}`;
    res.writeHead(308, { location });
    res.end();
  });

  httpsServer.on("upgrade", (req, socket, head) => {
    const host = normalizeHost(req.headers.host);
    const entry = getProxyDomain(host, loadState(paths));
    if (!entry) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      logger("info", "proxy.websocket.miss", { domain: host, path: req.url });
      return;
    }
    proxyWebSocket(req, socket, head, entry.target, { logger, domain: host });
  });

  httpsServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpsServer.headersTimeout = REQUEST_TIMEOUT_MS + 5_000;
  httpsServer.keepAliveTimeout = 5_000;
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = REQUEST_TIMEOUT_MS + 5_000;
  httpServer.keepAliveTimeout = 5_000;

  trackSocket(httpServer, sockets);
  trackSocket(httpsServer, sockets);

  async function stop() {
    await Promise.all([
      new Promise((resolve) => httpServer.close(() => resolve())),
      new Promise((resolve) => httpsServer.close(() => resolve()))
    ]);
    const timer = setTimeout(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
  }

  return { httpServer, httpsServer, stop };
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : port;
}

function isPermissionError(error) {
  return Boolean(error && (error.code === "EACCES" || error.code === "EPERM"));
}

async function startProxy(paths = getPaths(), options = {}) {
  const host = options.host || DEFAULT_HOST;
  const requestedHttpPort = options.httpPort ?? DEFAULT_HTTP_PORT;
  const requestedHttpsPort = options.httpsPort ?? DEFAULT_HTTPS_PORT;
  const logger = options.logger || defaultLogger;
  const warnings = [];
  const listenFn = options.listenFn || listen;

  async function bindPorts(httpPortToUse, httpsPortToUse) {
    const { httpServer, httpsServer, stop } = createProxyServers(paths, {
      logger,
      httpsPort: httpsPortToUse,
    });

    try {
      const httpPort = await listenFn(httpServer, httpPortToUse, host);
      try {
        const httpsPort = await listenFn(httpsServer, httpsPortToUse, host);
        return { httpPort, httpsPort, stop };
      } catch (error) {
        await stop();
        throw error;
      }
    } catch (error) {
      await stop();
      throw error;
    }
  }

  let binding;
  try {
    binding = await bindPorts(requestedHttpPort, requestedHttpsPort);
  } catch (error) {
    const usingDefaultPrivilegedPorts =
      requestedHttpPort === DEFAULT_HTTP_PORT &&
      requestedHttpsPort === DEFAULT_HTTPS_PORT;
    if (!usingDefaultPrivilegedPorts || !isPermissionError(error)) {
      throw error;
    }

    warnings.push(
      `Falling back to unprivileged ports ${FALLBACK_HTTP_PORT}/${FALLBACK_HTTPS_PORT} because binding to ${DEFAULT_HTTP_PORT}/${DEFAULT_HTTPS_PORT} requires elevated privileges.`,
    );
    binding = await bindPorts(FALLBACK_HTTP_PORT, FALLBACK_HTTPS_PORT);
  }

  const { httpPort, httpsPort, stop } = binding;
  logger("info", "proxy.started", { host, httpPort, httpsPort });

  return { host, httpPort, httpsPort, stop, warnings };
}

module.exports = {
  CA_HELP_HOST,
  isProxyDomain,
  isPermissionError,
  startProxy,
  sanitizeHeaders,
  buildUpstreamPath
};

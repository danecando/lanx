const fs = require("node:fs");
const path = require("node:path");
const { getPaths } = require("./paths");

const DEFAULT_STATE = {
  version: 1,
  setup: {
    createdAt: null,
    platform: process.platform,
    trusted: false
  },
  domains: {}
};

function normalizeDomainEntry(domain, entry = {}) {
  const mode = entry.mode || "domain-only";
  const protocol = entry.protocol || "https";
  const port = Number.isInteger(entry.port) ? entry.port : null;

  return {
    domain,
    mode,
    target: mode === "proxy" ? entry.target || null : null,
    protocol,
    port,
    enabled: Boolean(entry.enabled),
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
    certificate: entry.certificate || null
  };
}

function ensureDirs(paths = getPaths()) {
  for (const dir of [paths.configDir, paths.stateDir, paths.certsDir, paths.domainsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadState(paths = getPaths()) {
  ensureDirs(paths);
  if (!fs.existsSync(paths.stateFile)) {
    return structuredClone(DEFAULT_STATE);
  }

  const parsed = JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
  return {
    ...structuredClone(DEFAULT_STATE),
    ...parsed,
    setup: {
      ...structuredClone(DEFAULT_STATE.setup),
      ...(parsed.setup || {})
    },
    domains: Object.fromEntries(
      Object.entries(parsed.domains || {}).map(([domain, entry]) => [domain, normalizeDomainEntry(domain, entry)])
    )
  };
}

function saveState(state, paths = getPaths()) {
  ensureDirs(paths);
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function getDomainPaths(domain, paths = getPaths()) {
  const safeName = domain.replace(/[^a-z0-9.-]/gi, "_");
  const base = path.join(paths.domainsDir, safeName);
  return {
    base,
    key: path.join(base, "leaf.key.pem"),
    csr: path.join(base, "leaf.csr.pem"),
    cert: path.join(base, "leaf.cert.pem"),
    ext: path.join(base, "openssl.ext")
  };
}

module.exports = {
  DEFAULT_STATE,
  ensureDirs,
  loadState,
  saveState,
  getDomainPaths,
  normalizeDomainEntry
};

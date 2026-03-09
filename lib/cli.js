const fs = require("node:fs");
const path = require("node:path");
const { ensureRootCa, ensureLeafCertificate } = require("./certs");
const { startRuntime } = require("./runtime");
const { getPaths } = require("./paths");
const {
  loadState,
  saveState,
  ensureDirs,
  normalizeDomainEntry,
} = require("./state");
const {
  applyInstall,
  applyUninstall,
} = require("./system");
const { version } = require("../package.json");

function usage() {
  return `
lanx v${version}

Usage:
  lanx install
  lanx uninstall
  lanx start
  lanx list
  lanx add <name> [--port <n> | --target <url>]
  lanx edit <name> [--target <url> | --port <n>]
  lanx remove <name>

`.trim();
}

function parseFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1];
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("Port must be an integer between 1 and 65535");
  }
  return parsed;
}

function validateDomain(domain) {
  if (!/^[a-z0-9.-]+$/i.test(domain) || !domain.includes(".")) {
    throw new Error(`Invalid domain: ${domain}`);
  }
}

function validateLocalDomain(domain) {
  validateDomain(domain);
  if (!domain.toLowerCase().endsWith(".local")) {
    throw new Error(`Only .local domains are supported: ${domain}`);
  }
}

function normalizeName(name) {
  const normalized = name.toLowerCase();
  const domain = normalized.includes(".") ? normalized : `${normalized}.local`;
  validateLocalDomain(domain);
  return domain;
}

function validateTarget(target) {
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported target protocol: ${url.protocol}`);
  }
}

function assertOnlyFlags(args, allowedFlags = []) {
  const allowed = new Set(allowedFlags);
  for (const token of args) {
    if (token.startsWith("--") && !allowed.has(token)) {
      throw new Error(`Unknown option: ${token}`);
    }
  }
}

function formatDomainRow(domain, entry) {
  const endpoint =
    entry.mode === "proxy"
      ? entry.target || "-"
      : `${entry.protocol || "https"}:${entry.port || "-"}`;
  return [
    domain.padEnd(24),
    String(entry.mode).padEnd(12),
    endpoint,
  ].join(" ");
}

function removeDomainArtifacts(domain, paths) {
  const domainDir = path.join(
    paths.domainsDir,
    domain.replace(/[^a-z0-9.-]/gi, "_"),
  );
  fs.rmSync(domainDir, { recursive: true, force: true });
}

function writeInstallReceipt(paths, state) {
  fs.writeFileSync(
    paths.installReceipt,
    `${JSON.stringify({ installedAt: state.setup.createdAt, trusted: state.setup.trusted }, null, 2)}\n`,
  );
}

async function runCli(argv) {
  const args = [...argv];
  const command = args.shift();
  const paths = getPaths();

  if (!command || command === "--help" || command === "help") {
    console.log(usage());
    return 0;
  }

  if (command === "install") {
    assertOnlyFlags(args, []);
    ensureDirs(paths);
    const state = loadState(paths);
    const root = ensureRootCa(paths);
    state.setup.createdAt = state.setup.createdAt || new Date().toISOString();
    applyInstall(paths);
    state.setup.trusted = true;
    saveState(state, paths);
    writeInstallReceipt(paths, state);

    console.log(
      root.created
        ? `Created root CA at ${paths.caCert}`
        : `Root CA already exists at ${paths.caCert}`,
    );
    console.log("Installed root CA trust into the system store.");
    return 0;
  }

  if (command === "uninstall") {
    assertOnlyFlags(args, []);
    const state = loadState(paths);
    if (state.setup.trusted) {
      applyUninstall();
    }

    fs.rmSync(paths.stateDir, { recursive: true, force: true });
    fs.rmSync(paths.stateFile, { force: true });
    try {
      fs.rmdirSync(paths.configDir);
    } catch {}
    console.log(`Removed ${paths.configDir} and ${paths.stateDir}`);
    return 0;
  }

  if (command === "start") {
    const running = await startRuntime(paths);
    if (running.runtime === "proxy") {
      console.log(
        `Runtime listening on ${running.host}:${running.httpPort} and ${running.host}:${running.httpsPort}`,
      );
      console.log(`Proxy domains: ${running.proxyDomains}`);
      console.log(`Domain-only domains: ${running.domainOnlyDomains}`);
      console.log(`Discovery announcements: ${running.discoveryDomains}`);
      for (const warning of running.warnings) {
        console.log(`Warning: ${warning}`);
      }
      return await running.waitForExit();
    }

    if (running.runtime === "discovery-only") {
      console.log(
        "Runtime started in discovery-only mode (no proxy listeners).",
      );
      console.log(running.message);
      console.log(`Proxy domains: ${running.proxyDomains}`);
      console.log(`Domain-only domains: ${running.domainOnlyDomains}`);
      console.log(`Discovery announcements: ${running.discoveryDomains}`);
      for (const warning of running.warnings) {
        console.log(`Warning: ${warning}`);
      }
      return await running.waitForExit();
    }

    console.log(running.message);
    console.log(`Proxy domains: ${running.proxyDomains}`);
    console.log(`Domain-only domains: ${running.domainOnlyDomains}`);
    console.log(`Discovery announcements: ${running.discoveryDomains}`);
    for (const warning of running.warnings) {
      console.log(`Warning: ${warning}`);
    }
    return 0;
  }

  if (command === "list") {
    const state = loadState(paths);
    console.log("DOMAIN                   MODE         ENDPOINT");
    for (const [domain, entry] of Object.entries(state.domains)) {
      console.log(formatDomainRow(domain, entry));
    }
    return 0;
  }

  if (command === "add") {
    const state = loadState(paths);
    const name = args.shift();
    if (!name) {
      throw new Error(
        "Usage: lanx add <name> [--port <n> | --target <url>]",
      );
    }
    const domain = normalizeName(name);
    if (state.domains[domain]) {
      throw new Error(`Domain already exists: ${domain}`);
    }
    if (args[0] && !args[0].startsWith("--")) {
      throw new Error(
        "Unexpected positional value. Use --target <url> for proxy mode.",
      );
    }
    assertOnlyFlags(args, ["--port", "--target"]);

    const targetFlag = parseFlag(args, "--target");
    const portFlag = parseFlag(args, "--port");
    const hasTarget = targetFlag !== null;
    const hasPort = portFlag !== null;

    if (hasTarget === hasPort) {
      throw new Error("Provide exactly one of --target or --port");
    }

    const mode = hasTarget ? "proxy" : "domain-only";
    const target = hasTarget ? targetFlag : null;
    if (target) {
      validateTarget(target);
    }

    const leaf = ensureLeafCertificate(domain, paths);
    const entry = normalizeDomainEntry(domain, {
      mode,
      target,
      protocol: "https",
      port: mode === "proxy" ? 443 : parsePort(portFlag),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      certificate: { cert: leaf.cert, key: leaf.key },
    });

    state.domains[domain] = entry;
    saveState(state, paths);
    console.log(
      entry.mode === "proxy"
        ? `Added ${domain} as proxy domain -> ${entry.target}`
        : `Added ${domain} as domain-only (${entry.protocol || "https"}:${entry.port || "unset"})`,
    );
    console.log(`Leaf certificate: ${leaf.cert}`);
    console.log("Restart `lanx start` to apply proxy changes.");
    return 0;
  }

  if (command === "edit") {
    const state = loadState(paths);
    const name = args.shift();
    if (!name) {
      throw new Error(
        "Usage: lanx edit <name> [--target <url> | --port <n>]",
      );
    }
    const domain = normalizeName(name);
    assertOnlyFlags(args, ["--target", "--port"]);
    const entry = state.domains[domain];
    if (!entry) {
      throw new Error(`Unknown domain: ${domain}`);
    }

    const nextTarget = parseFlag(args, "--target");
    const nextPort = parseFlag(args, "--port");
    if (nextTarget !== null && nextPort !== null) {
      throw new Error("Provide only one of --target or --port");
    }
    if (nextTarget === null && nextPort === null) {
      throw new Error("Provide --target or --port");
    }

    if (nextTarget !== null) {
      validateTarget(nextTarget);
      entry.mode = "proxy";
      entry.target = nextTarget;
      entry.port = 443;
    }
    if (nextPort !== null) {
      entry.mode = "domain-only";
      entry.target = null;
      entry.port = parsePort(nextPort);
    }
    if (entry.mode === "proxy" && !entry.target) {
      throw new Error("Proxy mode requires a target URL.");
    }
    entry.updatedAt = new Date().toISOString();
    saveState(state, paths);
    console.log(`Updated ${domain}`);
    console.log("Restart `lanx start` to apply proxy changes.");
    return 0;
  }

  if (command === "remove") {
    const state = loadState(paths);
    const name = args.shift();
    if (!name) {
      throw new Error("Usage: lanx remove <name>");
    }
    const domain = normalizeName(name);
    if (!state.domains[domain]) {
      throw new Error(`Unknown domain: ${domain}`);
    }
    delete state.domains[domain];
    removeDomainArtifacts(domain, paths);
    saveState(state, paths);
    console.log(`Removed ${domain}`);
    console.log("Restart `lanx start` to apply proxy changes.");
    return 0;
  }

  throw new Error(`Unknown command: ${command}`);
}

module.exports = {
  runCli,
};

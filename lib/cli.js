const fs = require("node:fs");
const path = require("node:path");
const { ensureRootCa, ensureLeafCertificate } = require("./certs");
const { startRuntime } = require("./runtime");
const { getPaths } = require("./paths");
const { loadState, saveState, ensureDirs, normalizeDomainEntry } = require("./state");
const {
  applyInstall,
  applyPublishedHosts,
  applyUninstall,
  getInstallActions,
  getPublishActions,
  getUninstallActions
} = require("./system");

function usage() {
  return `
lanx

Usage:
  lanx install [--apply]
  lanx uninstall [--apply]
  lanx start
  lanx list
  lanx add <domain> [target] [--mode <proxy|domain-only>] [--type <http|https>] [--port <n>] [--published <true|false>] [--apply]
  lanx edit <domain> [--mode <proxy|domain-only>] [--target <url>] [--type <http|https>] [--port <n>] [--published <true|false>] [--apply]
  lanx remove <domain>

Environment:
  LANX_HOME   Override config and state directories with a single root
`.trim();
}

function parseFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1];
}

function parseBoolean(value, name) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("Port must be an integer between 1 and 65535");
  }
  return parsed;
}

function normalizeMode(value) {
  if (!value) {
    return null;
  }
  if (value === "proxy" || value === "domain-only") {
    return value;
  }
  throw new Error("Mode must be proxy or domain-only");
}

function normalizeType(value) {
  if (!value) {
    return null;
  }
  if (value === "http" || value === "https") {
    return value;
  }
  throw new Error("Type must be http or https");
}

function hasFlag(args, name) {
  return args.includes(name);
}

function validateDomain(domain) {
  if (!/^[a-z0-9.-]+$/i.test(domain) || !domain.includes(".")) {
    throw new Error(`Invalid domain: ${domain}`);
  }
}

function validateTarget(target) {
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported target protocol: ${url.protocol}`);
  }
}

function printActions(title, actions) {
  console.log(title);
  for (const action of actions) {
    console.log(`- ${action}`);
  }
}

function formatDomainRow(domain, entry) {
  const endpoint = entry.mode === "proxy" ? entry.target || "-" : `${entry.protocol || "http"}:${entry.port || "-"}`;
  return [
    domain.padEnd(24),
    String(entry.mode).padEnd(12),
    String(entry.published).padEnd(10),
    endpoint
  ].join(" ");
}

function removeDomainArtifacts(domain, paths) {
  const domainDir = path.join(paths.domainsDir, domain.replace(/[^a-z0-9.-]/gi, "_"));
  fs.rmSync(domainDir, { recursive: true, force: true });
}

function writeInstallReceipt(paths, state) {
  fs.writeFileSync(
    paths.installReceipt,
    `${JSON.stringify({ installedAt: state.setup.createdAt, trusted: state.setup.trusted }, null, 2)}\n`
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
    ensureDirs(paths);
    const state = loadState(paths);
    const root = ensureRootCa(paths);
    state.setup.createdAt = state.setup.createdAt || new Date().toISOString();
    if (hasFlag(args, "--apply")) {
      applyInstall(paths);
      state.setup.trusted = true;
    }
    saveState(state, paths);
    writeInstallReceipt(paths, state);

    console.log(root.created ? `Created root CA at ${paths.caCert}` : `Root CA already exists at ${paths.caCert}`);
    if (hasFlag(args, "--apply")) {
      console.log("Installed root CA trust into the system store.");
    } else {
      printActions("Next steps:", getInstallActions(paths));
    }
    return 0;
  }

  if (command === "uninstall") {
    const state = loadState(paths);
    if (hasFlag(args, "--apply")) {
      applyPublishedHosts({ ...state, domains: {} });
      if (state.setup.trusted) {
        applyUninstall();
      }
    } else {
      printActions("Cleanup actions:", getUninstallActions());
    }

    fs.rmSync(paths.stateDir, { recursive: true, force: true });
    if (paths.root) {
      fs.rmSync(paths.configDir, { recursive: true, force: true });
      console.log(`Removed ${paths.configDir}`);
    } else {
      fs.rmSync(paths.stateFile, { force: true });
      try {
        fs.rmdirSync(paths.configDir);
      } catch {}
      console.log(`Removed ${paths.configDir} and ${paths.stateDir}`);
    }
    return 0;
  }

  if (command === "start") {
    const running = await startRuntime(paths);
    if (running.runtime === "proxy") {
      console.log(`Runtime listening on ${running.host}:${running.httpPort} and ${running.host}:${running.httpsPort}`);
      console.log(`Published proxy domains: ${running.proxyDomains}`);
      console.log(`Published domain-only domains: ${running.domainOnlyDomains}`);
      console.log(`Discovery announcements: ${running.discoveryDomains}`);
      for (const warning of running.warnings) {
        console.log(`Warning: ${warning}`);
      }
      return await running.waitForExit();
    }

    if (running.runtime === "discovery-only") {
      console.log("Runtime started in discovery-only mode (no proxy listeners).");
      console.log(running.message);
      console.log(`Published proxy domains: ${running.proxyDomains}`);
      console.log(`Published domain-only domains: ${running.domainOnlyDomains}`);
      console.log(`Discovery announcements: ${running.discoveryDomains}`);
      for (const warning of running.warnings) {
        console.log(`Warning: ${warning}`);
      }
      return await running.waitForExit();
    }

    console.log(running.message);
    console.log(`Published proxy domains: ${running.proxyDomains}`);
    console.log(`Published domain-only domains: ${running.domainOnlyDomains}`);
    console.log(`Discovery announcements: ${running.discoveryDomains}`);
    for (const warning of running.warnings) {
      console.log(`Warning: ${warning}`);
    }
    return 0;
  }

  if (command === "list") {
    const state = loadState(paths);
    console.log("DOMAIN                   MODE         PUBLISHED  ENDPOINT");
    for (const [domain, entry] of Object.entries(state.domains)) {
      console.log(formatDomainRow(domain, entry));
    }
    return 0;
  }

  if (command === "add") {
    const state = loadState(paths);
    const domain = args.shift();
    const positionalValue = args[0] && !args[0].startsWith("--") ? args.shift() : null;
    if (!domain) {
      throw new Error(
        "Usage: lanx add <domain> [target] [--mode <proxy|domain-only>] [--type <http|https>] [--port <n>] [--published <true|false>] [--apply]"
      );
    }
    validateDomain(domain);
    if (state.domains[domain]) {
      throw new Error(`Domain already exists: ${domain}`);
    }

    const mode = normalizeMode(parseFlag(args, "--mode")) || (positionalValue ? "proxy" : "domain-only");
    const target = parseFlag(args, "--target") || positionalValue;
    const type = normalizeType(parseFlag(args, "--type")) || "http";
    const portFlag = parseFlag(args, "--port");
    const publishedFlag = parseFlag(args, "--published");

    if (mode === "proxy" && !target) {
      throw new Error("Proxy mode requires a target URL via positional target or --target");
    }
    if (target) {
      validateTarget(target);
    }

    const leaf = ensureLeafCertificate(domain, paths);
    const entry = normalizeDomainEntry(domain, {
      mode,
      target: mode === "proxy" ? target : null,
      protocol: type,
      port: portFlag ? parsePort(portFlag) : mode === "proxy" ? 8443 : null,
      published: publishedFlag ? parseBoolean(publishedFlag, "--published") : false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      certificate: { cert: leaf.cert, key: leaf.key }
    });

    state.domains[domain] = entry;
    saveState(state, paths);
    console.log(
      entry.mode === "proxy"
        ? `Added ${domain} as proxy domain -> ${entry.target}`
        : `Added ${domain} as domain-only (${entry.protocol}:${entry.port || "unset"})`
    );
    console.log(`Leaf certificate: ${leaf.cert}`);
    if (entry.published) {
      if (hasFlag(args, "--apply")) {
        applyPublishedHosts(state);
        console.log("Updated /etc/hosts with the lanx managed block.");
      } else {
        printActions("System actions:", getPublishActions(entry));
      }
    }
    console.log("Restart `lanx start` to apply proxy changes.");
    return 0;
  }

  if (command === "edit") {
    const state = loadState(paths);
    const domain = args.shift();
    if (!domain) {
      throw new Error(
        "Usage: lanx edit <domain> [--mode <proxy|domain-only>] [--target <url>] [--type <http|https>] [--port <n>] [--published <true|false>] [--apply]"
      );
    }
    const entry = state.domains[domain];
    if (!entry) {
      throw new Error(`Unknown domain: ${domain}`);
    }

    const nextMode = normalizeMode(parseFlag(args, "--mode"));
    const nextTarget = parseFlag(args, "--target");
    const nextType = normalizeType(parseFlag(args, "--type"));
    const nextPort = parseFlag(args, "--port");
    const nextPublished = parseFlag(args, "--published");
    if (!nextMode && !nextTarget && !nextType && nextPort === null && nextPublished === null) {
      throw new Error("Provide --mode, --target, --type, --port, or --published");
    }

    if (nextMode) {
      entry.mode = nextMode;
      if (nextMode === "domain-only") {
        entry.target = null;
      }
    }
    if (nextTarget) {
      validateTarget(nextTarget);
      entry.target = nextTarget;
    }
    if (nextType) {
      entry.protocol = nextType;
    }
    if (nextPort !== null) {
      entry.port = parsePort(nextPort);
    }
    if (nextPublished !== null) {
      entry.published = parseBoolean(nextPublished, "--published");
    }
    if (entry.mode === "proxy" && !entry.target) {
      throw new Error("Proxy mode requires a target URL.");
    }
    entry.updatedAt = new Date().toISOString();
    saveState(state, paths);
    console.log(`Updated ${domain}`);
    if (nextPublished !== null) {
      if (hasFlag(args, "--apply")) {
        applyPublishedHosts(state);
        console.log("Updated /etc/hosts with the lanx managed block.");
      } else {
        printActions("System actions:", getPublishActions(entry));
      }
    }
    console.log("Restart `lanx start` to apply proxy changes.");
    return 0;
  }

  if (command === "remove") {
    const state = loadState(paths);
    const domain = args.shift();
    if (!domain) {
      throw new Error("Usage: lanx remove <domain>");
    }
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
  runCli
};

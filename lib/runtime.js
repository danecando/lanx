const { loadState } = require("./state");
const { getPaths } = require("./paths");
const { ensureLeafCertificate } = require("./certs");
const { CA_HELP_HOST, isProxyDomain, startProxy } = require("./proxy");
const { startDiscovery } = require("./discovery");

function waitForShutdown(stop) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) {
        return;
      }
      done = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await stop();
      resolve();
    };

    const onSignal = () => {
      void finish();
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

async function startRuntime(paths = getPaths()) {
  const state = loadState(paths);
  const domains = Object.values(state.domains);
  const proxyDomains = domains.filter(isProxyDomain);
  const domainOnlyDomains = domains.filter((entry) => entry.mode === "domain-only");
  if (domains.length > 0) {
    ensureLeafCertificate(CA_HELP_HOST, paths);
  }
  const discovery = startDiscovery(domains);

  let proxy = null;
  if (domains.length > 0) {
    proxy = await startProxy(paths);
  }

  const hasActiveRuntime = domains.length > 0 || discovery.activeRecords.length > 0;

  const stop = async () => {
    discovery.stop();
    if (proxy) {
      await proxy.stop();
    }
  };

  const warnings = [...discovery.warnings, ...(proxy ? proxy.warnings || [] : [])];

  if (!hasActiveRuntime) {
    return {
      runtime: "idle",
      message: "No domains with valid discovery or proxy settings.",
      proxyDomains: 0,
      domainOnlyDomains: domainOnlyDomains.length,
      discoveryDomains: discovery.activeRecords.length,
      warnings,
      waitForExit: async () => {}
    };
  }

  return {
    runtime: proxy ? "proxy" : "discovery-only",
    message: proxy
      ? "Runtime started with proxy listeners and discovery announcements."
      : "Runtime started with discovery announcements only (no proxy listeners).",
    host: proxy ? proxy.host : null,
    httpPort: proxy ? proxy.httpPort : null,
    httpsPort: proxy ? proxy.httpsPort : null,
    proxyDomains: proxyDomains.length,
    domainOnlyDomains: domainOnlyDomains.length,
    discoveryDomains: discovery.activeRecords.length,
    warnings,
    waitForExit: () => waitForShutdown(stop)
  };
}

module.exports = {
  startRuntime
};

const { loadState } = require("./state");
const { getPaths } = require("./paths");
const { isProxyDomain, startProxy } = require("./proxy");
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
  const domainOnlyDomains = domains.filter((entry) => entry.published && entry.mode === "domain-only");
  const publishedDomains = domains.filter((entry) => entry.published);
  const discovery = startDiscovery(publishedDomains);

  let proxy = null;
  if (proxyDomains.length > 0) {
    proxy = await startProxy(paths);
  }

  const hasActiveRuntime = proxyDomains.length > 0 || discovery.activeRecords.length > 0;

  const stop = async () => {
    discovery.stop();
    if (proxy) {
      await proxy.stop();
    }
  };

  if (!hasActiveRuntime) {
    return {
      runtime: "idle",
      message: "No published domains with valid discovery/proxy settings.",
      proxyDomains: 0,
      domainOnlyDomains: domainOnlyDomains.length,
      discoveryDomains: discovery.activeRecords.length,
      warnings: discovery.warnings,
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
    warnings: discovery.warnings,
    waitForExit: () => waitForShutdown(stop)
  };
}

module.exports = {
  startRuntime
};

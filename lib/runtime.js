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
  ensureLeafCertificate(CA_HELP_HOST, paths);
  const discovery = startDiscovery(domains);
  const proxy = await startProxy(paths);

  const stop = async () => {
    discovery.stop();
    await proxy.stop();
  };

  const warnings = [...discovery.warnings, ...(proxy.warnings || [])];

  return {
    runtime: "active",
    message: "Runtime started with proxy listeners and discovery announcements.",
    host: proxy.host,
    httpPort: proxy.httpPort,
    httpsPort: proxy.httpsPort,
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

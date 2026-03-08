const { spawn } = require("node:child_process");

function getServiceType(entry) {
  const protocol = entry.mode === "proxy" ? "https" : entry.protocol || "http";
  return protocol === "https" ? "_https._tcp" : "_http._tcp";
}

function getServicePort(entry) {
  if (entry.mode === "proxy") {
    return 8443;
  }
  return entry.port;
}

function buildDiscoveryRecords(domains) {
  const records = [];
  const skipped = [];

  for (const entry of domains) {
    if (!entry.published) {
      continue;
    }

    const port = getServicePort(entry);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      skipped.push(`Skipped ${entry.domain}: missing or invalid service port for discovery.`);
      continue;
    }

    records.push({
      domain: entry.domain,
      mode: entry.mode,
      serviceType: getServiceType(entry),
      port
    });
  }

  return { records, skipped };
}

function getDiscoveryCommand(record) {
  if (process.platform === "darwin") {
    return {
      command: "dns-sd",
      args: ["-R", record.domain, record.serviceType, "local", String(record.port)]
    };
  }

  return {
    command: "avahi-publish-service",
    args: [record.domain, record.serviceType, String(record.port)]
  };
}

function startDiscovery(domains) {
  const { records: requestedRecords, skipped } = buildDiscoveryRecords(domains);
  const records = [];
  const children = [];
  const warnings = [...skipped];

  for (const record of requestedRecords) {
    const { command, args } = getDiscoveryCommand(record);
    const child = spawn(command, args, { stdio: "ignore" });

    if (!child.pid) {
      warnings.push(`Failed to start discovery for ${record.domain}: command not available (${command})`);
      continue;
    }

    records.push(record);
    children.push(child);
    child.once("error", (error) => {
      warnings.push(`Failed to start discovery for ${record.domain}: ${error.message}`);
    });
  }

  function stop() {
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }
  }

  return {
    activeRecords: records,
    warnings,
    stop
  };
}

module.exports = {
  buildDiscoveryRecords,
  startDiscovery
};

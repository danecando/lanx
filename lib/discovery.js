const os = require("node:os");
const { spawn } = require("node:child_process");

function getServiceType(entry) {
  return "_https._tcp";
}

function getServicePort(entry) {
  if (entry.mode === "proxy") {
    return 443;
  }
  return entry.port;
}

function getServiceInstanceName(record) {
  return record.domain.replace(/\.local$/i, "");
}

function getLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.internal) {
        continue;
      }
      if (address.family === "IPv4" || address.family === 4) {
        return address.address;
      }
    }
  }
  return null;
}

function buildDiscoveryRecords(domains) {
  const records = [];
  const skipped = [];

  for (const entry of domains) {
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

function getDiscoveryCommands(record, address) {
  const instanceName = getServiceInstanceName(record);
  if (process.platform === "darwin") {
    return [
      {
        command: "dns-sd",
        args: ["-P", instanceName, record.serviceType, "local", String(record.port), record.domain, address]
      }
    ];
  }

  return [
    {
      command: "avahi-publish-address",
      args: [record.domain, address]
    },
    {
      command: "avahi-publish-service",
      args: ["-H", record.domain, instanceName, record.serviceType, String(record.port)]
    }
  ];
}

function startDiscovery(domains) {
  const { records: requestedRecords, skipped } = buildDiscoveryRecords(domains);
  const records = [];
  const children = [];
  const warnings = [...skipped];
  const address = getLanAddress();

  if (!address) {
    warnings.push("Failed to start discovery: no non-loopback IPv4 address found.");
    return {
      activeRecords: records,
      warnings,
      stop() {}
    };
  }

  for (const record of requestedRecords) {
    const commands = getDiscoveryCommands(record, address);
    let started = true;
    const recordChildren = [];

    for (const { command, args } of commands) {
      const child = spawn(command, args, { stdio: "ignore" });
      if (!child.pid) {
        warnings.push(`Failed to start discovery for ${record.domain}: command not available (${command})`);
        started = false;
        break;
      }
      recordChildren.push(child);
      child.once("error", (error) => {
        warnings.push(`Failed to start discovery for ${record.domain}: ${error.message}`);
      });
    }

    if (!started) {
      for (const child of recordChildren) {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      }
      continue;
    }

    records.push(record);
    children.push(...recordChildren);
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
  getLanAddress,
  startDiscovery
};

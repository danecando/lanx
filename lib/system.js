const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const HOSTS_FILE = "/etc/hosts";
const TRUSTED_CA_PATH = "/usr/local/share/ca-certificates/lanx-root-ca.crt";
const HOSTS_BEGIN = "# >>> lanx managed >>>";
const HOSTS_END = "# <<< lanx managed <<<";

function sudoRun(command, args) {
  execFileSync("sudo", [command, ...args], { stdio: "inherit" });
}

function getEnableActions(entry) {
  const domain = entry.domain;
  const mode = entry.mode || "proxy";
  const actions = [`Add to /etc/hosts: 127.0.0.1 ${domain}`];
  if (mode === "proxy") {
    actions.push(`Proxy endpoint: https://${domain}:8443`);
  } else {
    const protocol = entry.protocol || "https";
    const port = entry.port || "<port>";
    actions.push(`Domain-only endpoint: ${protocol}://${domain}:${port}`);
  }
  const svc = "_https._tcp";
  const port = entry.port || (mode === "proxy" ? 443 : "<port>");
  if (process.platform === "darwin") {
    actions.push(`Optional mDNS advertisement: dns-sd -P ${domain} ${svc} local ${port} 127.0.0.1 ${domain}`);
  } else {
    actions.push(`Optional mDNS advertisement: avahi-publish-service ${domain} ${svc} ${port}`);
  }
  return actions;
}

function applyInstall(paths) {
  if (process.platform === "darwin") {
    sudoRun("security", ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", paths.caCert]);
    return;
  }

  sudoRun("cp", [paths.caCert, TRUSTED_CA_PATH]);
  sudoRun("update-ca-certificates", []);
}

function applyUninstall() {
  if (process.platform === "darwin") {
    try {
      sudoRun("security", ["delete-certificate", "-c", "lanx Local Root CA", "/Library/Keychains/System.keychain"]);
    } catch (error) {
      if (error.status !== 44) {
        throw error;
      }
    }
  } else {
    sudoRun("rm", ["-f", TRUSTED_CA_PATH]);
    sudoRun("update-ca-certificates", []);
  }
}

function renderHostsBlock(state) {
  const enabledDomains = [...new Set(
    Object.values(state.domains)
      .filter((entry) => entry.enabled)
      .map((entry) => `127.0.0.1 ${entry.domain}`)
  )];

  if (enabledDomains.length === 0) {
    return "";
  }

  return [HOSTS_BEGIN, ...enabledDomains, HOSTS_END].join("\n");
}

function removeManagedHostsBlock(content) {
  const pattern = new RegExp(`\\n?${HOSTS_BEGIN}[\\s\\S]*?${HOSTS_END}\\n?`, "g");
  return content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
}

function applyEnabledHosts(state) {
  const current = fs.readFileSync(HOSTS_FILE, "utf8");
  const cleaned = removeManagedHostsBlock(current).replace(/\s+$/, "");
  const block = renderHostsBlock(state);
  const next = block ? `${cleaned}\n\n${block}\n` : `${cleaned}\n`;
  const tempFile = `${state.setup.platform === "darwin" ? "/tmp" : "/tmp"}/lanx-hosts-${process.pid}`;
  fs.writeFileSync(tempFile, next);
  try {
    sudoRun("cp", [tempFile, HOSTS_FILE]);
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

module.exports = {
  applyInstall,
  applyEnabledHosts,
  applyUninstall,
  getEnableActions,
  removeManagedHostsBlock,
  renderHostsBlock
};

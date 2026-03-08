const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const HOSTS_FILE = "/etc/hosts";
const TRUSTED_CA_PATH = "/usr/local/share/ca-certificates/lanx-root-ca.crt";
const HOSTS_BEGIN = "# >>> lanx managed >>>";
const HOSTS_END = "# <<< lanx managed <<<";

function sudoRun(command, args) {
  execFileSync("sudo", [command, ...args], { stdio: "inherit" });
}

function getInstallActions(paths) {
  const trustCommand =
    process.platform === "darwin"
      ? `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${paths.caCert}`
      : `sudo cp ${paths.caCert} ${TRUSTED_CA_PATH} && sudo update-ca-certificates`;

  return [`Trust the lanx root CA: ${trustCommand}`];
}

function getUninstallActions() {
  const removeTrustCommand =
    process.platform === "darwin"
      ? 'sudo security delete-certificate -c "lanx Local Root CA" /Library/Keychains/System.keychain'
      : `sudo rm -f ${TRUSTED_CA_PATH} && sudo update-ca-certificates`;

  return [
    `Remove lanx root CA trust: ${removeTrustCommand}`,
    "Remove the lanx managed block from /etc/hosts if it exists."
  ];
}

function getPublishActions(entry) {
  const domain = entry.domain;
  const mode = entry.mode || "proxy";
  const actions = [`Add to /etc/hosts: 127.0.0.1 ${domain}`];
  if (mode === "proxy") {
    actions.push(`Proxy endpoint: https://${domain}:8443`);
  } else {
    const protocol = entry.protocol || "http";
    const port = entry.port || "<port>";
    actions.push(`Domain-only endpoint: ${protocol}://${domain}:${port}`);
  }
  if (process.platform === "darwin") {
    const svc = (entry.protocol || "https") === "https" ? "_https._tcp" : "_http._tcp";
    const port = entry.port || (mode === "proxy" ? 443 : "<port>");
    actions.push(`Optional mDNS advertisement: dns-sd -P ${domain} ${svc} local ${port} 127.0.0.1 ${domain}`);
  } else {
    const svc = (entry.protocol || "https") === "https" ? "_https._tcp" : "_http._tcp";
    const port = entry.port || (mode === "proxy" ? 443 : "<port>");
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
  const publishedDomains = Object.values(state.domains)
    .filter((entry) => entry.published)
    .map((entry) => `127.0.0.1 ${entry.domain}`);

  if (publishedDomains.length === 0) {
    return "";
  }

  return [HOSTS_BEGIN, ...publishedDomains, HOSTS_END].join("\n");
}

function removeManagedHostsBlock(content) {
  const pattern = new RegExp(`\\n?${HOSTS_BEGIN}[\\s\\S]*?${HOSTS_END}\\n?`, "g");
  return content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
}

function updateHostsFile(state) {
  const current = fs.readFileSync(HOSTS_FILE, "utf8");
  const cleaned = removeManagedHostsBlock(current).replace(/\s+$/, "");
  const block = renderHostsBlock(state);
  const next = block ? `${cleaned}\n\n${block}\n` : `${cleaned}\n`;
  fs.writeFileSync(HOSTS_FILE, next);
}

function applyPublishedHosts(state) {
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
  applyPublishedHosts,
  applyUninstall,
  getInstallActions,
  getPublishActions,
  getUninstallActions,
  removeManagedHostsBlock,
  renderHostsBlock,
  updateHostsFile
};

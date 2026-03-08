const os = require("node:os");
const path = require("node:path");

function getConventionalConfigDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "lanx");
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "lanx");
}

function getConventionalStateDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "lanx", "state");
  }

  const xdgStateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdgStateHome, "lanx");
}

function getPaths() {
  const overrideRoot = process.env.LANX_HOME || null;
  const configDir = overrideRoot || getConventionalConfigDir();
  const stateDir = overrideRoot || getConventionalStateDir();

  return {
    root: overrideRoot,
    configDir,
    stateDir,
    stateFile: path.join(configDir, "config.json"),
    domainsDir: path.join(stateDir, "domains"),
    certsDir: path.join(stateDir, "certs"),
    caKey: path.join(stateDir, "certs", "root-ca.key.pem"),
    caCert: path.join(stateDir, "certs", "root-ca.cert.pem"),
    installReceipt: path.join(stateDir, "install.json")
  };
}

module.exports = {
  getPaths
};

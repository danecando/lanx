const os = require("node:os");
const path = require("node:path");

function getConventionalConfigDir() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "lanx");
}

function getConventionalStateDir() {
  const xdgStateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdgStateHome, "lanx");
}

function getPaths() {
  const configDir = getConventionalConfigDir();
  const stateDir = getConventionalStateDir();

  return {
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

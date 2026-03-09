const { execFileSync } = require("node:child_process");

function sudoRun(command, args) {
  execFileSync("sudo", [command, ...args], { stdio: "inherit" });
}

function applyInstall(paths) {
  sudoRun("security", ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", paths.caCert]);
}

function applyUninstall() {
  try {
    sudoRun("security", ["delete-certificate", "-c", "lanx Local Root CA", "/Library/Keychains/System.keychain"]);
  } catch (error) {
    if (error.status !== 44) {
      throw error;
    }
  }
}

module.exports = {
  applyInstall,
  applyUninstall,
};

const { execFileSync } = require("node:child_process");

const TRUSTED_CA_PATH = "/usr/local/share/ca-certificates/lanx-root-ca.crt";

function sudoRun(command, args) {
  execFileSync("sudo", [command, ...args], { stdio: "inherit" });
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

module.exports = {
  applyInstall,
  applyUninstall,
};

const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT_CA_COMMON_NAME = "lanx Local Root CA";
const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function sudoRun(command, args, options = {}) {
  return run("sudo", [command, ...args], {
    stdio: ["inherit", "pipe", "inherit"],
    ...options,
  });
}

function getUserKeychains() {
  const keychains = new Set([
    path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
    path.join(os.homedir(), "Library", "Keychains", "login.keychain"),
  ]);

  try {
    const output = run("security", ["list-keychains", "-d", "user"]);
    for (const line of output.split("\n")) {
      const trimmed = line.trim().replace(/^"|"$/g, "");
      if (trimmed) {
        keychains.add(trimmed);
      }
    }
  } catch {}

  return [...keychains];
}

function getCertificateHashes(keychain, useSudo = false) {
  const executor = useSudo ? sudoRun : run;

  try {
    const output = executor("security", [
      "find-certificate",
      "-a",
      "-Z",
      "-c",
      ROOT_CA_COMMON_NAME,
      keychain,
    ]);
    return [...output.matchAll(/SHA-1 hash: ([0-9A-F]+)/g)].map(
      (match) => match[1],
    );
  } catch (error) {
    if (error.status === 44) {
      return [];
    }
    throw error;
  }
}

function deleteCertificateByHash(keychain, hash, useSudo = false) {
  const executor = useSudo ? sudoRun : run;

  try {
    executor("security", ["delete-certificate", "-Z", hash, keychain]);
  } catch (error) {
    if (error.status !== 44) {
      throw error;
    }
  }
}

function deleteCertificatesFromKeychain(keychain, useSudo = false) {
  const hashes = getCertificateHashes(keychain, useSudo);
  for (const hash of hashes) {
    deleteCertificateByHash(keychain, hash, useSudo);
  }

  if (hashes.length > 0) {
    return hashes.length;
  }

  try {
    const executor = useSudo ? sudoRun : run;
    executor("security", [
      "delete-certificate",
      "-c",
      ROOT_CA_COMMON_NAME,
      keychain,
    ]);
    return 1;
  } catch (error) {
    if (error.status === 44) {
      return 0;
    }
    throw error;
  }
}

function applyInstall(paths) {
  sudoRun(
    "security",
    [
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-k",
      SYSTEM_KEYCHAIN,
      paths.caCert,
    ],
    { stdio: "inherit", encoding: undefined },
  );
}

function applyUninstall() {
  deleteCertificatesFromKeychain(SYSTEM_KEYCHAIN, true);
  for (const keychain of getUserKeychains()) {
    deleteCertificatesFromKeychain(keychain, false);
  }
}

module.exports = {
  applyInstall,
  applyUninstall,
};

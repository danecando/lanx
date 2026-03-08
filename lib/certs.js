const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getPaths } = require("./paths");
const { ensureDirs, getDomainPaths } = require("./state");

function runOpenSsl(args) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Failed to run openssl: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "openssl exited with a non-zero status");
  }
}

function ensureRootCa(paths = getPaths()) {
  ensureDirs(paths);
  if (fs.existsSync(paths.caKey) && fs.existsSync(paths.caCert)) {
    return { created: false, key: paths.caKey, cert: paths.caCert };
  }

  runOpenSsl(["genrsa", "-out", paths.caKey, "2048"]);
  runOpenSsl([
    "req",
    "-x509",
    "-new",
    "-nodes",
    "-key",
    paths.caKey,
    "-sha256",
    "-days",
    "3650",
    "-out",
    paths.caCert,
    "-subj",
    "/CN=lanx Local Root CA"
  ]);

  return { created: true, key: paths.caKey, cert: paths.caCert };
}

function ensureLeafCertificate(domain, paths = getPaths()) {
  const root = ensureRootCa(paths);
  const domainPaths = getDomainPaths(domain, paths);
  fs.mkdirSync(domainPaths.base, { recursive: true });

  if (fs.existsSync(domainPaths.key) && fs.existsSync(domainPaths.cert)) {
    return { created: false, ...domainPaths, root };
  }

  fs.writeFileSync(
    domainPaths.ext,
    [
      "authorityKeyIdentifier=keyid,issuer",
      "basicConstraints=CA:FALSE",
      "keyUsage = digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      `subjectAltName = DNS:${domain}`
    ].join("\n")
  );

  runOpenSsl(["genrsa", "-out", domainPaths.key, "2048"]);
  runOpenSsl([
    "req",
    "-new",
    "-key",
    domainPaths.key,
    "-out",
    domainPaths.csr,
    "-subj",
    `/CN=${domain}`
  ]);
  runOpenSsl([
    "x509",
    "-req",
    "-in",
    domainPaths.csr,
    "-CA",
    paths.caCert,
    "-CAkey",
    paths.caKey,
    "-CAcreateserial",
    "-out",
    domainPaths.cert,
    "-days",
    "825",
    "-sha256",
    "-extfile",
    domainPaths.ext
  ]);

  return { created: true, ...domainPaths, root };
}

module.exports = {
  ensureRootCa,
  ensureLeafCertificate
};

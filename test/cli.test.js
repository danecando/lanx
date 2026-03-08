const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { runCli } = require("../lib/cli");
const { buildDiscoveryRecords } = require("../lib/discovery");

async function capture(fn) {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs.join("\n");
}

function withHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanx-"));
  process.env.LANX_HOME = home;
  return home;
}

test("install creates state and root CA", async () => {
  const home = withHome();
  await capture(() => runCli(["install"]));
  assert.equal(fs.existsSync(path.join(home, "config.json")), true);
  assert.equal(fs.existsSync(path.join(home, "certs", "root-ca.cert.pem")), true);
});

test("domain add, edit published state, and remove update state", async () => {
  const home = withHome();
  await capture(() => runCli(["install"]));
  const addOutput = await capture(() => runCli(["add", "app.local", "http://127.0.0.1:3000", "--mode", "proxy"]));
  assert.match(addOutput, /Restart `lanx start` to apply proxy changes\./);
  await capture(() => runCli(["edit", "app.local", "--published", "true"]));
  const editOutput = await capture(() => runCli(["edit", "app.local", "--target", "http://127.0.0.1:4000", "--mode", "proxy"]));
  assert.match(editOutput, /Restart `lanx start` to apply proxy changes\./);

  const state = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(state.domains["app.local"].published, true);
  assert.equal(state.domains["app.local"].target, "http://127.0.0.1:4000");
  assert.equal(state.domains["app.local"].mode, "proxy");

  const removeOutput = await capture(() => runCli(["remove", "app.local"]));
  assert.match(removeOutput, /Restart `lanx start` to apply proxy changes\./);
  const nextState = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(nextState.domains["app.local"], undefined);
});

test("list shows configured domains", async () => {
  withHome();
  await capture(() => runCli(["install"]));
  await capture(() => runCli(["add", "app.local", "http://127.0.0.1:3000", "--mode", "proxy"]));
  const output = await capture(() => runCli(["list"]));
  assert.match(output, /DOMAIN\s+MODE\s+PUBLISHED\s+ENDPOINT/);
  assert.match(output, /app\.local/);
});

test("domain-only mode stores protocol and port without proxy target", async () => {
  const home = withHome();
  await capture(() => runCli(["install"]));
  await capture(() => runCli(["add", "chat.local", "--mode", "domain-only", "--type", "http", "--port", "3000"]));
  const state = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(state.domains["chat.local"].mode, "domain-only");
  assert.equal(state.domains["chat.local"].target, null);
  assert.equal(state.domains["chat.local"].protocol, "http");
  assert.equal(state.domains["chat.local"].port, 3000);
});

test("uninstall removes the lanx home directory", async () => {
  const home = withHome();
  await capture(() => runCli(["install"]));
  assert.equal(fs.existsSync(home), true);
  await capture(() => runCli(["uninstall"]));
  assert.equal(fs.existsSync(home), false);
});

test("discovery records include published proxy and domain-only entries", () => {
  const { records, skipped } = buildDiscoveryRecords([
    { domain: "app.local", mode: "proxy", published: true, protocol: "https", port: null },
    { domain: "chat.local", mode: "domain-only", published: true, protocol: "http", port: 3000 },
    { domain: "bad.local", mode: "domain-only", published: true, protocol: "http", port: null },
    { domain: "off.local", mode: "proxy", published: false, protocol: "https", port: 8443 }
  ]);

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => [record.domain, record.serviceType, record.port]),
    [
      ["app.local", "_https._tcp", 8443],
      ["chat.local", "_http._tcp", 3000]
    ]
  );
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /bad\.local/);
});

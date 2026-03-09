const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lanx-"));
  const configHome = path.join(root, "config");
  const stateHome = path.join(root, "state");
  fs.mkdirSync(configHome, { recursive: true });
  fs.mkdirSync(stateHome, { recursive: true });
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  return {
    root,
    configHome,
    stateHome,
    configFile: path.join(configHome, "lanx", "config.json"),
    stateDir: path.join(stateHome, "lanx")
  };
}

function withCli(testFn) {
  return async (...args) => {
    const systemPath = require.resolve("../lib/system");
    const cliPath = require.resolve("../lib/cli");
    const system = require(systemPath);
    const originalPlatform = process.platform;
    const original = {
      applyInstall: system.applyInstall,
      applyUninstall: system.applyUninstall
    };

    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true
    });
    system.applyInstall = () => {};
    system.applyUninstall = () => {};
    delete require.cache[cliPath];

    try {
      const { runCli } = require("../lib/cli");
      await testFn(runCli, ...args);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true
      });
      system.applyInstall = original.applyInstall;
      system.applyUninstall = original.applyUninstall;
      delete require.cache[cliPath];
    }
  };
}

test("install creates state and root CA", withCli(async (runCli) => {
  const home = withHome();
  await capture(() => runCli(["install"]));
  assert.equal(fs.existsSync(home.configFile), true);
  assert.equal(fs.existsSync(path.join(home.stateDir, "certs", "root-ca.cert.pem")), true);
}));

test("no args shows usage with version", withCli(async (runCli) => {
  const output = await capture(() => runCli([]));
  assert.match(output, /^lanx v/m);
  assert.match(output, /Usage:/);
  assert.match(output, /lanx install/);
}));

test("unknown command shows usage and returns nonzero", withCli(async (runCli) => {
  let exitCode;
  const output = await capture(async () => {
    exitCode = await runCli(["bogus"]);
  });
  assert.equal(exitCode, 1);
  assert.match(output, /^lanx v/m);
  assert.match(output, /Usage:/);
  assert.match(output, /lanx list/);
}));

test("non-macOS platforms are rejected", async () => {
  const cliPath = require.resolve("../lib/cli");
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true
  });
  delete require.cache[cliPath];

  try {
    const { runCli } = require("../lib/cli");
    await assert.rejects(() => runCli([]), /lanx currently supports macOS only\./);
  } finally {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true
    });
    delete require.cache[cliPath];
  }
});

test("domain add, edit, and remove update state", withCli(async (runCli) => {
  const home = withHome();
  await capture(() => runCli(["install"]));
  const addOutput = await capture(() => runCli(["add", "app", "--target", "http://127.0.0.1:3000"]));
  assert.match(addOutput, /Restart `lanx start` to apply proxy changes\./);
  const editOutput = await capture(() => runCli(["edit", "app", "--target", "http://127.0.0.1:4000"]));
  assert.match(editOutput, /Restart `lanx start` to apply proxy changes\./);

  const state = JSON.parse(fs.readFileSync(home.configFile, "utf8"));
  assert.equal(state.domains["app.local"].target, "http://127.0.0.1:4000");
  assert.equal(state.domains["app.local"].mode, "proxy");

  const removeOutput = await capture(() => runCli(["remove", "app"]));
  assert.match(removeOutput, /Restart `lanx start` to apply proxy changes\./);
  const nextState = JSON.parse(fs.readFileSync(home.configFile, "utf8"));
  assert.equal(nextState.domains["app.local"], undefined);
}));

test("list shows configured domains", withCli(async (runCli) => {
  withHome();
  await capture(() => runCli(["install"]));
  await capture(() => runCli(["add", "app", "--target", "http://127.0.0.1:3000"]));
  const output = await capture(() => runCli(["list"]));
  assert.match(output, /DOMAIN\s+MODE\s+ENDPOINT/);
  assert.match(output, /app\.local/);
}));

test("domain-only mode stores protocol and port without proxy target", withCli(async (runCli) => {
  const home = withHome();
  await capture(() => runCli(["install"]));
  await capture(() => runCli(["add", "chat", "--port", "3000"]));
  const state = JSON.parse(fs.readFileSync(home.configFile, "utf8"));
  assert.equal(state.domains["chat.local"].mode, "domain-only");
  assert.equal(state.domains["chat.local"].target, null);
  assert.equal(state.domains["chat.local"].protocol, "https");
  assert.equal(state.domains["chat.local"].port, 3000);
}));

test("add rejects non-.local domains", withCli(async (runCli) => {
  withHome();
  await capture(() => runCli(["install"]));
  await assert.rejects(
    () => runCli(["add", "app.test", "--port", "3000"]),
    /Only \.local domains are supported: app\.test/
  );
}));

test("add rejects reserved internal domain", withCli(async (runCli) => {
  withHome();
  await capture(() => runCli(["install"]));
  await assert.rejects(
    () => runCli(["add", "lanx", "--port", "3000"]),
    /lanx\.local is reserved for lanx internal routes/
  );
}));

test("add requires exactly one target or port", withCli(async (runCli) => {
  withHome();
  await capture(() => runCli(["install"]));
  await assert.rejects(
    () => runCli(["add", "app"]),
    /Provide exactly one of --target or --port/
  );
}));

test("add rejects both target and port together", withCli(async (runCli) => {
  withHome();
  await capture(() => runCli(["install"]));
  await assert.rejects(
    () => runCli(["add", "app", "--target", "http://127.0.0.1:3000", "--port", "4000"]),
    /Provide exactly one of --target or --port/
  );
}));

test("add rejects unknown options", withCli(async (runCli) => {
  withHome();
  await capture(() => runCli(["install"]));
  await assert.rejects(
    () => runCli(["add", "app", "--bogus", "--port", "4000"]),
    /Unknown option: --bogus/
  );
}));

test("edit rejects unknown options", withCli(async (runCli) => {
  withHome();
  await capture(() => runCli(["install"]));
  await capture(() => runCli(["add", "app", "--target", "http://127.0.0.1:3000"]));
  await assert.rejects(
    () => runCli(["edit", "app", "--bogus"]),
    /Unknown option: --bogus/
  );
}));

test("edit rejects both target and port together", withCli(async (runCli) => {
  withHome();
  await capture(() => runCli(["install"]));
  await capture(() => runCli(["add", "app", "--target", "http://127.0.0.1:3000"]));
  await assert.rejects(
    () => runCli(["edit", "app", "--target", "http://127.0.0.1:4000", "--port", "4000"]),
    /Provide only one of --target or --port/
  );
}));

test("uninstall removes the lanx home directory", withCli(async (runCli) => {
  const home = withHome();
  await capture(() => runCli(["install"]));
  assert.equal(fs.existsSync(home.configFile), true);
  await capture(() => runCli(["uninstall"]));
  assert.equal(fs.existsSync(home.configFile), false);
  assert.equal(fs.existsSync(home.stateDir), false);
}));

test("discovery records include proxy and domain-only entries", () => {
  const { records, skipped } = buildDiscoveryRecords([
    { domain: "app.local", mode: "proxy", protocol: "https", port: null },
    { domain: "chat.local", mode: "domain-only", protocol: "https", port: 3000 },
    { domain: "bad.local", mode: "domain-only", protocol: "https", port: null },
    { domain: "off.local", mode: "proxy", protocol: "https", port: 443 }
  ]);

  assert.equal(records.length, 4);
  assert.deepEqual(
    records.map((record) => [record.domain, record.serviceType, record.port]),
    [
      ["app.local", "_https._tcp", 443],
      ["chat.local", "_https._tcp", 3000],
      ["off.local", "_https._tcp", 443],
      ["lanx.local", "_https._tcp", 443]
    ]
  );
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /bad\.local/);
});

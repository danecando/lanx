#!/usr/bin/env node

const { runCli } = require("../lib/cli");

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = Number.isInteger(code) ? code : 0;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

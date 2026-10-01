#!/usr/bin/env node
// bInference's command line: set up and check agents that run on Binance Agent OS and
// think with bInference. This file only checks the platform with syntax every Node.js
// version reads, so an old one gets a clear message instead of an import error.

var major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write("binference needs Node.js 22 or newer, and this is " + process.versions.node + ". Get it at https://nodejs.org\n");
  process.exitCode = 1;
} else if (process.platform === "win32") {
  process.stderr.write("binference runs on macOS and Linux. On Windows, run it inside WSL2: https://learn.microsoft.com/windows/wsl\n");
  process.exitCode = 1;
} else {
  import("../src/cli.mjs");
}

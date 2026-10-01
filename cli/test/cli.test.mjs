// The command line as agents and CI run it: no terminal, flags only, exit codes and JSON.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { writeFolder } from "../src/folder.mjs";
import { fakeBin, pathWith, runCli, tempDir, until } from "./helpers.mjs";

const agentFolder = (app, extra = {}) => {
  const folder = tempDir("binf-cli-");
  writeFolder(folder, { api: "http://127.0.0.1:9", app, key: "binf_test_dummy_key", cockpit: { id: "c1", name: "lab", url: "http://x/c" }, model: "m", ...extra });
  return folder;
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

describe("usage", () => {
  it("rejects an unknown option with a suggestion and exit code 2, no stack trace", async () => {
    const result = await runCli(["agent-os", "x", "--modle", "y"]);
    assert.equal(result.code, 2);
    assert.match(result.err, /Unknown option --modle/);
    assert.match(result.err, /Did you mean --model\?/);
    assert.doesNotMatch(result.err, /at .*node:internal/);
  });

  it("prints errors as JSON with --json", async () => {
    const result = await runCli(["doctor", "--jsno", "--json"]);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.out).error.code, "usage");
  });

  it("has --help for every command", async () => {
    for (const command of ["agent-os", "doctor", "start", "link-wallet"]) {
      const result = await runCli([command, "--help"]);
      assert.equal(result.code, 0, command);
      assert.match(result.out, new RegExp(`Usage: npx binference ${command}`));
    }
  });

  it("checks BINF_URL and --model before doing anything", async () => {
    assert.equal((await runCli(["agent-os", "x"], { env: { BINF_URL: "binference.io" } })).code, 2);
    assert.equal((await runCli(["agent-os", "x", "--model", 'a"b'])).code, 2);
  });
});

describe("agent-os without a terminal", () => {
  it("asks for --app instead of picking one when both apps are installed", async () => {
    const bin = fakeBin({ claude: 'echo "2.1.0 (Claude Code)"', codex: 'echo "codex-cli 0.150.0"' });
    const cwd = tempDir();
    const result = await runCli(["agent-os", "my-agent", "--json"], { cwd, bin });
    assert.equal(result.code, 2);
    assert.match(JSON.parse(result.out.trim().split("\n").at(-1)).error.hint, /--app claude or --app codex/);
    assert.equal(existsSync(join(cwd, "my-agent")), false, "nothing is written");
  });
});

describe("doctor", () => {
  it("reports every check with an id and a fix, as JSON", async () => {
    const folder = agentFolder("claude_code");
    const result = await runCli(["doctor", "--json"], { cwd: folder, bin: fakeBin() });
    const report = JSON.parse(result.out);
    assert.equal(result.code, 1);
    assert.equal(report.ok, false);
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.equal(byId["hooks.files"].status, "ok");
    assert.equal(byId["hooks.wired"].status, "ok");
    assert.equal(byId["hooks.ran"].status, "todo");
    assert.ok(report.checks.filter((check) => check.status !== "ok").every((check) => check.fix || check.id === "binance.mcp"));
  });

  it("--fix repairs what failed and keeps the person's own settings", async () => {
    const folder = agentFolder("codex");
    const config = join(folder, ".binference", "config.json");
    writeFileSync(config, JSON.stringify({ ...readJson(config), report: false }));
    const toml = join(folder, ".codex", "config.toml");
    writeFileSync(toml, `${readFileSync(toml, "utf8")}\n[mcp_servers.my_own]\nurl = "https://example.com/mcp"\n`);
    const hooksJson = join(folder, ".codex", "hooks.json");
    const settings = readJson(hooksJson);
    settings.hooks.Stop = [{ hooks: [{ type: "command", command: "echo mine" }] }];
    writeFileSync(hooksJson, JSON.stringify(settings));

    const dry = await runCli(["doctor", "--fix", "--dry-run", "--json"], { cwd: folder, bin: fakeBin() });
    assert.ok(JSON.parse(dry.out).would_change.includes(".codex/hooks.json"));
    assert.equal(readJson(hooksJson).hooks.Stop.length, 1, "dry run changes nothing");

    await runCli(["doctor", "--fix"], { cwd: folder, bin: fakeBin() });
    assert.equal(readJson(config).report, false);
    assert.match(readFileSync(toml, "utf8"), /my_own/);
    const stop = readJson(hooksJson).hooks.Stop.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    assert.ok(stop.includes("echo mine") && stop.some((command) => command.includes(".binference/hooks/stop.mjs")));
    assert.deepEqual(Object.keys(readJson(hooksJson)), ["hooks"]);
  });

  it("--fix restores Claude Code's hooks while keeping other settings", async () => {
    const folder = agentFolder("claude_code");
    const path = join(folder, ".claude", "settings.json");
    writeFileSync(path, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, model: "opus" }));
    const fixed = await runCli(["doctor", "--fix", "--json"], { cwd: folder, bin: fakeBin() });
    assert.ok(JSON.parse(fixed.out).checks.find((check) => check.id === "hooks.wired").fixed);
    const settings = readJson(path);
    assert.deepEqual(settings.permissions.allow, ["Bash(ls:*)"]);
    assert.equal(settings.model, "opus");
    assert.ok(settings.permissions.deny.includes("Read(./.binference/key)"));
    const again = await runCli(["doctor", "--json"], { cwd: folder, bin: fakeBin() });
    assert.equal(JSON.parse(again.out).checks.find((check) => check.id === "hooks.wired").status, "ok");
  });
});

describe("start", () => {
  it("passes a stop signal to the app and ends the same way", async () => {
    const folder = agentFolder("claude_code");
    const pidFile = join(folder, "app.pid");
    const bin = fakeBin({ claude: `echo $$ > "${pidFile}"\nexec sleep 30` });
    const child = spawn(join(folder, "start"), [], { cwd: folder, env: { PATH: pathWith(bin) } });
    assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()));
    const appPid = Number(readFileSync(pidFile, "utf8"));
    const ended = new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
    child.kill("SIGTERM");
    assert.deepEqual(await ended, { code: null, signal: "SIGTERM" });
    assert.ok(await until(() => {
      try {
        process.kill(appPid, 0);
        return false;
      } catch {
        return true;
      }
    }), "the app stopped too");
  });

  it("explains a folder that is not an agent folder", async () => {
    const result = await runCli(["start"], { cwd: tempDir() });
    assert.equal(result.code, 1);
    assert.match(result.err, /not an agent folder/);
  });
});

describe("link-wallet", () => {
  it("refuses to run without a terminal, so an agent cannot sign", async () => {
    const result = await runCli(["link-wallet"], { cwd: agentFolder("claude_code") });
    assert.equal(result.code, 1);
    assert.match(result.err, /only in a terminal/);
  });
});


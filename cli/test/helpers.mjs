// Test helpers: throwaway agent folders, a fake `baw` on a PATH that cannot reach the real
// one, stub servers for binference.io, and running hooks and the CLI as an app would.

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const USDT = "0x55d398326f99059ff775485246999027b3197955";
export const BNB = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const tempDir = (prefix = "binf-test-") => mkdtempSync(join(tmpdir(), prefix));

/**
 * A bin folder with `node` and a fake `baw`. Quotes answer FAKE_QUOTE dollars after
 * FAKE_DELAY seconds. `extra` adds programs by name with a shell body.
 */
export function fakeBin(extra = {}) {
  const bin = tempDir("binf-bin-");
  symlinkSync(process.execPath, join(bin, "node"));
  const programs = {
    baw: `case "$1 $2" in
  "--version "*) echo "1.10.0";;
  "wallet status") echo '{"success":true,"data":{"status":"SIGNED_OUT"}}';;
  "market-order quote") sleep "\${FAKE_DELAY:-0}"; echo "{\\"success\\":true,\\"data\\":{\\"toCoinAmount\\":\\"\${FAKE_QUOTE:-60}\\"}}";;
  "market-order list") echo '{"success":true,"data":{"list":[{"status":"PROCESSING"}]}}';;
  *) echo '{"success":false}'; exit 1;;
esac`,
    ...extra,
  };
  for (const [name, body] of Object.entries(programs)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

/** A PATH with the fake programs and the system's basics only. */
export const pathWith = (bin) => `${bin}:/usr/bin:/bin`;

/** An agent folder with the hooks from this checkout, its config and a dummy key. */
export function makeAgent({ app = "claude_code", api = "http://127.0.0.1:9", state, outbox } = {}) {
  const folder = tempDir("binf-agent-");
  const hooks = join(folder, ".binference", "hooks");
  mkdirSync(hooks, { recursive: true });
  const source = process.env.BINF_TEST_HOOKS ?? join(CLI, "hooks");
  for (const file of readdirSync(source)) copyFileSync(join(source, file), join(hooks, file));
  writeFileSync(join(folder, ".binference", "key"), "binf_test_dummy_key\n");
  writeFileSync(
    join(folder, ".binference", "config.json"),
    JSON.stringify({ version: "0.0.0", cockpit_id: "c1", name: "test", cockpit_url: "http://x/c", app, api_url: api, model: "m", report: true }),
  );
  if (state) writeState(folder, state);
  if (outbox) writeFileSync(join(folder, ".binference", "outbox.jsonl"), outbox.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return folder;
}

export const writeState = (folder, state) => writeFileSync(join(folder, ".binference", "state.json"), JSON.stringify(state));
export const readState = (folder) => JSON.parse(readFileSync(join(folder, ".binference", "state.json"), "utf8"));

/** Runs a hook the way an app does: JSON on stdin; the answer, exit code and time back. */
export function runHook(folder, hook, input, { env = {}, bin = fakeBin() } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(folder, ".binference", "hooks", hook)], {
      env: { PATH: pathWith(bin), HOME: folder, ...env },
      cwd: folder,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => {
      let json = null;
      try {
        json = out ? JSON.parse(out) : null;
      } catch {
        // Left null: the test fails on it.
      }
      done({ code, out, err, json, ms: Date.now() - started, decision: json?.hookSpecificOutput?.permissionDecision ?? "allow" });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** A Bash tool call, as Claude Code sends it to PreToolUse. */
export const bash = (command, id = "toolu_01TEST00001") => ({
  session_id: "s1",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_use_id: id,
  tool_input: { command },
});

export const swap = (qty = "0.1", from = BNB, to = USDT) =>
  `baw market-order swap --fromTokenQty ${qty} --fromToken ${from} --toToken ${to} --binanceChainId 56 --json`;

/** A server that accepts connections and never answers: binference.io having a bad day. */
export async function hangingServer() {
  const server = createTcpServer(() => {});
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** A JSON server: `routes["GET /path"]` returns [status, body]; requests are recorded. */
export async function stubServer(routes) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const key = `${request.method} ${request.url}`;
      requests.push({ key, body: body ? JSON.parse(body) : null });
      const [status, json] = routes[key] ?? [404, { error: { message: "not found" } }];
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    });
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

/** Runs the CLI without a terminal, as an agent or CI would. */
export function runCli(args, { cwd = CLI, env = {}, bin } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(CLI, "bin", "binference.mjs"), ...args], {
      cwd,
      env: { PATH: bin ? pathWith(bin) : process.env.PATH, HOME: cwd, BINF_NO_BROWSER: "1", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code, signal) => done({ code, signal, out, err }));
    child.stdin.end();
  });
}

export const until = async (test, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await new Promise((resume) => setTimeout(resume, 50));
  }
  return false;
};

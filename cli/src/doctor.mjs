// `npx binference doctor`: checks an agent folder end to end and says what to fix.
// `--fix` reinstalls the hooks from this version of the CLI.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requiredBawVersion } from "./agent-os.mjs";
import { installHooks, readConfig, readKey, writeFolder } from "./folder.mjs";
import { atLeast, installed, MIN_CODEX, run } from "./system.mjs";
import { check, command, dim, fail, line, title } from "./ui.mjs";

const PACKAGE_HOOKS = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "hooks");

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function hooksCurrent(folder) {
  const here = join(folder, ".binference", "hooks");
  return readdirSync(PACKAGE_HOOKS)
    .filter((file) => file.endsWith(".mjs"))
    .every((file) => existsSync(join(here, file)) && digest(join(here, file)) === digest(join(PACKAGE_HOOKS, file)));
}

async function cockpit(api, key) {
  try {
    const response = await fetch(`${api}/api/v1/cockpit`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

export async function doctor({ folder: path, fix }) {
  const folder = resolve(path ?? ".");
  const cfg = readConfig(folder);
  if (!cfg) fail(`No agent folder here (${folder} has no .binference/config.json). Make one with "npx binference agent-os <name>".`);
  title(`Checking ${cfg.name}`);
  let problems = 0;
  const bad = (text, detail) => {
    problems += 1;
    check("fail", text, detail);
  };

  const have = await installed();
  check("ok", `Node.js ${have.node}`);
  if (cfg.app === "codex") {
    if (!have.codex) bad("Codex is not installed");
    else if (!atLeast(have.codex, MIN_CODEX)) bad(`Codex ${have.codex} is too old for hooks`, "run: codex update");
    else check("ok", `Codex ${have.codex}`);
  } else if (!have.claude) bad("Claude Code is not installed");
  else check("ok", `Claude Code ${have.claude}`);

  const key = readKey(folder);
  if (!key) bad("No key in .binference/key", "run the setup again in a new folder");
  else {
    const state = await cockpit(cfg.api_url, key);
    if (state.status === 200) {
      const paused = state.json?.paused ? " (paused from the cockpit)" : "";
      check(state.json?.paused ? "todo" : "ok", `Key works, cockpit reachable${paused}`, state.json?.cockpit?.url);
      const budget = state.json?.budget;
      if (budget) {
        const runway = budget.runway_days === null ? "" : `, about ${budget.runway_days} days at this pace`;
        if (Number(budget.spendable_usd) > 0) check("ok", `AI budget $${budget.spendable_usd}${runway}`);
        else bad("No AI budget left: the agent cannot think", `add credit at ${cfg.api_url}/account/credits`);
      }
    } else if (state.status === 401) bad("The key no longer works", "it was revoked or the agent was stopped: set up a new folder");
    else if (state.status === 0) bad(`Could not reach ${cfg.api_url}`);
    else bad(`The cockpit answered HTTP ${state.status}`);
  }

  if (hooksCurrent(folder)) check("ok", "Hooks installed and current");
  else if (fix) {
    installHooks(folder);
    if (cfg.app === "codex" && key) {
      // Rewrites the absolute paths Codex's hooks use, for a folder that moved.
      writeFolder(folder, { api: cfg.api_url, app: cfg.app, key, cockpit: { id: cfg.cockpit_id, name: cfg.name, url: cfg.cockpit_url }, model: cfg.model });
    }
    check("ok", "Hooks reinstalled");
  } else bad("Hooks missing or from another version", 'run "npx binference doctor --fix"');

  const settings = cfg.app === "codex" ? join(folder, ".codex", "hooks.json") : join(folder, ".claude", "settings.json");
  const wired = existsSync(settings) && readFileSync(settings, "utf8").includes(join(".binference", "hooks"));
  if (wired) check("ok", `${cfg.app === "codex" ? "Codex" : "Claude Code"} runs the hooks`);
  else bad("The app's settings do not run the hooks", 'run "npx binference doctor --fix"');

  for (const skill of ["binference", "binance-agentic-wallet", "query-token-audit"]) {
    const found = [".claude", ".agents"].some((root) => existsSync(join(folder, root, "skills", skill, "SKILL.md")));
    if (found) check("ok", `Skill: ${skill}`);
    else bad(`Skill missing: ${skill}`);
  }

  const required = requiredBawVersion(folder);
  if (!have.baw) {
    check("todo", "Binance wallet CLI not installed", "needed for on-chain trading");
    if (required) command(`npm install -g @binance/agentic-wallet@${required}`);
  } else if (required && !atLeast(have.baw, required)) {
    bad(`baw ${have.baw} is older than the ${required} the wallet skill needs`);
    command(`npm install -g @binance/agentic-wallet@${required}`);
  } else {
    check("ok", `Binance wallet CLI (baw ${have.baw})`);
    const status = await run("baw", ["wallet", "status", "--json"], { timeoutMs: 8_000 });
    const connected = /"CONNECTED"/.test(status ?? "");
    check(connected ? "ok" : "todo", connected ? "Agentic Wallet signed in" : "Agentic Wallet signed out", connected ? null : 'say "Sign in to Binance Agentic Wallet" to the agent');
  }

  const mcp = await run(cfg.app === "codex" ? "codex" : "claude", ["mcp", "list"], { cwd: folder, timeoutMs: 30_000 });
  if (mcp === null) check("todo", "Could not list MCP servers");
  else if (/binance-mcp-server/.test(mcp)) {
    const needsAuth = /binance-mcp-server[^\n]*(auth|login|✗|failed)/i.test(mcp);
    check(needsAuth ? "todo" : "ok", needsAuth ? "Binance MCP Server added, sign-in needed" : "Binance MCP Server connected");
  } else {
    check("todo", "Binance MCP Server not added", "for exchange trading, run in the folder:");
    command(
      cfg.app === "codex"
        ? "codex mcp add binance-mcp-server --url https://agent.binance.com/mcp/agentic --oauth-client-id codex"
        : "claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic",
    );
  }

  const outbox = join(folder, ".binference", "outbox.jsonl");
  const waiting = existsSync(outbox) ? readFileSync(outbox, "utf8").split("\n").filter(Boolean).length : 0;
  if (waiting > 0) check("todo", `${waiting} report${waiting === 1 ? "" : "s"} waiting to reach the cockpit`, "they go with the next turn");

  line();
  if (problems === 0) line(dim("  All good.\n"));
  else process.exitCode = 1;
}

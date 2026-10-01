// `npx binference doctor`: checks an agent folder end to end and says what to fix. Each
// check has a stable id, a status (ok, fail, todo: the person's own step) and, when it is
// not ok, the fix. `--fix` repairs what failed and keeps the person's own settings;
// `--dry-run` shows what it would change. `--json` prints the result as one JSON object.
// Exit code 1 when a check fails.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { requiredBawVersion } from "./agent-os.mjs";
import { CliError } from "./errors.mjs";
import { CLI_VERSION, hookFiles, missingHooks, PACKAGE_HOOKS, readConfig, readKey, repairs } from "./folder.mjs";
import { atLeast, installed, MIN_CODEX, MIN_HOOK_NODE, run } from "./system.mjs";
import { check as print, dim, emit, line, title } from "./ui.mjs";

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function hooksCurrent(folder) {
  const here = join(folder, ".binference", "hooks");
  return hookFiles().every((file) => existsSync(join(here, file)) && digest(join(here, file)) === digest(join(PACKAGE_HOOKS, file)));
}

async function cockpit(api, key) {
  try {
    const response = await fetch(`${api}/api/v1/cockpit`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": `binference-cli/${CLI_VERSION}` },
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

function readState(folder) {
  try {
    return JSON.parse(readFileSync(join(folder, ".binference", "state.json"), "utf8"));
  } catch {
    return {};
  }
}

const outboxSize = (folder) => {
  try {
    return readFileSync(join(folder, ".binference", "outbox.jsonl"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

export async function doctor({ folder: path, fix, dryRun }) {
  const folder = resolve(path ?? ".");
  const cfg = readConfig(folder);
  if (!cfg) {
    throw new CliError("not_agent_folder", `${folder} is not an agent folder (no .binference/config.json).`, {
      hint: 'Make one with "npx binference agent-os <name>", or run this inside one.',
    });
  }
  const appName = cfg.app === "codex" ? "Codex" : "Claude Code";
  title(`Checking ${cfg.name ?? folder}`);

  const checks = [];
  const add = (id, status, message, { detail, fix: fixText, repair } = {}) => {
    const entry = { id, status, message, ...(detail ? { detail } : {}), ...(fixText ? { fix: fixText } : {}) };
    if (repair) entry.repair = repair;
    checks.push(entry);
    return entry;
  };

  const have = await installed();
  add("node", "ok", `Node.js ${have.node}`);
  if (!have.pathNode) add("node.path", "fail", "No `node` on PATH: the hooks cannot run", { fix: "Install Node.js 22 or newer: https://nodejs.org" });
  else if (!atLeast(have.pathNode, MIN_HOOK_NODE)) add("node.path", "fail", `The \`node\` on PATH is ${have.pathNode}; the hooks need ${MIN_HOOK_NODE} or newer`, { fix: "Install Node.js 22 or newer: https://nodejs.org" });

  if (cfg.app === "codex") {
    if (!have.codex) add("app", "fail", "Codex is not installed", { fix: "Install Codex: https://developers.openai.com/codex" });
    else if (!atLeast(have.codex, MIN_CODEX)) add("app", "fail", `Codex ${have.codex} is too old for hooks`, { fix: "codex update" });
    else add("app", "ok", `Codex ${have.codex}`);
  } else if (!have.claude) add("app", "fail", "Claude Code is not installed", { fix: "Install Claude Code: https://claude.com/claude-code" });
  else add("app", "ok", `Claude Code ${have.claude}`);

  const key = readKey(folder);
  if (!key) add("key", "fail", "No key in .binference/key", { fix: "Set up a new folder with npx binference agent-os <name>" });
  else {
    const state = await cockpit(cfg.api_url, key);
    if (state.status === 200) {
      const paused = Boolean(state.json?.paused);
      add("cockpit", paused ? "todo" : "ok", `Key works, cockpit reachable${paused ? " (paused from the cockpit)" : ""}`, {
        detail: state.json?.cockpit?.url,
        ...(paused ? { fix: `Resume the agent at ${cfg.cockpit_url}` } : {}),
      });
      const budget = state.json?.budget;
      if (budget) {
        const runway = budget.runway_days === null || budget.runway_days === undefined ? "" : `, about ${budget.runway_days} days at this pace`;
        if (Number(budget.spendable_usd) > 0) add("budget", "ok", `AI budget $${budget.spendable_usd}${runway}`);
        else add("budget", "fail", "No AI budget left: the agent cannot think", { fix: `Add credit at ${cfg.api_url}/account/credits` });
      }
    } else if (state.status === 401) add("cockpit", "fail", "The key no longer works", { detail: "it was revoked or the agent was stopped", fix: "Set up a new folder with npx binference agent-os <name>" });
    else if (state.status === 0) add("cockpit", "fail", `Could not reach ${cfg.api_url}`, { fix: "Check the connection and run doctor again" });
    else add("cockpit", "fail", `The cockpit answered HTTP ${state.status}`, { fix: "Run doctor again later" });
  }

  if (hooksCurrent(folder)) add("hooks.files", "ok", "Hooks installed and current");
  else add("hooks.files", "fail", "Hooks missing or from another version", { fix: "npx binference doctor --fix", repair: "hooks" });

  const missing = missingHooks(folder, cfg.app);
  if (missing.length === 0) add("hooks.wired", "ok", `${appName} runs the hooks`);
  else add("hooks.wired", "fail", `${appName}'s settings do not run the hooks for ${missing.join(", ")}`, { fix: "npx binference doctor --fix", repair: "settings" });

  // Whether a hook actually ran: Codex skips hooks the person has not approved yet.
  const last = readState(folder).last_session;
  if (last?.at) add("hooks.ran", "ok", "Hooks ran", { detail: `last session started ${last.at}` });
  else {
    add("hooks.ran", "todo", "No session has run the hooks yet", {
      fix: cfg.app === "codex" ? "Start the agent with ./start and approve its hooks when Codex asks (or in /hooks)" : "Start the agent with ./start",
    });
  }

  if (existsSync(join(folder, "start"))) add("launcher", "ok", "Launcher ./start");
  else add("launcher", "fail", "No ./start launcher", { fix: "npx binference doctor --fix", repair: "launcher" });

  for (const skill of ["binference", "binance-agentic-wallet", "query-token-audit"]) {
    const found = [".claude", ".agents"].some((root) => existsSync(join(folder, root, "skills", skill, "SKILL.md")));
    if (found) add(`skill.${skill}`, "ok", `Skill: ${skill}`);
    else if (skill === "binference") add(`skill.${skill}`, "fail", `Skill missing: ${skill}`, { fix: "npx binference doctor --fix", repair: "skill" });
    else {
      add(`skill.${skill}`, "fail", `Skill missing: ${skill}`, {
        fix: `In the folder: npx skills@1.7.0 add binance/binance-skills-hub -s ${skill} -a claude-code -a codex`,
      });
    }
  }

  const required = requiredBawVersion(folder);
  if (!have.baw) {
    add("wallet.cli", "todo", "Binance wallet CLI not installed", {
      detail: "needed for on-chain trading",
      ...(required ? { fix: `npm install -g @binance/agentic-wallet@${required}` } : {}),
    });
  } else if (required && !atLeast(have.baw, required)) {
    add("wallet.cli", "fail", `baw ${have.baw} is older than the ${required} the wallet skill needs`, { fix: `npm install -g @binance/agentic-wallet@${required}` });
  } else {
    add("wallet.cli", "ok", `Binance wallet CLI (baw ${have.baw})`);
    const status = await run("baw", ["wallet", "status", "--json"], { timeoutMs: 8_000 });
    const connected = /"CONNECTED"/.test(status ?? "");
    if (connected) add("wallet.session", "ok", "Agentic Wallet signed in");
    else add("wallet.session", "todo", "Agentic Wallet signed out", { fix: 'Say "Sign in to Binance Agentic Wallet" to the agent' });
  }

  const addMcp = cfg.app === "codex" ? "codex mcp add binance-mcp-server --url https://agent.binance.com/mcp/agentic --oauth-client-id codex" : "claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic";
  if (cfg.app === "codex") {
    const listed = await run("codex", ["mcp", "list", "--json"], { cwd: folder, timeoutMs: 30_000 });
    let servers = null;
    try {
      servers = JSON.parse(listed ?? "");
    } catch {
      // Not readable: reported below.
    }
    const names = Array.isArray(servers) ? servers.map((server) => server?.name) : null;
    if (!names) add("binance.mcp", "todo", "Could not list Codex's MCP servers");
    else if (names.includes("binance-mcp-server")) add("binance.mcp", "ok", "Binance MCP Server added");
    else add("binance.mcp", "todo", "Binance MCP Server not added", { fix: addMcp });
  } else {
    const listed = await run("claude", ["mcp", "list"], { cwd: folder, timeoutMs: 30_000 });
    if (listed === null) add("binance.mcp", "todo", "Could not list Claude Code's MCP servers");
    else if (/binance-mcp-server/.test(listed)) {
      const needsAuth = /binance-mcp-server[^\n]*(auth|login|✗|failed)/i.test(listed);
      add("binance.mcp", needsAuth ? "todo" : "ok", needsAuth ? "Binance MCP Server added, sign-in needed" : "Binance MCP Server connected", needsAuth ? { fix: "In the agent, open /mcp, pick binance-mcp-server and sign in" } : {});
    } else add("binance.mcp", "todo", "Binance MCP Server not added", { fix: addMcp });
  }

  const waiting = outboxSize(folder);
  if (waiting > 0) add("reports", "todo", `${waiting} report${waiting === 1 ? "" : "s"} waiting to reach the cockpit`, { detail: "they go with the next turn" });

  // Repairs: only for what failed, and only the ones that can be made here.
  const changes = [];
  if (fix) {
    const wanted = [...new Set(checks.filter((entry) => entry.status === "fail" && entry.repair).map((entry) => entry.repair))];
    for (const name of wanted) {
      const changed = repairs[name](folder, cfg, { dryRun });
      changes.push(...changed);
      for (const entry of checks.filter((item) => item.repair === name)) {
        if (!dryRun) {
          entry.status = "ok";
          entry.fixed = true;
          delete entry.fix;
        }
      }
    }
  }

  for (const entry of checks) {
    print(entry.status, entry.fixed ? `${entry.message} (fixed)` : entry.message, entry.detail ?? (entry.status === "ok" ? undefined : entry.fix));
  }
  if (changes.length > 0) {
    line();
    line(`  ${dryRun ? "Would change" : "Changed"}: ${changes.join(", ")}`);
  }
  const ok = checks.every((entry) => entry.status !== "fail");
  line();
  line(dim(ok ? "  All good.\n" : '  Fix the ✗ lines above. "npx binference doctor --fix" repairs the ones marked for it.\n'));
  if (!ok) process.exitCode = 1;
  emit({
    ok,
    folder,
    app: cfg.app,
    checks: checks.map(({ repair, ...entry }) => entry),
    ...(fix ? { [dryRun ? "would_change" : "changed"]: changes } : {}),
  });
}

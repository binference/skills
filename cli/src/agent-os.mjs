// `npx binference agent-os <name>`: one folder, one agent, ready for Binance Agent OS.
// It checks the machine, signs in with a code, writes the folder with its key, rules,
// skills, hooks and launcher, installs Binance's wallet CLI if asked, and hands over the
// two steps Binance asks people to do themselves.
//
// Without a terminal (an agent, CI) it never prompts and never assumes a yes: a choice it
// needs comes from a flag. With --json it prints one JSON event per line.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { CliError, usageError } from "./errors.mjs";
import { DEFAULT_MODEL, installOwnSkill, readConfig, writeFolder } from "./folder.mjs";
import { showApproval, startSignIn, waitForApproval } from "./link.mjs";
import { atLeast, installed, MIN_CODEX, run } from "./system.mjs";
import { check, choose, command, confirm, dim, emit, line, title } from "./ui.mjs";

/** Binance's skills, from its Skills Hub, at the installer version checked with this CLI. */
const SKILLS_CLI = "skills@1.7.0";
const BINANCE_SKILLS = ["binance-agentic-wallet", "query-token-audit"];
const SKILLS_COMMAND = `npx ${SKILLS_CLI} add binance/binance-skills-hub ${BINANCE_SKILLS.map((skill) => `-s ${skill}`).join(" ")} -a claude-code -a codex`;

const BINANCE_MCP = {
  claude_code: "claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic",
  codex: "codex mcp add binance-mcp-server --url https://agent.binance.com/mcp/agentic --oauth-client-id codex",
};

/** The `baw` version the installed wallet skill asks for, from its own front matter. */
export function requiredBawVersion(folder) {
  for (const root of [".claude", ".agents"]) {
    try {
      const skill = readFileSync(join(folder, root, "skills", "binance-agentic-wallet", "SKILL.md"), "utf8");
      const found = /requiredCliVersion:\s*['"]?(\d+\.\d+\.\d+)/.exec(skill)?.[1];
      if (found) return found;
    } catch {
      // Try the other root.
    }
  }
  return null;
}

const pendingPath = (folder) => join(folder, ".binference", "pending.json");

async function pickApp(have, wanted) {
  const apps = [];
  if (have.claude) apps.push({ label: `Claude Code ${have.claude}`, value: "claude_code" });
  if (have.codex && atLeast(have.codex, MIN_CODEX)) apps.push({ label: `Codex ${have.codex}`, value: "codex" });
  if (have.codex && !atLeast(have.codex, MIN_CODEX)) check("fail", `Codex ${have.codex} is too old for hooks`, "run: codex update");
  if (apps.length === 0) {
    throw new CliError("no_app", "Neither Claude Code nor Codex 0.140+ is installed here.", {
      hint: "Install Claude Code (https://claude.com/claude-code) or Codex (https://developers.openai.com/codex), then run this again.",
    });
  }
  if (wanted) {
    if (apps.some((option) => option.value === wanted)) return wanted;
    throw new CliError("app_missing", `${wanted === "codex" ? "Codex 0.140 or newer" : "Claude Code"} is not installed here.`);
  }
  const picked = await choose("Which app runs this agent?", apps);
  if (picked) return picked;
  throw usageError("Both Claude Code and Codex are installed: say which one runs the agent.", "Add --app claude or --app codex.");
}

export async function agentOs({ name, app: wantedApp, model: wantedModel, api, yes, sandbox, noWait, resume }) {
  title("bInference for Binance Agent OS");
  line(dim("  One folder, one agent: it thinks with bInference and acts through Binance.\n"));
  const folder = resolve(name ?? "my-agent");
  const shown = relative(process.cwd(), folder) || ".";

  // A sign-in started with --no-wait carries the choices made then.
  let pending = null;
  let settings;
  if (resume) {
    try {
      ({ pending, settings } = JSON.parse(readFileSync(pendingPath(folder), "utf8")));
    } catch {
      throw new CliError("nothing_to_resume", `${shown} has no sign-in waiting.`, { hint: `Start one with "npx binference agent-os ${shown}".` });
    }
    if (Date.parse(pending.expires_at) <= Date.now()) {
      rmSync(folder, { recursive: true, force: true });
      throw new CliError("sign_in_expired", "The code expired before it was approved.", { hint: `Run "npx binference agent-os ${shown}" for a new one.` });
    }
  }

  const have = await installed();
  check("ok", `Node.js ${have.node}`);
  const app = settings?.app ?? (await pickApp(have, wantedApp));
  check("ok", app === "codex" ? `Codex ${have.codex}` : `Claude Code ${have.claude}`);
  const model = settings?.model ?? wantedModel ?? DEFAULT_MODEL[app];
  const useSandbox = settings?.sandbox ?? sandbox;

  // The folder is made before signing in, so a folder that cannot be written never leaves a
  // key behind on binference.io.
  let created = false;
  if (!resume) {
    if (existsSync(folder) && readdirSync(folder).length > 0) {
      if (readConfig(folder)) throw new CliError("exists", `${shown} is already an agent folder.`, { hint: `Run "npx binference doctor" inside it.` });
      throw new CliError("not_empty", `${shown} is not empty.`, { hint: "Pick a new name for the agent's folder." });
    }
    created = !existsSync(folder);
    try {
      mkdirSync(join(folder, ".binference"), { recursive: true });
    } catch (error) {
      throw new CliError("cannot_write", `Cannot create ${shown}: ${error.code ?? error.message}.`);
    }
  }

  let linked;
  try {
    if (!pending) pending = await startSignIn({ api, name: basename(folder), app });
    await showApproval(pending, { open: !noWait });
    if (noWait) {
      writeFileSync(pendingPath(folder), JSON.stringify({ pending, settings: { app, model, sandbox: useSandbox } }), { mode: 0o600 });
      emit({ event: "waiting", ok: true, folder, resume: `npx binference agent-os ${shown} --resume` });
      line(`  When it is approved, finish with:`);
      command(`npx binference agent-os ${shown} --resume`);
      return;
    }
    linked = await waitForApproval({ api, pending });
  } catch (error) {
    // Nothing was written yet: leave no half-made folder behind.
    if (created || resume) rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  if (existsSync(pendingPath(folder))) unlinkSync(pendingPath(folder));

  const limit = linked.limit
    ? `$${linked.limit.usd} a ${{ daily: "day", weekly: "week" }[linked.limit.reset] ?? "month"}`
    : "no limit";
  check("ok", `Key made, paid by ${linked.payer?.name ?? "your account"}`, `spending limit: ${limit}`);

  writeFolder(folder, { api, app, key: linked.key, cockpit: linked.cockpit, model, sandbox: useSandbox });
  check("ok", "Folder written with its rules, hooks, launcher and settings", shown);
  if (useSandbox) check("ok", "Claude Code's sandbox is on", "approve Binance's and binference.io's hosts the first time");

  if (installOwnSkill(folder)) check("ok", "bInference skill");
  const hub = await run(
    "npx",
    ["-y", SKILLS_CLI, "add", "binance/binance-skills-hub", ...BINANCE_SKILLS.flatMap((skill) => ["-s", skill]), "-a", "claude-code", "-a", "codex", "-y", "--copy"],
    { cwd: folder, timeoutMs: 240_000, env: { DISABLE_TELEMETRY: "1" } },
  );
  const steps = [];
  if (hub) check("ok", "Binance skills: Agentic Wallet and token audit");
  else {
    check("fail", "Binance skills did not install", "in the folder, run the command below");
    command(SKILLS_COMMAND);
    steps.push({ id: "binance_skills", run_in_folder: SKILLS_COMMAND });
  }

  const required = requiredBawVersion(folder);
  if (have.baw && (!required || atLeast(have.baw, required))) {
    check("ok", `Binance wallet CLI (baw ${have.baw})`);
  } else if (required) {
    const install = yes || (await confirm(`Install Binance's wallet CLI (baw ${required}) with npm now?`, { defaultYes: true }));
    const done =
      install &&
      (await run("npm", ["install", "-g", `@binance/agentic-wallet@${required}`, "--no-fund", "--no-audit", "--loglevel=error"], {
        timeoutMs: 300_000,
      }));
    if (done) check("ok", `Binance wallet CLI (baw ${required})`, "npm's warnings while installing are expected");
    else {
      const how = `npm install -g @binance/agentic-wallet@${required}`;
      check("todo", "Binance wallet CLI not installed", install === null ? "add --yes to install it, or run:" : "for on-chain trading, run:");
      command(how);
      steps.push({ id: "wallet_cli", run: how });
    }
  }

  title("Two steps Binance asks you to do yourself");
  line("  1. Connect Binance's MCP Server for exchange trading. Run this in the folder:");
  command(BINANCE_MCP[app]);
  line(
    app === "codex"
      ? "     Sign in to Binance in the browser it opens. Grant the fewest scopes you need.\n     Codex adds it for every Codex session on this machine, not only this agent."
      : "     Then start the agent, open /mcp, pick binance-mcp-server and sign in to Binance.",
  );
  line(`  2. For on-chain trading, start the agent and say "Sign in to Binance Agentic Wallet".`);
  line("     Then lower its limits in the Binance App: Agentic Wallet → Settings. Binance suggests $50 a day.");
  steps.push(
    { id: "binance_mcp", person: true, run_in_folder: BINANCE_MCP[app] },
    { id: "wallet_sign_in", person: true, say_to_agent: "Sign in to Binance Agentic Wallet" },
  );

  const start = `cd ${shown.includes(" ") ? `"${shown}"` : shown} && ./start`;
  title("Start it");
  command(start);
  line(
    dim(
      app === "codex"
        ? "  Codex asks you once to trust the folder and to approve its hooks (in .binference/hooks).\n  Approve them: without the hooks, the limits on binference.io do not apply."
        : "  Claude Code asks you once to trust the folder. Start it this way each time: plain `claude` would not think with bInference.",
    ),
  );
  line(`  Cockpit: ${linked.cockpit.url}`);
  line(dim(`  Check everything again any time with "npx binference doctor" in the folder.\n`));
  emit({ event: "done", ok: true, folder, app, model, cockpit_url: linked.cockpit.url, start, next_steps: steps });
}

// `npx binference agent-os <name>`: one folder, one agent, ready for Binance Agent OS.
// It checks the machine, signs in with a code, writes the folder with its key, rules,
// skills and hooks, installs Binance's wallet CLI if asked, and hands over the two steps
// Binance asks people to do themselves.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { DEFAULT_MODEL, installOwnSkill, readConfig, writeFolder } from "./folder.mjs";
import { signIn } from "./link.mjs";
import { atLeast, installed, MIN_CODEX, MIN_NODE, run } from "./system.mjs";
import { check, choose, command, confirm, dim, fail, line, title } from "./ui.mjs";

/** Binance's skills, from its Skills Hub, at the installer version checked with this CLI. */
const SKILLS_CLI = "skills@1.7.0";
const BINANCE_SKILLS = ["binance-agentic-wallet", "query-token-audit"];

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

export async function agentOs({ name, app: wantedApp, model: wantedModel, api, yes }) {
  title("bInference for Binance Agent OS");
  line(dim("  One folder, one agent: it thinks with bInference and acts through Binance.\n"));

  const have = await installed();
  if (!atLeast(have.node, MIN_NODE)) {
    fail(`This needs Node.js 22 or newer, and this machine has ${have.node}. Get it at https://nodejs.org.`);
  }
  check("ok", `Node.js ${have.node}`);

  const apps = [];
  if (have.claude) apps.push({ label: `Claude Code ${have.claude}`, value: "claude_code" });
  if (have.codex && atLeast(have.codex, MIN_CODEX)) apps.push({ label: `Codex ${have.codex}`, value: "codex" });
  if (have.codex && !atLeast(have.codex, MIN_CODEX)) {
    check("fail", `Codex ${have.codex} is too old for hooks`, "run: codex update");
  }
  if (apps.length === 0) {
    fail(
      "Install Claude Code (https://claude.com/claude-code) or Codex (https://developers.openai.com/codex), then run this again.",
    );
  }
  const app =
    wantedApp && apps.some((option) => option.value === wantedApp)
      ? wantedApp
      : wantedApp
        ? fail(`${wantedApp === "codex" ? "Codex 0.140 or newer" : "Claude Code"} is not installed here.`)
        : await choose("Which app runs this agent?", apps);
  check("ok", app === "codex" ? `Codex ${have.codex}` : `Claude Code ${have.claude}`);

  const folder = resolve(name ?? "my-agent");
  if (existsSync(folder) && readdirSync(folder).length > 0) {
    if (readConfig(folder)) fail(`${folder} is already an agent folder. Run "npx binference doctor" inside it.`);
    fail(`${folder} is not empty. Pick a new name for the agent's folder.`);
  }

  const linked = await signIn({ api, name: basename(folder), app });
  const limit = linked.limit ? `$${linked.limit.usd} a ${linked.limit.reset === "daily" ? "day" : linked.limit.reset === "weekly" ? "week" : "month"}` : "no limit";
  check("ok", `Key made, paid by ${linked.payer?.name ?? "your account"}`, `spending limit: ${limit}`);

  mkdirSync(folder, { recursive: true });
  const model = wantedModel ?? DEFAULT_MODEL[app];
  writeFolder(folder, { api, app, key: linked.key, cockpit: linked.cockpit, model });
  check("ok", "Folder written with its rules, hooks and settings", relative(process.cwd(), folder) || ".");

  if (installOwnSkill(folder)) check("ok", "bInference skill");
  const hub = await run(
    "npx",
    ["-y", SKILLS_CLI, "add", "binance/binance-skills-hub", ...BINANCE_SKILLS.flatMap((skill) => ["-s", skill]), "-a", "claude-code", "-a", "codex", "-y", "--copy"],
    { cwd: folder, timeoutMs: 240_000, env: { DISABLE_TELEMETRY: "1" } },
  );
  if (hub) check("ok", "Binance skills: Agentic Wallet and token audit");
  else {
    check("fail", "Binance skills did not install", "in the folder, run the command below");
    command(`npx skills add binance/binance-skills-hub -s binance-agentic-wallet -s query-token-audit -a claude-code -a codex`);
  }

  const required = requiredBawVersion(folder);
  if (have.baw && (!required || atLeast(have.baw, required))) {
    check("ok", `Binance wallet CLI (baw ${have.baw})`);
  } else if (required) {
    const install = yes || (await confirm(`Install Binance's wallet CLI (baw ${required}) with npm now?`));
    const done =
      install &&
      (await run("npm", ["install", "-g", `@binance/agentic-wallet@${required}`, "--no-fund", "--no-audit", "--loglevel=error"], {
        timeoutMs: 300_000,
      }));
    if (done) check("ok", `Binance wallet CLI (baw ${required})`, "npm's warnings while installing are expected");
    else {
      check("todo", "Binance wallet CLI not installed", "for on-chain trading, run:");
      command(`npm install -g @binance/agentic-wallet@${required}`);
    }
  }

  title("Two steps Binance asks you to do yourself");
  line("  1. Connect Binance's MCP Server for exchange trading. Run this in the folder:");
  command(
    app === "codex"
      ? "codex mcp add binance-mcp-server --url https://agent.binance.com/mcp/agentic --oauth-client-id codex"
      : "claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic",
  );
  line(
    app === "codex"
      ? "     Sign in to Binance in the browser it opens. Grant the fewest scopes you need."
      : "     Then start Claude Code, open /mcp, pick binance-mcp-server and sign in to Binance.",
  );
  line(`  2. For on-chain trading, start the agent and say "Sign in to Binance Agentic Wallet".`);
  line("     Then lower its limits in the Binance App: Agentic Wallet → Settings. Binance suggests $50 a day.");

  title("Start it");
  const into = relative(process.cwd(), folder) || ".";
  command(`cd ${into.includes(" ") ? `"${into}"` : into} && npx binference start`);
  line(
    dim(
      app === "codex"
        ? "  Codex asks you once to trust the folder and review its hooks: they are in .binference/hooks."
        : "  Claude Code asks you once to trust the folder. Start it this way each time: plain `claude` would not think with bInference.",
    ),
  );
  line(`  Cockpit: ${linked.cockpit.url}`);
  line(dim(`  Check everything again any time with "npx binference doctor" in the folder.\n`));
}

#!/usr/bin/env node
// bInference's command line: set up and check agents that run on Binance Agent OS and
// think with bInference.

import { parseArgs } from "node:util";

import { agentOs } from "../src/agent-os.mjs";
import { doctor } from "../src/doctor.mjs";
import { linkWallet } from "../src/link-wallet.mjs";
import { CLI_VERSION } from "../src/folder.mjs";
import { start } from "../src/start.mjs";
import { fail, line } from "../src/ui.mjs";

const HELP = `bInference ${CLI_VERSION}

  npx binference agent-os [name]   Set up a folder for an agent on Binance Agent OS
      --app claude|codex           Which app runs it (asked when both are installed)
      --model <id>                 Its model (any id on binference.io/models)
      --yes                        Install Binance's wallet CLI without asking

  npx binference doctor            Check the agent folder you are in
      --fix                        Reinstall its hooks

  npx binference start [args]      Start the folder's app on bInference

  npx binference link-wallet       Link the agent's wallet for a track record
                                   checked on BNB Chain (you sign; it moves nothing)

Docs: https://docs.binference.io/agent-os`;

const api = (process.env.BINF_URL ?? "https://binference.io").replace(/\/+$/, "");
const [commandName, ...rest] = process.argv.slice(2);

switch (commandName) {
  case "agent-os": {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        app: { type: "string" },
        model: { type: "string" },
        yes: { type: "boolean", short: "y" },
      },
    });
    const app = values.app === "claude" || values.app === "claude-code" ? "claude_code" : values.app;
    if (app && app !== "claude_code" && app !== "codex") fail("--app is claude or codex.");
    await agentOs({ name: positionals[0], app, model: values.model, api, yes: values.yes ?? false });
    break;
  }
  case "doctor": {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { fix: { type: "boolean" } },
    });
    await doctor({ folder: positionals[0], fix: values.fix ?? false });
    break;
  }
  case "start":
    start({ folder: ".", args: rest });
    break;
  case "link-wallet":
    await linkWallet({ folder: rest[0] });
    break;
  case "--version":
  case "-v":
    line(CLI_VERSION);
    break;
  default:
    line(HELP);
    if (commandName && commandName !== "help" && commandName !== "--help" && commandName !== "-h") process.exitCode = 1;
}

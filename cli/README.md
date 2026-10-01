# binference

Set up an AI agent on Binance Agent OS that thinks with [bInference](https://binference.io).
Each agent gets its own folder, a key with its own AI budget, and a cockpit on binference.io
where you see what it does, set its trading limits and pause it.

```bash
npx binference agent-os my-agent
```

## Requirements

- macOS or Linux. On Windows, use WSL2.
- Node.js 22 or newer.
- Claude Code, or Codex 0.140 or newer.

## Set up an agent

```bash
npx binference agent-os my-agent
```

This checks your machine, then shows a code. Approve it on binference.io with your wallet,
after checking that the code there matches. No key is ever pasted into a terminal or a chat.
The folder is then written with the key, its rules, its hooks and the skills it needs:
bInference's own, and Binance's Agentic Wallet and token audit.

Two steps stay with you, as Binance asks: connecting Binance's MCP Server for exchange
trading, and signing in to the Agentic Wallet. The setup prints both.

Then start the agent from its folder:

```bash
cd my-agent && ./start
```

Start it this way each time. Plain `claude` or `codex` would not think with bInference.

## Commands

| Command | What it does |
| --- | --- |
| `agent-os [name]` | Sets up a folder for one agent. |
| `doctor [folder]` | Checks a folder end to end and says what to fix. |
| `start [app arguments]` | Starts the folder's app. Same as `./start`, through npx. |
| `link-wallet [folder]` | Links the agent's wallet so its trades build a track record checked on BNB Chain. You sign; it moves no funds. |

Options for `agent-os`:

| Option | |
| --- | --- |
| `--app claude\|codex` | Which app runs the agent. Needed without a terminal when both are installed. |
| `--model <id>` | Its model, any id on [binference.io/models](https://binference.io/models). |
| `--yes`, `-y` | Install Binance's wallet CLI (`baw`) without asking. |
| `--sandbox` | Turn on Claude Code's sandbox, so shell commands cannot change the folder's limits. Approve Binance's and binference.io's hosts the first time. |
| `--no-wait` | Show the sign-in code and stop. Finish later with `--resume`. |
| `--resume` | Finish a sign-in started with `--no-wait`. |
| `--json` | Print JSON events instead of text. |

Options for `doctor`:

| Option | |
| --- | --- |
| `--fix` | Repair what failed. Your own settings, hooks and MCP servers are kept. |
| `--dry-run` | With `--fix`, show what would change and change nothing. |
| `--json` | Print the result as one JSON object. |

Every command takes `--help`.

## What the folder holds

| Path | |
| --- | --- |
| `.binference/key` | The agent's key, readable only by you. Ignored by git. |
| `.binference/config.json` | The agent's cockpit, app and model. |
| `.binference/hooks/` | The hooks that apply your limits, and the launcher. |
| `start` | Starts the agent's app with its key. |
| `AGENTS.md`, `CLAUDE.md` | The agent's house rules. |
| `.claude/` and `.mcp.json`, or `.codex/` | The app's settings, hooks and skills. |

Nothing outside the folder is changed, except `baw` when you choose to install it, and
Binance's MCP Server if you connect it with Codex, which adds it for every Codex session on
the machine.

## Limits

Before each trade, the hooks read your limits from the cockpit: the most per trade, per day,
the amount above which you confirm, and which tokens it may trade. They refuse what is over a
limit, ask you about trades they cannot value, and refuse every trade while you have paused the
agent. Claude Code
asks you in its own prompt. Codex has no prompt for hooks, so you type the confirmation code
it shows.

The hooks run on your machine and guard against mistakes, not against everything. Set
Binance's own limits too, in the Binance App under Agentic Wallet, Settings. Binance suggests
$50 a day. The key's AI budget is enforced by binference.io itself.

Codex runs the hooks only after you trust the folder and approve them. `doctor` tells you
whether they have run.

## For agents and scripts

- Without a terminal, nothing prompts. A choice that is needed comes from a flag, and
  nothing is installed without `--yes`.
- `--json` puts only JSON on stdout. Errors look like
  `{"ok":false,"error":{"code":"usage","message":"...","hint":"..."}}`.
- Exit codes: 0 done, 1 failed (for `doctor`, a check failed), 2 wrong usage.
- `agent-os --no-wait --json` returns the sign-in code at once, for an agent to pass on to
  the person. `--resume` finishes the setup after they approve.
- `link-wallet` runs only in a terminal, so an agent cannot sign with the wallet itself.

## Updating

A folder keeps the hooks it was set up with. After a new release, update them from inside
the folder:

```bash
npx binference@latest doctor --fix
```

## Links

- Docs: [docs.binference.io/agent-os](https://docs.binference.io/agent-os)
- Issues: [github.com/binference/skills/issues](https://github.com/binference/skills/issues)

## License

[MIT](LICENSE)

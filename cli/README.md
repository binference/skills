<p align="center">
  <img src="https://raw.githubusercontent.com/binference/skills/cc93b0e4222c80e83030edcba09971a18cc25203/cli/assets/banner.png" alt="bInference" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/binference"><img src="https://img.shields.io/npm/v/binference?color=f0b90b&labelColor=0b0e11" alt="npm version"></a>
  <a href="https://github.com/binference/skills/actions/workflows/cli.yml"><img src="https://github.com/binference/skills/actions/workflows/cli.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/node/v/binference?color=f0b90b&labelColor=0b0e11" alt="Node.js version">
  <a href="https://github.com/binference/skills/blob/master/cli/LICENSE"><img src="https://img.shields.io/npm/l/binference?color=f0b90b&labelColor=0b0e11" alt="MIT license"></a>
</p>

<p align="center">
  <b>One folder, one agent.</b> It trades through Binance Agent OS, thinks with bInference,<br>
  and keeps to the limits you set in its cockpit on binference.io.
</p>

<p align="center">
  <a href="https://docs.binference.io/agent-os">Docs</a> ·
  <a href="https://binference.io">binference.io</a> ·
  <a href="#commands">Commands</a> ·
  <a href="https://github.com/binference/skills/issues">Issues</a>
</p>

<br>

## Quick start

```bash
npx binference agent-os my-agent
```

1. **Approve the agent.** The CLI shows a code and opens binference.io. Check that the code
   matches and approve it with your wallet. No key is ever pasted into a terminal or a chat.
2. **Connect Binance.** Binance asks you to do two steps yourself: connect its MCP Server for
   exchange trading, and sign in to the Agentic Wallet. The setup prints both.
3. **Start the agent** from its folder, this way every time:

```bash
cd my-agent && ./start
```

## What you get

- **A key with its own AI budget.** Every model call is charged to it, and binference.io
  stops the calls when the budget is spent.
- **Limits before every trade.** Most per trade, most per day, a confirmation above an amount
  you choose, and which tokens it may trade.
- **A cockpit on binference.io.** See what the agent did and spent, change its limits, and
  pause it.
- **House rules and skills.** `AGENTS.md` tells the agent how to trade, and the folder comes
  with the bInference skill plus Binance's Agentic Wallet and token audit skills.
- **Claude Code or Codex.** Pick the app that runs the agent; the folder is set up for it.

## How the limits work

Before each trade, the folder's hooks read your limits from the cockpit and check the trade
against them. They refuse what is over a limit, ask you about trades they cannot value, and
refuse every trade while the agent is paused. Claude Code asks you in its own prompt. Codex
has no prompt for hooks, so you type the confirmation code it shows.

The hooks run on your machine and catch mistakes, not everything. Set Binance's own limits
too, in the Binance App under Agentic Wallet, Settings; Binance suggests $50 a day. For
Claude Code, `--sandbox` also stops shell commands from changing the folder's limits.

Codex runs the hooks only after you trust the folder and approve them. `doctor` tells you
whether they have run.

## Commands

Run each one with `npx binference <command>`.

| Command | What it does |
| --- | --- |
| `agent-os` | Set up a folder for one agent, as in `agent-os my-agent`. |
| `doctor` | Check the folder you are in end to end, and say what to fix. |
| `start` | Start the folder's app. `./start` does the same, faster. |
| `link-wallet` | Link the agent's wallet for an on-chain track record. You sign; no funds move. |

<details>
<summary><b>agent-os</b> options</summary>

| Option | What it does |
| --- | --- |
| `--app claude\|codex` | Which app runs the agent. Needed without a terminal when both are installed. |
| `--model <id>` | Its model, any id on [binference.io/models](https://binference.io/models). |
| `--yes`, `-y` | Install Binance's wallet CLI (`baw`) without asking. |
| `--sandbox` | Turn on Claude Code's sandbox. Approve Binance's and binference.io's hosts the first time. |
| `--no-wait` | Show the sign-in code and stop. Finish later with `--resume`. |
| `--resume` | Finish a sign-in started with `--no-wait`. |
| `--json` | Print JSON events instead of text. |

</details>

<details>
<summary><b>doctor</b> options</summary>

| Option | What it does |
| --- | --- |
| `--fix` | Repair what failed. Your own settings, hooks and MCP servers are kept. |
| `--dry-run` | With `--fix`, show what would change and change nothing. |
| `--json` | Print the result as one JSON object. |

</details>

Every command takes `--help`.

## Requirements

- macOS or Linux. On Windows, use WSL2.
- Node.js 22 or newer.
- [Claude Code](https://claude.com/claude-code), or [Codex](https://developers.openai.com/codex) 0.140 or newer.

## For agents and scripts

The CLI works the same when an agent runs it:

- Without a terminal nothing prompts. Choices come from flags, and nothing is installed
  without `--yes`.
- `--json` puts only JSON on stdout. Errors look like
  `{"ok":false,"error":{"code":"usage","message":"...","hint":"..."}}`.
- Exit codes: `0` done, `1` failed (for `doctor`, a check failed), `2` wrong usage.
- `agent-os --no-wait --json` returns the sign-in code at once, for the agent to pass on.
  `--resume` finishes the setup after the person approves.
- `link-wallet` runs only in a terminal, so an agent cannot sign with the wallet.

## What the folder holds

| Path | What it holds |
| --- | --- |
| `.binference/key` | The agent's key, readable only by your user. Ignored by git. |
| `.binference/config.json` | Its cockpit, app and model. |
| `.binference/hooks/` | The hooks that apply your limits, and the launcher. |
| `start` | Starts the agent's app with its key. |
| `AGENTS.md`, `CLAUDE.md` | The agent's house rules. |
| `.claude/` and `.mcp.json`, or `.codex/` | The app's settings, hooks and skills. |

Nothing outside the folder changes, except `baw` if you choose to install it, and Binance's
MCP Server if you connect it with Codex, which adds it for every Codex session on the machine.

## Updating

A folder keeps the hooks it was set up with. After a new release, update them from inside the
folder:

```bash
npx binference@latest doctor --fix
```

## License

[MIT](https://github.com/binference/skills/blob/master/cli/LICENSE)

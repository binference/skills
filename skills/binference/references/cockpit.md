# The cockpit on Binance Agent OS

For an agent folder made by `npx binference agent-os`. The owner watches and brakes the agent at
https://binference.io/account/cockpit. bInference never trades: Binance runs every trade.

## The status block

Each session starts with lines like these:

```
bInference cockpit for "my-agent" (https://binference.io/account/cockpit?id=12):
- AI budget: $41.20 to spend, about 6.5 days at the last day's pace. This key stops at $5.00 a day ($3.10 left).
- Trade limits: at most $50.00 a trade, $200.00 a day, the person confirms above $25.00. Hooks apply them before each trade.
- Agentic Wallet: signed in. Its sign-in ends in about 2 h and Binance signs it out silently: tell the person now.
- If a hook blocks an action, tell the person the reason. Never retry it another way or split it.
```

| Line says                                       | Do                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `PAUSED by its owner`                           | No trades, no long work. The owner resumes it in the cockpit                 |
| `does not think through bInference`             | Tell the user to start the agent with `npx binference start` in its folder   |
| `key no longer works`                           | The key was revoked or the agent stopped. The user runs `npx binference doctor` |
| `could not be reached`                          | The rules are unknown: trade only with the user's explicit yes               |
| sign-in `ends in about N h`                     | Tell the user now. They sign the wallet in again                             |
| `Its daily limit is` over $1,000                | Suggest lowering it in the Binance App: Agentic Wallet → Settings            |

## Why a trade was refused

The hook's reason names the rule. Tell the user, then stop. Never split, reroute or retry it.

| Rule                 | Means                                                  | The user can                                |
| -------------------- | ------------------------------------------------------ | ------------------------------------------- |
| paused               | The owner paused the agent                             | Resume it in the cockpit                    |
| per trade (`max_trade`) | The trade is worth more than one trade may be       | Trade less, or raise the limit in the cockpit |
| per day (`day_trade`)   | It would take today's trading (UTC) over the limit  | Wait for 00:00 UTC, or raise the limit      |
| tokens (`token`)        | A token is not on the owner's list                  | Add it to the list in the cockpit           |
| confirm              | Worth more than the ask-first amount, or its value is unknown | Confirm it                         |

Raising a limit takes effect an hour later and needs a fresh wallet sign-in. Lowering one is
immediate. In Claude Code, trying the same refused trade a third time within 10 minutes ends the
turn.

## Confirming in Codex

Codex hooks cannot ask the user, so the refusal says: `Ask the person to type exactly: confirm
4821.` Pass that on word for word. When the user has typed it, run the exact same command once
more within 10 minutes. The code works once, for that command only.

## A track record

1. The user turns on Developer Mode in the Binance App (Agentic Wallet → Settings). Binance's
   wallet signs messages only with it on.
2. The user runs `npx binference link-wallet` in the agent's folder, with the wallet signed in.
   It shows the message, asks before signing, and sends no transaction.
3. The user turns Developer Mode off again.

From the next session, the hooks send the wallet's history, and each BNB Chain trade is checked
on chain: amounts against the Transfer logs, stablecoins at $1, BNB at Chainlink's price, other
tokens at the price the trade set, profit first in, first out. The user can make the record
public in the cockpit. The leaderboard lists a public record with every transaction accounted
for, 10 checked trades in the period and a wallet worth $10 or more.

State results as facts. Never present a record or the leaderboard as a reason to buy a token or
copy an agent.

## Alerts

The owner can connect Telegram in the cockpit, for messages when the wallet's sign-in is ending,
the AI budget runs low, or a limit blocked a trade. Nothing for the agent to do.

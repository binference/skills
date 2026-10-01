# Models: fields, prices and estimates

## Contents

- The fields in GET /models
- Estimating a task by hand
- What a call reserves

## The fields in GET /models

| Field                            | Meaning                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `pricing.prompt`                 | Dollars per input token                                  |
| `pricing.completion`             | Dollars per output token                                 |
| `pricing.reasoning`              | Dollars per reasoning token, charged as output           |
| `pricing.request`                | Dollars per call, on top of tokens (often `0`)           |
| `pricing.image`                  | Dollars per image the model reads, on top of tokens      |
| `pricing.image_output`           | Dollars per image token the model writes                 |
| `pricing.web_search`             | Dollars per web search, for `:online` models             |
| `architecture.input_modalities`  | What it reads: `text`, `image`, `file`, `audio`, `video` |
| `architecture.output_modalities` | What it writes: `text`, `image`                          |
| `context_length`                 | The longest input plus answer, in tokens                 |
| `max_output_tokens`              | The longest answer                                       |

Ids look like `vendor/model`. A model that is not in the list is not served. Suffixes change how a
model runs, not its price per token: `:online` (web search), `:nitro` (fastest provider),
`:floor` (cheapest provider), `:exacto` (most accurate tool calling).

`scripts/models.mjs` filters this list and sorts it by price; `scripts/budget.mjs` does the
arithmetic below.

## Estimating a task by hand

```text
cost = calls × (input_tokens × prompt + output_tokens × completion + request)
```

- Input is everything sent each call: system prompt, conversation, tool definitions and tool
  results. In an agent it grows each turn, so estimate the late calls.
- For output, use the `max_tokens` the calls will set.
- A token is about 4 characters of English, and fewer for code, numbers and other languages.

Example: a watcher that calls a model every 5 minutes for 24 hours makes 288 calls. At 3,000
input tokens and 300 output tokens per call, with a prompt price of $0.0000024 and a completion
price of $0.000012, each call costs $0.0108 and the day about $3.11. A model ten times cheaper
runs the same day for about $0.31.

Compare the total with the budget: `spendable_usd` from `GET /balance`, or the key's
`remaining_usd` when that is lower. Start only when the total is under half the budget, since
agents' inputs usually grow past the estimate.

## What a call reserves

While it runs, every call reserves its worst case from the budget: the whole input, plus
`max_tokens` of output, at the dearest provider that could serve it. When it ends, the real
charge is taken and the rest returns at once.

- Without `max_tokens`, the reserve is the model's whole output limit. That can be refused with
  `402 insufficient_balance` even when the real charge would be cents.
- Calls running at once each reserve their worst case. `spendable_usd` already subtracts what
  running calls reserve.
- Web search loops reserve for every step they could take: set `max_tool_calls` to keep it small.

# binference

A skill for agents that run on [bInference](https://binference.io): one key for hundreds of AI
models, charged to the agent's own AI budget. It checks the budget before costly work, estimates
what a task will cost, picks models by price and ability, reads and makes images, gives
sub-agents capped keys, and explains errors. In an agent folder made by `npx binference agent-os`
for Binance Agent OS, it also reads the cockpit's status and keeps to the owner's trade limits.
Instructions are in [SKILL.md](SKILL.md).

## Requirements

- A `binf_` key from https://binference.io/account/keys, in the environment as `BINF_API_KEY`.
- Network access to binference.io.
- Node.js 18 or newer for the scripts. They use no packages. Every call they make also works with
  curl, as the references show.

## Scripts

Each prints JSON on stdout, exits `0` on success and `1` on failure with
`{ "ok": false, "error": { "message" } }`, and never prints the key.

| Script               | What it does                                                                                   | Run                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `scripts/budget.mjs` | Prices a task on one or more models against the budget; with no flags, prints the budget       | `node scripts/budget.mjs --calls 288 --input 3000 --output 300 --model <id>`     |
| `scripts/models.mjs` | Lists chat models by what they read and write, or image models with `--images`, cheapest first | `node scripts/models.mjs --reads image --top 10`                                 |
| `scripts/vision.mjs` | Sends an image to a model that reads images and prints its answer                              | `node scripts/vision.mjs --model <id> --image chart.png --prompt "Describe it."` |
| `scripts/image.mjs`  | Generates images and prints a link to each, and the cost                                       | `node scripts/image.mjs --model <id> --prompt "..." --quality low`               |
| `scripts/upload.mjs` | Uploads a local image and prints a 24-hour link to send models                                 | `node scripts/upload.mjs chart.png`                                              |
| `scripts/lib.mjs`    | Shared by the others: the API address, the key, uploads and errors                             | Not run directly                                                                 |

`BINF_API_URL` changes the API address; the default is `https://binference.io/api/v1`.
`models.mjs` and pricing in `budget.mjs` need no key.

## Disclaimer

The skill and its output are informational only. They are not investment, financial or trading
advice, and do not recommend any asset.

# bInference skills

Agent skills for [bInference](https://binference.io): one API key for hundreds of AI models,
charged to an agent's own AI budget.

## Install

```bash
npx skills add binference/skills
```

The installer asks which of your agents to add the skills to, such as Claude Code, Codex or
OpenClaw.

## Skills

| Skill                                      | What it does                                                                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`binference`](skills/binference/SKILL.md) | Checks the AI budget before costly work, estimates what a task will cost, picks models by price and ability, reads and makes images (including verified trade recap cards), gives sub-agents capped keys, and explains errors |

Each skill needs a `binf_` key from [binference.io/account/keys](https://binference.io/account/keys)
in the environment as `BINF_API_KEY`. Documentation: [docs.binference.io](https://docs.binference.io).

In Claude Code, built-in skills also answer model-pricing questions. To make sure an agent on
bInference uses this one, add a line to its `CLAUDE.md`:

```text
This agent runs on bInference. Use the binference skill for AI budget, model prices and choice, sending images to models, and generating images with image models.
```

## Safety

- The key is never printed, logged or shared.
- No skill recommends or promotes any coin or token, and none posts anywhere on its own.
- Spending beyond what the user set out to spend needs the user's yes.

Everything the skills produce is informational only and not financial advice.

## Tests

[`evals/evals.json`](evals/evals.json) holds the scenarios each change is checked against.

## License

[MIT](LICENSE)

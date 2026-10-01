# The bInference MCP server

Gives the agent its own budget, usage, limits and keys as tools, with the same `binf_` key it uses
for model calls. The tools spend no credit.

Address: `https://binference.io/api/mcp`. These commands name the server `binference`, so its tools
are `binference:get_balance`, `binference:create_key` and so on.

## Connect

Claude Code:

```bash
claude mcp add --transport http binference https://binference.io/api/mcp --header "Authorization: Bearer $BINF_API_KEY"
```

Codex CLI:

```bash
codex mcp add binference --url https://binference.io/api/mcp --bearer-token-env-var BINF_API_KEY
```

Other clients: streamable HTTP, with `Authorization: Bearer <key>` on every request. There is no
OAuth sign-in.

## Tools

| Tool                       | Inputs                                              | Returns                                                                  |
| -------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| `binference:get_balance`   | none                                                | Budget, what running calls reserve, what expires when                    |
| `binference:get_limits`    | none                                                | The key's limit; the agent's call, request and image limits              |
| `binference:get_usage`     | `days`, 1 to 90, default 7                          | Spend by day and by model                                                |
| `binference:list_calls`    | `key_id`, `limit` (1 to 50, default 20), `before`   | Recent calls: model, outcome, error code, tokens, charge                 |
| `binference:list_keys`     | none                                                | Active keys, their limits and this month's spend                         |
| `binference:create_key`    | `label`, optional `spending_limit` (`usd`, `reset`) | A new key, shown once                                                    |
| `binference:update_key`    | `key_id`, `label` and/or `spending_limit`           | Renames a key, or sets, changes or removes its limit (`null` removes it) |
| `binference:revoke_key`    | `key_id`                                            | Revokes a key; calls already running finish                              |
| `binference:create_upload` | `content_type`, `size` in bytes                     | A link to upload one image to, and its 24-hour link for models           |

`spending_limit.usd` is a number from `0.01`, and `spending_limit.reset` is `daily`, `weekly` or
`monthly`. Periods start at 00:00 UTC, weeks on Monday.

## Rules

- `create_key`, `update_key` and `revoke_key` need a key without a spending limit. A key with a
  limit only reads, so it can never make itself a key without one.
- `create_key` returns the key once. Put it straight into an environment variable or secret store,
  never into the conversation.
- An agent may have 10 active keys, and make 20 over MCP in any 24 hours.
- 60 MCP requests a minute per key. A faster key gets `429` with the wait in `retry-after`.

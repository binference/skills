# The bInference API

Base URL `${BINF_API_URL:-https://binference.io/api/v1}`. Send the key as
`Authorization: Bearer $BINF_API_KEY` (or `x-api-key`). Bodies are JSON, up to 4 MB.

## Contents

- Endpoints
- GET /balance
- GET /models
- A model call
- Limits

## Endpoints

| Method | Path                | What it does                                      | Key |
| ------ | ------------------- | ------------------------------------------------- | --- |
| `GET`  | `/balance`          | What the key can spend now                        | Yes |
| `GET`  | `/models`           | Every model, what it reads and writes, its prices | No  |
| `POST` | `/chat/completions` | OpenAI Chat Completions                           | Yes |
| `POST` | `/responses`        | OpenAI Responses                                  | Yes |
| `POST` | `/messages`         | Anthropic Messages                                | Yes |
| `GET`  | `/images/models`    | Every image model, its fields and prices          | No  |
| `POST` | `/images`           | Make images                                       | Yes |
| `POST` | `/uploads`          | A link to upload one image to                     | Yes |

## GET /balance

```bash
curl -s "${BINF_API_URL:-https://binference.io/api/v1}/balance" \
  -H "Authorization: Bearer $BINF_API_KEY"
```

```json
{
  "object": "balance",
  "agent": { "id": 42, "name": "Nova", "token": null, "status": "active" },
  "spendable_usd": "18.40211",
  "balance_usd": "18.42211",
  "reserved_usd": "0.02",
  "running_calls": 1,
  "expiring": [{ "at": "2026-10-02T00:00:00.000Z", "usd": "2.1084" }],
  "key_limit": {
    "limit_usd": "5",
    "reset": "daily",
    "spent_usd": "1.2",
    "reserved_usd": "0.02",
    "remaining_usd": "3.78",
    "resets_at": "2026-10-03T00:00:00.000Z"
  }
}
```

- `spendable_usd`: what new calls can reserve now, the balance less what running calls reserve.
- `key_limit`: this key's own limit, or `null`. When set, the budget is the lower of
  `spendable_usd` and `remaining_usd`.
- `expiring`: what is left of each day's credit and when it expires, soonest first. Credit is
  spent oldest first and lasts 7 days.
- Amounts are dollars as exact decimal strings: compare them as numbers, not as text.

## GET /models

No key needed. One entry, as an example of the shape:

```json
{
  "id": "anthropic/claude-sonnet-5.5",
  "name": "Anthropic: Claude Sonnet 5.5",
  "architecture": {
    "input_modalities": ["text", "image", "file"],
    "output_modalities": ["text"]
  },
  "context_length": 1000000,
  "max_output_tokens": 128000,
  "pricing": {
    "prompt": "0.0000024",
    "completion": "0.000012",
    "reasoning": "0.000012",
    "request": "0",
    "image": "0",
    "image_output": "0",
    "web_search": "0.012"
  }
}
```

Prices are dollars per token (per call, image or search where named), fee included: exactly what
a call is charged. Field by field: [models.md](models.md).

## A model call

Each format works as its official API does, streaming included. Always set an output limit.

```bash
curl -s "${BINF_API_URL:-https://binference.io/api/v1}/chat/completions" \
  -H "Authorization: Bearer $BINF_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model id>",
    "messages": [{ "role": "user", "content": "Summarize this in one line." }],
    "max_tokens": 256
  }'
```

- `usage.cost` is what the call was charged, in dollars. Chat Completions, Responses and the Image
  API carry it; Anthropic Messages does not, so use `binference:get_usage` there.
- On streamed Chat Completions, add `"stream_options": { "include_usage": true }` to get the
  cost in the last chunk.
- The `x-binference-call-id` header names the call on https://binference.io/account/calls.

## Limits

- 600 calls a minute per agent, and 8 running at once.
- A streamed call may run 30 minutes; one that is not streamed, 13.
- Error codes and what to do about each: [errors.md](errors.md).

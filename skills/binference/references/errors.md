# Errors

Every error has a stable `code`. Chat Completions, Responses and the Image API answer
`{ "error": { "message", "type", "code" } }`; Anthropic Messages answers
`{ "type": "error", "error": { "type", "message", "code" } }`. The message says what happened,
often with the numbers.

A call refused before the model runs costs nothing. A provider failure costs only what the provider
recorded, usually nothing.

## Contents

- Budget and pace
- The request
- Busy or down

## Budget and pace

| Status | Code                     | Meaning                                                   | Do                                                                             |
| ------ | ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `402`  | `insufficient_balance`   | The budget is below this call's reserve                   | Lower `max_tokens`, use a cheaper model, wait for running calls, or add credit |
| `402`  | `key_limit`              | This key's limit for the period is used                   | Wait for the reset in the message, or ask the owner to raise it                |
| `400`  | `request_over_capacity`  | One call reserves more than one agent may reserve at once | Lower `max_tokens`                                                             |
| `429`  | `rate_limited`           | Over 600 calls a minute                                   | Wait `retry-after-ms`                                                          |
| `429`  | `too_many_running_calls` | 8 calls already running                                   | Wait for one to finish                                                         |
| `429`  | `too_much_reserved`      | Running calls already reserve the most one agent may      | Wait for one to finish                                                         |
| `429`  | `daily_share_used`       | The agent used its fair share of a busy day               | Wait `retry-after-ms`                                                          |
| `429`  | `upload_limit`           | 200 uploads in the last 24 hours                          | Wait, or reuse an upload's link                                                |
| `429`  | `link_storage_full`      | 5 GB of image links held                                  | Leave out `response_format`, or wait for links to expire                       |

## The request

| Status | Code                    | Meaning                                            | Do                                                   |
| ------ | ----------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `401`  | `invalid_api_key`       | Missing, wrong or revoked key                      | Check `BINF_API_KEY`                                 |
| `403`  | `agent_inactive`        | The agent is not active yet                        | The owner activates it on its page                   |
| `400`  | `invalid_request`       | The body is malformed, or a field is not accepted  | Read the message; it names the field                 |
| `400`  | `unknown_model`         | No model has this id                               | Copy an id from `GET /models`                        |
| `400`  | `model_not_served`      | Free, batch and router models, some image models   | Use the paid model's own id                          |
| `400`  | `model_no_image_input`  | Images sent to a model that cannot read them       | Choose a model that reads `image`                    |
| `400`  | `image_type_not_served` | An inline image that is not PNG, JPEG, WebP or GIF | Convert it, or send it by link                       |
| `400`  | `tool_not_served`       | A hosted tool the gateway does not run             | Remove it, or run the tool yourself                  |
| `413`  | `request_too_large`     | The body is over 4 MB                              | Send images and files by link (`scripts/upload.mjs`) |

## Busy or down

Wait the `retry-after-ms` the answer names before sending the same call again.

| Status        | Code                                                                | Do                                           |
| ------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| `503` / `529` | `model_busy` (`529 overloaded_error` on Messages)                   | Wait, or switch to a fallback model          |
| `503`         | `gateway_busy`, `gateway_capacity`, `gateway_unavailable`           | Wait                                         |
| `503`         | `catalog_unavailable`, `service_unavailable`, `storage_unavailable` | Retry shortly                                |
| `502` / `504` | `provider_error`, `upstream_unreachable`, `upstream_timeout`        | Retry once; if it repeats, use another model |

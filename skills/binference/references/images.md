# Images: reading, uploading and making them

## Contents

- Reading an image
- Uploading a large or local image
- Making an image
- Recap cards

## Reading an image

Send it in the message, in the format's own shape, to a model with `image` in
`architecture.input_modalities`:

| Format           | Part                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| Chat Completions | `{ "type": "image_url", "image_url": { "url": "<link or data URL>" } }` |
| Responses        | `{ "type": "input_image", "image_url": "<link or data URL>" }`          |
| Messages         | `{ "type": "image", "source": { "type": "url", "url": "<link>" } }`     |

- A link, or the image itself as a `data:image/png;base64,...` URL.
- PNG, JPEG, WebP or GIF. Another inline type answers `400 image_type_not_served`.
- Images sent to a model that cannot read them answer `400 model_no_image_input`, before anything
  is reserved.
- A request body is at most 4 MB, and base64 makes a file a third bigger: send larger images by
  link.

## Asking a model about an image

```bash
node scripts/vision.mjs --model <id> --image chart.png --prompt "Describe the trend in two sentences."
```

It prints `answer`, `finish_reason` and `usage.cost_usd`. A local image up to 2.5 MB goes inline
and a larger one is uploaded first; `--image` also takes an https link. `--max-tokens` defaults to
1,000, since reasoning models spend part of it thinking: when `finish_reason` is `length`, run
again with more.

## Uploading a large or local image

```bash
node scripts/upload.mjs chart.png
```

It checks the file's type by its bytes, asks for an upload link, sends the file and prints:

```json
{
  "ok": true,
  "url": "https://...",
  "expires_at": "2026-10-02T12:00:00.000Z",
  "content_type": "image/png",
  "size": 3400000
}
```

Send `url` as the image in any model call. It works for 24 hours, then the image is deleted. Up to
20 MB an image and 200 uploads per agent a day, for an agent with credit.

Without Node: `POST /uploads` with `{ "content_type": "image/png", "size": <exact bytes> }`, then
PUT the bytes to `upload_url` with `upload_headers`, then use `url`. Storage refuses a file of
another type or size. Over MCP, `binference:create_upload` does the first step.

## Making an image

List the models, cheapest first, with their fields and prices:

```bash
node scripts/models.mjs --images --top 10
```

Or the raw list: `GET /images/models`, whose entries are in `data`. Each entry has `parameters` (the fields it takes, with their values or ranges), `reads_images`,
`streaming` and `pricing` (lines such as
`{ "billable": "output_image", "unit": "image", "usd": "0.0084" }`, some for one tier or quality
only).

```bash
curl -s "${BINF_API_URL:-https://binference.io/api/v1}/images" \
  -H "Authorization: Bearer $BINF_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<id from /images/models>",
    "prompt": "<what to draw>",
    "response_format": "url"
  }'
```

- `data[]` holds each image: `url` and `expires_at` (7 days) with `response_format: "url"`, or
  `b64_json` without it. `usage.cost` is the charge.
- `n` makes several at once, up to the model's own maximum in `parameters.n`.
- The call reserves every image it asks for at the model's highest price for the `resolution` and
  `quality` given, or the largest the model offers when they are left out. Set them to reserve
  less.
- `input_references` takes images to edit or follow, on models with `reads_images: true`.
- `stream: true` sends partial images, one image per call, on models with `streaming: true`.
- A failed generation costs nothing.

## Recap cards

1. **Collect the facts:** pair, side, entry, exit, size, PnL and period, from the user or the
   trading tools. Never invent or round a number the user did not round.
2. **Generate** it. Start with a cheap image model; move to a stronger one if the text still
   renders badly after two tries.

   ```bash
   node scripts/image.mjs --model <id from /images/models> --prompt 'A clean, minimal trading recap card, dark background, portrait.
   Title: "BNB/USDT recap". Rows, large and legible:
   Side: Buy. Entry: 600.00. Exit: 642.00. PnL: +7.00%. Period: Oct 1 to Oct 3.
   Flat design. No logos, no other text, no charts with made-up data.'
   ```

3. **Check** the card with a model that reads images, then compare its answer with the facts line
   by line:

   ```bash
   node scripts/vision.mjs --model <id that reads image> --image <card url> \
     --prompt "List every label and number on this card exactly as printed, one per line."
   ```

4. **Regenerate** while any number or label differs. After three failed tries, tell the user and
   show the closest card with the differences named.
5. **Show** the card. To publish it on Binance Square, hand it to the `square-post` skill after
   the user approves. This skill never posts.

Keep cards factual: no advice, no forecasts, no call to buy or sell, and no wallet addresses.

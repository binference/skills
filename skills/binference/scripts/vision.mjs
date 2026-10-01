#!/usr/bin/env node
// Sends one image to a model that reads images, with a question, and prints the answer.
//
//   node scripts/vision.mjs --model <id> --image chart.png --prompt "Describe the trend."
//   node scripts/vision.mjs --model <id> --image https://... --prompt "List every number."
//
// --model       a chat model that reads images: an id from scripts/models.mjs --reads image,
//               not an image generation model
// --image       a local file or an https link
// --prompt      the question
// --max-tokens  the longest answer, default 1000. Reasoning models spend part of it thinking.
//
// A local image up to 2.5 MB goes inline; a larger one is uploaded first and sent by link.
// Prints JSON: the answer and what the call cost.

import { api, done, fail, flags, MODEL_TIMEOUT_MS, readImage, uploadImage, usd } from "./lib.mjs";

// Base64 makes a file a third bigger, and a request body is at most 4 MB: 2.5 MB of image
// becomes 3.3 MB inline, which leaves room for the rest of the request.
const MAX_INLINE_BYTES = 2.5 * 1024 * 1024;
// Enough for a full answer from a reasoning model, which thinks before it writes; on a cheap
// vision model 1,000 output tokens cost a fraction of a cent.
const DEFAULT_MAX_TOKENS = 1000;

const args = flags(process.argv.slice(2));
if (!args.model)
  fail(
    "Name a model that reads images: --model <id>. List them with scripts/models.mjs --reads image.",
  );
if (!args.image) fail("Name the image: --image <file or https link>.");
if (!args.prompt) fail('Ask a question: --prompt "...".');
const maxTokens =
  args["max-tokens"] === undefined ? DEFAULT_MAX_TOKENS : Number(args["max-tokens"]);
if (!Number.isInteger(maxTokens) || maxTokens < 1)
  fail("--max-tokens must be a whole number of 1 or more.");

let url;
let sent;
if (/^https?:\/\//i.test(args.image)) {
  url = args.image;
  sent = "link";
} else {
  const image = await readImage(args.image);
  if (image.bytes.length <= MAX_INLINE_BYTES) {
    url = `data:${image.type};base64,${image.bytes.toString("base64")}`;
    sent = "inline";
  } else {
    url = (await uploadImage(image)).url;
    sent = "uploaded";
  }
}

const answer = await api("/chat/completions", {
  method: "POST",
  timeoutMs: MODEL_TIMEOUT_MS,
  body: {
    model: args.model,
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: args.prompt },
          { type: "image_url", image_url: { url } },
        ],
      },
    ],
  },
});

const finish = answer.choices?.[0]?.finish_reason ?? null;
done({
  ok: true,
  model: answer.model ?? args.model,
  image_sent: sent,
  answer: answer.choices?.[0]?.message?.content ?? null,
  finish_reason: finish,
  note:
    finish === "length"
      ? `The answer stopped at ${maxTokens} tokens and may be cut off. Run again with a higher --max-tokens.`
      : undefined,
  usage: {
    prompt_tokens: answer.usage?.prompt_tokens ?? null,
    completion_tokens: answer.usage?.completion_tokens ?? null,
    cost_usd: typeof answer.usage?.cost === "number" ? usd(answer.usage.cost) : null,
  },
});

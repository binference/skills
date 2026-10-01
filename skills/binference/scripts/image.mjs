#!/usr/bin/env node
// Generates images with an image model and prints a link to each, and what the call cost.
//
//   node scripts/image.mjs --model <id> --prompt "A clean recap card ..." --quality low
//
// --model         an id from GET /images/models
// --prompt        what to draw
// --n             how many, default 1, up to the model's own maximum
// --resolution    512, 1K, 2K or 4K, when the model lists it
// --quality       low, medium, high, ..., when the model lists it
// --aspect-ratio  such as 1:1, 4:5 or 16:9, from the model's listed values
// --out           a folder to save the images in, besides printing their links
//
// The call reserves every image it asks for at the model's highest price for the resolution
// and quality given, or the largest the model offers when they are left out: set them.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { api, done, fail, flags, MODEL_TIMEOUT_MS, usd } from "./lib.mjs";

const args = flags(process.argv.slice(2));
if (!args.model) fail("Name an image model: --model <id>, from GET /images/models.");
if (!args.prompt) fail('Say what to draw: --prompt "...".');

const body = { model: args.model, prompt: args.prompt, response_format: "url" };
if (args.n !== undefined) body.n = Number(args.n);
if (args.resolution) body.resolution = args.resolution;
if (args.quality) body.quality = args.quality;
if (args["aspect-ratio"]) body.aspect_ratio = args["aspect-ratio"];

const answer = await api("/images", { method: "POST", body, timeoutMs: MODEL_TIMEOUT_MS });

const images = [];
for (const [index, item] of (answer.data ?? []).entries()) {
  const entry = {
    url: item.url ?? null,
    media_type: item.media_type ?? null,
    expires_at: item.expires_at ?? null,
  };
  if (args.out) {
    await mkdir(args.out, { recursive: true });
    const ext = (item.media_type ?? "image/png")
      .split("/")[1]
      .replace("jpeg", "jpg")
      .replace("svg+xml", "svg");
    const file = join(args.out, `image-${index + 1}.${ext}`);
    const bytes = item.b64_json
      ? Buffer.from(item.b64_json, "base64")
      : Buffer.from(
          await (await fetch(item.url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer(),
        );
    await writeFile(file, bytes);
    entry.file = file;
  }
  images.push(entry);
}
if (images.length === 0) fail("The model returned no image.");

done({
  ok: true,
  model: args.model,
  images,
  cost_usd: typeof answer.usage?.cost === "number" ? usd(answer.usage.cost) : null,
});

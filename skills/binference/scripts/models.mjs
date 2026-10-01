#!/usr/bin/env node
// Lists models, cheapest first: chat models from GET /models, or image models from
// GET /images/models with --images.
//
//   node scripts/models.mjs --reads image --top 10
//   node scripts/models.mjs --search claude
//   node scripts/models.mjs --images --top 10
//
// --reads   text, image, file or audio: keep models that read it
// --writes  text or image: keep models that write it
// --search  keep ids or names containing this text
// --images  list image generation models instead, for scripts/image.mjs
// --top     how many to print, default 15
//
// Chat prices are dollars per million tokens, fee included, sorted by the price of one call
// with 4 input tokens for every output token, a common shape for agent calls. Image models are
// sorted by an estimate of one image at the smallest tier the model lists.

import { api, done, fail, flags } from "./lib.mjs";

const INPUT_PER_OUTPUT = 4;

const args = flags(
  {
    reads: { type: "string" },
    writes: { type: "string" },
    search: { type: "string" },
    images: { type: "boolean" },
    top: { type: "string" },
  },
  "node scripts/models.mjs [--reads text|image|file|audio] [--writes text|image] [--search TEXT] [--images] [--top N]",
);
const top = args.top === undefined ? 15 : Number(args.top);
if (!Number.isInteger(top) || top < 1) fail("--top must be a whole number of 1 or more.");

const search = args.search?.toLowerCase();

// One image at about a megapixel: what the cheapest tier of most models makes. Models priced by
// the token write about 1,300 tokens for such an image at default quality.
const IMAGE_MEGAPIXELS = 1.05;
const IMAGE_TOKENS = 1300;

if (args.images) {
  const { data } = await api("/images/models", { auth: false });
  const rows = data
    .filter(
      (model) =>
        !search ||
        model.id.toLowerCase().includes(search) ||
        model.name.toLowerCase().includes(search),
    )
    .map((model) => {
      const out = model.pricing.filter((line) => line.billable === "output_image");
      const per = (unit, times) =>
        out.filter((line) => line.unit === unit).map((line) => Number(line.usd) * times);
      const estimates = [
        ...per("image", 1),
        ...per("megapixel", IMAGE_MEGAPIXELS),
        ...per("token", IMAGE_TOKENS),
      ];
      const parameters = model.parameters ?? {};
      return {
        id: model.id,
        name: model.name,
        estimated_usd_per_image: estimates.length
          ? Math.round(Math.min(...estimates) * 1e5) / 1e5
          : null,
        reads_images: model.reads_images,
        streaming: model.streaming,
        max_images: parameters.n?.max ?? 1,
        resolution: parameters.resolution?.values ?? null,
        quality: parameters.quality?.values ?? null,
        aspect_ratio: parameters.aspect_ratio?.values ?? null,
        pricing: model.pricing,
      };
    })
    .sort(
      (a, b) => (a.estimated_usd_per_image ?? Infinity) - (b.estimated_usd_per_image ?? Infinity),
    )
    .slice(0, top);
  done({ ok: true, count: rows.length, image_models: rows });
}

const { data } = await api("/models", { auth: false });

const rows = data
  .filter((model) => model.pricing)
  .filter((model) => !args.reads || model.architecture?.input_modalities?.includes(args.reads))
  .filter((model) => !args.writes || model.architecture?.output_modalities?.includes(args.writes))
  .filter(
    (model) =>
      !search ||
      model.id.toLowerCase().includes(search) ||
      model.name.toLowerCase().includes(search),
  )
  .map((model) => {
    const prompt = Number(model.pricing.prompt) * 1e6;
    const completion = Number(model.pricing.completion) * 1e6;
    return {
      id: model.id,
      name: model.name,
      prompt_per_mtok_usd: Math.round(prompt * 1e4) / 1e4,
      completion_per_mtok_usd: Math.round(completion * 1e4) / 1e4,
      context_length: model.context_length,
      max_output_tokens: model.max_output_tokens,
      reads: model.architecture?.input_modalities ?? [],
      writes: model.architecture?.output_modalities ?? [],
      sort: INPUT_PER_OUTPUT * prompt + completion,
    };
  })
  .sort((a, b) => a.sort - b.sort)
  .slice(0, top)
  .map(({ sort, ...row }) => row);

done({ ok: true, count: rows.length, models: rows });

// Shared by the bInference skill's scripts: the API address, the key, and one way to call the
// API and to fail. Node.js 18 or newer, no packages. The key is read from BINF_API_KEY and is
// never printed, logged or written anywhere.

import { readFile } from "node:fs/promises";

export const API_URL = (process.env.BINF_API_URL ?? "https://binference.io/api/v1").replace(
  /\/+$/,
  "",
);

// Reads such as the budget and the model lists answer in under a second: 30 seconds without an
// answer means the request is failing, not slow.
const READ_TIMEOUT_MS = 30_000;

/**
 * How long a model call may take before the script gives up. Image generation and reasoning
 * models can take minutes; the API itself ends a call that does not stream at 13 minutes.
 */
export const MODEL_TIMEOUT_MS = 10 * 60_000;

export function key() {
  const value = process.env.BINF_API_KEY?.trim();
  return value ? value : null;
}

/** Prints the result as JSON on stdout and exits 0. */
export function done(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

/** Prints `{ ok: false, error }` as JSON on stdout and exits 1. */
export function fail(message, extra = {}) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { message, ...extra } }, null, 2)}\n`);
  process.exit(1);
}

/**
 * Calls the API and returns its JSON. A non-2xx answer fails with the API's own code and
 * message, which already say what to do.
 */
export async function api(
  path,
  { method = "GET", body, auth = true, timeoutMs = READ_TIMEOUT_MS } = {},
) {
  const headers = { accept: "application/json" };
  if (auth) {
    const value = key();
    if (!value) fail("Set BINF_API_KEY to a binf_ key from https://binference.io/account/keys.");
    headers.authorization = `Bearer ${value}`;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail(`Could not reach ${API_URL}: ${error.message}`);
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    fail(`The answer from ${path} broke off: ${error.message}. Retry once.`);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: reported below with the status.
  }
  if (!response.ok) {
    const error = json?.error ?? {};
    fail(error.message ?? `HTTP ${response.status}`, {
      status: response.status,
      code: error.code ?? null,
      retry_after_ms: Number(response.headers.get("retry-after-ms")) || null,
    });
  }
  if (json === null) fail(`Expected JSON from ${path}, got HTTP ${response.status}.`);
  return json;
}

/** Command-line flags: `--name value`, repeatable ones collected into arrays. */
export function flags(argv, repeatable = []) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      (out._ ??= []).push(arg);
      continue;
    }
    const name = arg.slice(2);
    const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    if (repeatable.includes(name)) (out[name] ??= []).push(value);
    else out[name] = value;
  }
  return out;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** An image's type from its first bytes, or null when it is not PNG, JPEG, WebP or GIF. */
export function imageType(bytes) {
  const starts = (...signature) => signature.every((byte, at) => bytes[at] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return null;
}

/** Reads a local image and checks its type and size, failing with what to do. */
export async function readImage(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    fail(`Could not read ${path}: ${error.message}`);
  }
  const type = imageType(bytes);
  if (!type) fail(`${path} is not a PNG, JPEG, WebP or GIF image. Convert it first.`);
  if (bytes.length > MAX_UPLOAD_BYTES) {
    fail(
      `${path} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the most is 20 MB. Resize it first.`,
    );
  }
  return { bytes, type };
}

/** Uploads image bytes and returns the API's upload record: `url`, `expires_at` and more. */
export async function uploadImage({ bytes, type }) {
  const upload = await api("/uploads", {
    method: "POST",
    body: { content_type: type, size: bytes.length },
  });
  let put;
  try {
    put = await fetch(upload.upload_url, {
      method: upload.upload_method ?? "PUT",
      headers: upload.upload_headers,
      body: bytes,
      // A 20 MB upload on a slow connection can take a minute or two.
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    fail(`The upload failed: ${error.message}`);
  }
  if (!put.ok) fail(`Storage refused the upload: HTTP ${put.status}.`, { status: put.status });
  return upload;
}

/** Dollars rounded up to six places, as the API shows amounts. */
export function usd(value) {
  return Math.ceil(value * 1e6) / 1e6;
}

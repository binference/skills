#!/usr/bin/env node
// Uploads one local image and prints the link to send any model in its place.
//
//   node scripts/upload.mjs chart.png
//
// For an image over 4 MB, or one only on disk. PNG, JPEG, WebP or GIF, up to 20 MB, checked by
// its bytes. The link works for 24 hours, then the image is deleted.

import { done, fail, flags, readImage, uploadImage } from "./lib.mjs";

const path = flags(process.argv.slice(2))._?.[0];
if (!path) fail("Name the image to upload: node scripts/upload.mjs <file>");

const image = await readImage(path);
const upload = await uploadImage(image);
done({
  ok: true,
  url: upload.url,
  expires_at: upload.expires_at,
  content_type: image.type,
  size: image.bytes.length,
});

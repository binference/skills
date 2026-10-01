// Before `npm pack` or `npm publish`: copies the bInference skill next to the CLI, so the
// published package carries the skill it installs into each folder.
import { cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(cli, "skills"), { recursive: true, force: true });
cpSync(join(cli, "..", "skills", "binference"), join(cli, "skills", "binference"), { recursive: true });

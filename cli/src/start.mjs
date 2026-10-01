// `npx binference start`: launches the folder's app on bInference. The folder's own
// `./start` runs the same launcher without npx, which is about a second faster.

import { launch } from "../hooks/launch.mjs";
import { CliError } from "./errors.mjs";

export async function start({ folder, args }) {
  try {
    await launch({ folder, args });
  } catch (error) {
    throw new CliError(error.code ?? "launch_failed", error.message);
  }
}

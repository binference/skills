// Terminal output: one style for every command. Plain text when the output is not a
// terminal or NO_COLOR is set.

import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (style, text) => (color ? styleText(style, text) : text);

export const bold = (text) => paint("bold", text);
export const dim = (text) => paint("dim", text);
export const yellow = (text) => paint("yellow", text);

const MARK = { ok: paint("green", "✓"), fail: paint("red", "✗"), todo: paint("yellow", "○"), info: dim("·") };

export function title(text) {
  process.stdout.write(`\n${bold(text)}\n`);
}

export function line(text = "") {
  process.stdout.write(`${text}\n`);
}

/** One checklist line: ok, fail, todo (the person's own step) or info. */
export function check(kind, text, detail) {
  process.stdout.write(`  ${MARK[kind] ?? MARK.info} ${text}${detail ? dim(`  ${detail}`) : ""}\n`);
}

/** A command the person runs themselves, on its own line so it copies cleanly. */
export function command(text) {
  process.stdout.write(`\n    ${yellow(text)}\n\n`);
}

export function fail(message) {
  process.stderr.write(`\n${paint("red", "✗")} ${message}\n\n`);
  process.exit(1);
}

/** A yes/no question; the default when the input is not a terminal. */
export async function confirm(question, fallback = true) {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  ${question} ${dim(fallback ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
    if (answer === "") return fallback;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** One choice from a short list, by number; the first when the input is not a terminal. */
export async function choose(question, options) {
  if (!process.stdin.isTTY || options.length === 1) return options[0].value;
  line(`  ${question}`);
  options.forEach((option, index) => line(`    ${index + 1}. ${option.label}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const picked = Number((await rl.question(`  ${dim(`1 to ${options.length}, Enter for 1:`)} `)).trim() || "1");
      if (Number.isInteger(picked) && picked >= 1 && picked <= options.length) return options[picked - 1].value;
    }
  } finally {
    rl.close();
  }
}

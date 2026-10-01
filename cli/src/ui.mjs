// Terminal output: one style for every command. Colors only on a terminal, never with
// NO_COLOR or TERM=dumb (FORCE_COLOR forces them). With --json, nothing human is printed:
// stdout carries only JSON, for agents and scripts.

import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";

let json = false;

export function setJson(on) {
  json = Boolean(on);
}

export const isJson = () => json;

/** A person can answer prompts: stdin and stdout are a terminal, not CI, not --json. */
export const interactive = () => !json && Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;

function colorOn(stream) {
  if (process.env.NO_COLOR || process.env.TERM === "dumb") return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(stream.isTTY);
}

const paint = (style, text, stream = process.stdout) =>
  colorOn(stream) ? styleText(style, text, { validateStream: false }) : text;

export const bold = (text) => paint("bold", text);
export const dim = (text) => paint("dim", text);
export const yellow = (text) => paint("yellow", text);

const MARK = { ok: ["green", "✓"], fail: ["red", "✗"], todo: ["yellow", "○"], info: ["dim", "·"] };

const out = (text) => {
  if (!json) process.stdout.write(text);
};

export function title(text) {
  out(`\n${bold(text)}\n`);
}

export function line(text = "") {
  out(`${text}\n`);
}

/** One checklist line: ok, fail, todo (the person's own step) or info. */
export function check(kind, text, detail) {
  const [style, mark] = MARK[kind] ?? MARK.info;
  out(`  ${paint(style, mark)} ${text}${detail ? dim(`  ${detail}`) : ""}\n`);
}

/** A command the person runs themselves, on its own line so it copies cleanly. */
export function command(text) {
  out(`\n    ${yellow(text)}\n\n`);
}

/** One JSON value on its own line of stdout, only with --json. */
export function emit(value) {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** An error for a person: on stderr, with what to do next. */
export function printError(message, hint) {
  const mark = paint("red", "✗", process.stderr);
  process.stderr.write(`\n${mark} ${message}\n${hint ? `  ${hint}\n` : ""}\n`);
}

/**
 * A yes/no question. Null when no person can answer (no terminal, CI or --json): the caller
 * then needs a flag such as --yes, and never assumes a yes.
 */
export async function confirm(question, { defaultYes = false } = {}) {
  if (!interactive()) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  ${question} ${dim(defaultYes ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** One choice from a short list, by number. Null when no person can answer. */
export async function choose(question, options) {
  if (options.length === 1) return options[0].value;
  if (!interactive()) return null;
  line(`  ${question}`);
  for (const [index, option] of options.entries()) line(`    ${index + 1}. ${option.label}`);
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

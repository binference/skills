// Errors the CLI explains: a stable code for scripts and agents, a message, what to do next
// and an exit code. Commands throw them; one handler in cli.mjs prints them.
//
// Exit codes: 0 done, 1 failed (or `doctor` found problems), 2 wrong usage.

export class CliError extends Error {
  constructor(code, message, { hint, exitCode = 1 } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export const usageError = (message, hint) => new CliError("usage", message, { hint, exitCode: 2 });

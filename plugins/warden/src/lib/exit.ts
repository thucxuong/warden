// Exit codes (spec 3.3) and the error type commands throw to stop with one.
export const EXIT = {
  OK: 0,
  REJECTED: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  BUSY: 4,
  PORT_IN_USE: 5,
  NOT_HUMAN: 6,
  NO_BUN: 127,
} as const;

export class WardenError extends Error {
  readonly code: number;

  constructor(message: string, code: number = EXIT.REJECTED) {
    super(message);
    this.name = "WardenError";
    this.code = code;
  }
}

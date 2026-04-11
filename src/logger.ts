export type LogLevel = "silent" | "normal" | "verbose";

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  normal: 1,
  verbose: 2,
};

const ESC = "\x1b";
const RESET = `${ESC}[0m`;

export const c = {
  reset: (s: string) => `${RESET}${s}${RESET}`,
  bold: (s: string) => `${ESC}[1m${s}${RESET}`,
  dim: (s: string) => `${ESC}[2m${s}${RESET}`,
  green: (s: string) => `${ESC}[32m${s}${RESET}`,
  red: (s: string) => `${ESC}[31m${s}${RESET}`,
  yellow: (s: string) => `${ESC}[33m${s}${RESET}`,
  cyan: (s: string) => `${ESC}[36m${s}${RESET}`,
  gray: (s: string) => `${ESC}[90m${s}${RESET}`,
};

class Logger {
  private _level: LogLevel = "normal";

  setLevel(level: LogLevel): void {
    this._level = level;
  }

  getLevel(): LogLevel {
    return this._level;
  }

  // Always shown unless silent
  info(msg: string): void {
    if (LEVELS[this._level] >= LEVELS.normal) {
      console.log(msg);
    }
  }

  // Only shown in verbose mode
  debug(msg: string): void {
    if (LEVELS[this._level] >= LEVELS.verbose) {
      console.log(c.gray(msg));
    }
  }

  // Raw write (no newline) — respects normal+
  write(msg: string): void {
    if (LEVELS[this._level] >= LEVELS.normal) {
      process.stdout.write(msg);
    }
  }
}

export const logger = new Logger();

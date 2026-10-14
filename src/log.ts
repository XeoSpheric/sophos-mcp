// Minimal leveled logger writing JSON (or plain) lines to the console.

const LEVELS = ["error", "warn", "info", "debug"] as const;
type Level = (typeof LEVELS)[number];

let threshold = 2;
let json = true;

export function configureLog(level: string | undefined, format: string | undefined): void {
  const i = LEVELS.indexOf((level ?? "info") as Level);
  threshold = i < 0 ? 2 : i;
  json = format !== "simple";
}

export function enabled(level: Level): boolean {
  return LEVELS.indexOf(level) <= threshold;
}

function write(level: Level, msg: string): void {
  if (!enabled(level)) return;
  const ts = new Date().toISOString();
  const line = json
    ? JSON.stringify({ level, message: msg, timestamp: ts })
    : `${ts} [${level.toUpperCase()}]: ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  error: (msg: string) => write("error", msg),
  warn: (msg: string) => write("warn", msg),
  info: (msg: string) => write("info", msg),
  /** Pass a thunk for messages that are costly to build. */
  debug: (msg: string | (() => string)) => {
    if (enabled("debug")) write("debug", typeof msg === "function" ? msg() : msg);
  },
};

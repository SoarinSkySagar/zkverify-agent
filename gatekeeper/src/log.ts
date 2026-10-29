// Structured JSON logs to stdout. Callers pass only explicit, non-secret fields;
// as a backstop, any key that looks like a secret is redacted.

const SECRET_KEY = /secret|key|salt|token|password|seed|private|authorization|signature/i;

export type Logger = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export const log: Logger = (level, msg, fields = {}) => {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) safe[k] = SECRET_KEY.test(k) ? "[redacted]" : v;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...safe }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
};

export const silentLogger: Logger = () => {};

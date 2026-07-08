// Minimal structured logger. Keys on the hashed customer_id only - never a
// secret, a raw wa_id, or audio bytes (Requirement 9.2).
import { logLevel } from "./config.js";

const LEVELS: Record<string, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const threshold = LEVELS[logLevel()] ?? 20;

function emit(level: string, msg: string, fields?: Record<string, unknown>): void {
  if ((LEVELS[level] ?? 20) < threshold) return;
  const rec: Record<string, unknown> = { level, msg, ...(fields || {}) };
  const line = `${new Date().toISOString()} ${level} ${msg}` +
    (fields ? " " + Object.entries(fields).map(([k, v]) => `${k}=${format(v)}`).join(" ") : "");
  if (level === "ERROR" || level === "WARN") console.error(line);
  else console.log(line);
  void rec;
}

function format(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("DEBUG", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("INFO", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("WARN", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("ERROR", msg, f),
};

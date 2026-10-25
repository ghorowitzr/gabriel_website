// Small helpers shared by the worker modules.

export const now = () => Date.now();

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function fail(status, code, message, headers = {}) {
  return json({ ok: false, code, message }, status, headers);
}

export function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function randHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

// Compares two strings without leaking where they first differ.
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Hex(String(a)), sha256Hex(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function cookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

export function cookie(name, value, { maxAge, secure = true, httpOnly = true, sameSite = "Lax" } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (httpOnly) c += "; HttpOnly";
  if (secure) c += "; Secure";
  return c;
}

export const isHttps = (request) => new URL(request.url).protocol === "https:";

export const clientIp = (request) => request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "0.0.0.0";

// Returns true if the action is allowed, false if the limit for this key is used up.
// Every allowed call is recorded, so call this once per attempt you want to count.
export async function rateAllow(env, key, limit, windowSec) {
  const since = now() - windowSec * 1000;
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM rate WHERE key = ? AND at > ?").bind(key, since).first();
  if ((row?.c ?? 0) >= limit) return false;
  await env.DB.prepare("INSERT INTO rate (key, at) VALUES (?, ?)").bind(key, now()).run();
  return true;
}

// Counts without recording (used to check failed logins before comparing a password).
export async function rateCount(env, key, windowSec) {
  const since = now() - windowSec * 1000;
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM rate WHERE key = ? AND at > ?").bind(key, since).first();
  return row?.c ?? 0;
}

export async function rateRecord(env, key) {
  await env.DB.prepare("INSERT INTO rate (key, at) VALUES (?, ?)").bind(key, now()).run();
}

export async function ipKey(env, request, scope) {
  const h = await hmacHex(env.SESSION_SECRET || "dev", "ip:" + clientIp(request));
  return `${scope}:${h.slice(0, 24)}`;
}

export const validEmail = (e) => typeof e === "string" && e.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(e);

// Wall-clock time in a named time zone -> epoch ms. Input looks like "2026-10-25T14:30".
export function zonedToEpoch(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(local || ""));
  if (!m) return NaN;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  try {
    const offset = (t) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(new Date(t));
      const g = (type) => Number(parts.find((p) => p.type === type).value);
      return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t;
    };
    let t = guess - offset(guess);
    t = guess - offset(t);
    return t;
  } catch {
    return guess; // unknown time zone: treat as UTC
  }
}

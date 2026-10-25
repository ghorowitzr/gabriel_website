// Password login for the owner. The password lives only in the EDIT_PASSWORD secret on the server.
// A correct password gets a signed, expiring cookie. Nothing secret ever reaches the browser.

import { cookies, cookie, hmacHex, safeEqual, ipKey, rateCount, rateRecord, isHttps, now, json, fail } from "./util.js";

const COOKIE = "sn_admin";
const SESSION_DAYS = 14;
const MAX_FAILS = 5;
const FAIL_WINDOW_SEC = 15 * 60;

export async function isAdmin(request, env) {
  if (!env.SESSION_SECRET) return false;
  const raw = cookies(request)[COOKIE];
  if (!raw) return false;
  const [exp, sig] = raw.split(".");
  if (!exp || !sig || Number(exp) < now()) return false;
  const want = await hmacHex(env.SESSION_SECRET, "admin." + exp);
  return safeEqual(sig, want);
}

export async function login(request, env) {
  if (!env.EDIT_PASSWORD || !env.SESSION_SECRET) {
    return fail(503, "not_configured", "Editing isn't set up yet. The site owner needs to set the EDIT_PASSWORD and SESSION_SECRET secrets.");
  }
  const key = await ipKey(env, request, "login");
  if ((await rateCount(env, key, FAIL_WINDOW_SEC)) >= MAX_FAILS) {
    return fail(429, "too_many_attempts", "Too many wrong passwords. Try again in 15 minutes.");
  }
  let body = {};
  try { body = await request.json(); } catch { /* fall through to wrong password */ }
  const ok = typeof body.password === "string" && body.password.length > 0 && (await safeEqual(body.password, env.EDIT_PASSWORD));
  if (!ok) {
    await rateRecord(env, key);
    return fail(401, "wrong_password", "That password isn't right.");
  }
  const exp = now() + SESSION_DAYS * 86400 * 1000;
  const sig = await hmacHex(env.SESSION_SECRET, "admin." + exp);
  return json({ ok: true }, 200, {
    "set-cookie": cookie(COOKIE, `${exp}.${sig}`, { maxAge: SESSION_DAYS * 86400, secure: isHttps(request) }),
  });
}

export function logout(request) {
  return json({ ok: true }, 200, { "set-cookie": cookie(COOKIE, "", { maxAge: 0, secure: isHttps(request) }) });
}

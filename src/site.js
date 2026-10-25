// The site's content (title, tabs, posts, layout) is one JSON document stored in D1.
// This module loads it, saves it, and builds the version each kind of visitor is allowed to see.

import SEED from "../seed/site.json";
import { now, zonedToEpoch } from "./util.js";

const KEY = "site";
const MAX_BYTES = 900_000;
const PAYWALL = /<div class="w-paywall"[^>]*><\/div>/;

export async function loadSite(env) {
  let row = await env.DB.prepare("SELECT value, version FROM kv WHERE key = ?").bind(KEY).first();
  if (!row) {
    // First run: store the starting content and mark its posts as "already announced"
    // so subscribers are never emailed about posts that existed before the site went live.
    const t = now();
    const value = JSON.stringify(SEED);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO kv (key, value, version, updated_at) VALUES (?, ?, 1, ?)").bind(KEY, value, t),
      ...SEED.posts.map((p) =>
        env.DB.prepare("INSERT OR IGNORE INTO notified (post_id, state, started_at, finished_at, title) VALUES (?, 'skipped', ?, ?, ?)").bind(p.id, t, t, p.title || "")
      ),
    ]);
    row = await env.DB.prepare("SELECT value, version FROM kv WHERE key = ?").bind(KEY).first();
  }
  return { site: JSON.parse(row.value), version: row.version };
}

export function postTime(p, site) {
  if (Number.isFinite(p.at)) return p.at;
  const t = zonedToEpoch(p.date, site?.site?.timezone || "UTC");
  return Number.isFinite(t) ? t : 0;
}

// What a visitor gets. The owner sees everything. Everyone else sees only published posts,
// and subscriber-only text is cut on the server so it never reaches non-subscribers.
export function viewFor(site, { admin, subscriber }) {
  if (admin) return site;
  const t = now();
  const posts = [];
  for (const p of site.posts || []) {
    if (postTime(p, site) > t) continue;
    if (subscriber) { posts.push(p); continue; }
    if (p.audience === "subscribers") {
      posts.push({ ...p, html: "", locked: true });
    } else if (PAYWALL.test(p.html || "")) {
      const [before] = p.html.split(PAYWALL);
      posts.push({ ...p, html: before + '<div class="w-paywall"></div>', locked: true });
    } else {
      posts.push(p);
    }
  }
  return { ...site, posts };
}

export function validateSite(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "The site data is missing.";
  if (!s.site || typeof s.site !== "object") return "The site settings are missing.";
  if (!Array.isArray(s.tabs) || s.tabs.length < 1) return "The site needs at least one tab.";
  if (!Array.isArray(s.posts)) return "The posts list is missing.";
  if (JSON.stringify(s).length > MAX_BYTES) return "The site is too large to save. Use uploaded images rather than pasted ones.";
  const ids = new Set();
  for (const p of s.posts) {
    if (!p || typeof p.id !== "string" || !p.id || p.id.length > 80) return "A post has no valid id.";
    if (ids.has(p.id)) return "Two posts share the same id.";
    ids.add(p.id);
    if (typeof p.html !== "string") return "A post has no body.";
  }
  const tabIds = new Set(s.tabs.map((t) => t && t.id));
  if (s.posts.some((p) => !tabIds.has(p.tabId))) return "A post belongs to a tab that doesn't exist.";
  return null;
}

export async function saveSite(env, next, baseVersion) {
  // Fill in the exact publish time (epoch ms) for any post that doesn't have one yet.
  for (const p of next.posts) {
    if (!Number.isFinite(p.at)) p.at = postTime({ date: p.date }, next);
  }
  const value = JSON.stringify(next);
  const t = now();
  const res = await env.DB.prepare("UPDATE kv SET value = ?, version = version + 1, updated_at = ? WHERE key = ? AND version = ?")
    .bind(value, t, KEY, baseVersion)
    .run();
  if (!res.meta.changes) return { conflict: true };
  const row = await env.DB.prepare("SELECT version FROM kv WHERE key = ?").bind(KEY).first();
  return { version: row.version };
}

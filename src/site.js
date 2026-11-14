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
  let site = JSON.parse(row.value), version = row.version;
  const m = await runMigrations(env, site, version);
  if (m) ({ site, version } = m);
  return { site, version };
}

// One-time edits to content that is already stored (the stored site isn't re-read from the seed file).
// Each runs once, remembered in the `kv` table, so anything you later change by hand stays changed.
const MIGRATIONS = [
  ["migration:2026-10-26-inspo", (next) => {
    for (const tab of next.tabs || []) {
      const had = (tab.blocks || []).some((b) => b.type === "silhouette") || tab.cursor === "shadow";
      tab.blocks = (tab.blocks || []).filter((b) => b.type !== "silhouette");
      if (tab.cursor === "shadow") delete tab.cursor;               // the soft shadow that followed the mouse
      for (const b of tab.blocks) if (b.type === "portrait" && b.hint === undefined) b.hint = "";   // "click or drag across the face" caption off
      if ((had || tab.slug === "cool-stuff") && !tab.blocks.some((b) => b.type === "carousel")) {
        tab.blocks.unshift({ id: "car-" + Math.random().toString(36).slice(2, 8), type: "carousel", items: [], h: 300, speed: 40 });
      }
    }
    for (const p of next.posts || []) {
      if (typeof p.html === "string") p.html = p.html.replace(/<figcaption>\s*Add a caption\s*<\/figcaption>/g, "");   // left-over placeholder text
    }
  }],
  ["migration:2026-11-14-resume", (next) => {
    // Book Reviews: keep today's order but make it hand-editable. Gabriel: no posts, resume section instead.
    const book = (next.tabs || []).find((t) => t.slug === "book-reviews" || t.name === "Book Reviews");
    if (book) {
      const ps = next.posts.filter((p) => p.tabId === book.id).sort((x, y) => String(y.date).localeCompare(String(x.date)));
      ps.forEach((p, i) => { p.order = i; });
      book.sort = "manual";
    }
    const me = (next.tabs || []).find((t) => t.slug === "gabriel");
    if (me) {
      me.noPosts = true;
      me.blocks = me.blocks || [];
      if (!me.blocks.some((b) => b.type === "resume")) {
        const portrait = me.blocks.find((b) => b.type === "portrait");
        const edu = String(portrait?.aff || "").split("\n").map((l) => l.split("|").map((x) => x.trim())).filter((x) => x[0]);
        const id = () => Math.random().toString(36).slice(2, 8);
        const voy = (next.posts || []).find((p) => p.title === "Voyager");
        me.blocks.push({ id: "res-" + id(), type: "resume", sections: [
          { id: "rs-" + id(), title: "Experience", kind: "work", show: 3, entries: [] },
          { id: "rs-" + id(), title: "Education", kind: "work", show: 3, entries: edu.map((x) => ({ id: "re-" + id(), org: x[0], loc: x[1] || "" })) },
          { id: "rs-" + id(), title: "Projects", kind: "project", show: 3, entries: voy ? [{ id: "re-" + id(), name: "Voyager", url: "https://voyager-puce.vercel.app/", desc: "", links: [] }] : [] },
        ] });
      }
    }
  }],
];
let migrationsDone = false;
async function runMigrations(env, site, version) {
  if (migrationsDone) return null;
  const done = new Set((await env.DB.prepare("SELECT key FROM kv WHERE key LIKE 'migration:%'").all()).results.map((r) => r.key));
  const todo = MIGRATIONS.filter(([k]) => !done.has(k));
  if (!todo.length) { migrationsDone = true; return null; }
  const next = JSON.parse(JSON.stringify(site));
  for (const [, fn] of todo) fn(next);
  const t = now();
  const res = await env.DB.prepare("UPDATE kv SET value = ?, version = version + 1, updated_at = ? WHERE key = ? AND version = ?")
    .bind(JSON.stringify(next), t, KEY, version).run();
  if (!res.meta.changes) return null;                              // someone saved at the same moment; try again next load
  await env.DB.batch(todo.map(([k]) => env.DB.prepare("INSERT OR IGNORE INTO kv (key, value, version, updated_at) VALUES (?, '1', 1, ?)").bind(k, t)));
  migrationsDone = true;
  return { site: next, version: version + 1 };
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
    const r = Math.round(Number(p.rating) * 2) / 2;                 // star rating: 0.5 to 5, halves allowed
    if (r > 0) p.rating = Math.min(5, r); else delete p.rating;
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

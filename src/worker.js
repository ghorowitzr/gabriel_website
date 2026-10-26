import { isAdmin, login, logout } from "./auth.js";
import { loadSite, viewFor, validateSite, saveSite, postTime } from "./site.js";
import { runNotifications } from "./notify.js";
import {
  json, fail, html, esc, now, randHex, cookies, cookie, isHttps, ipKey, rateAllow, validEmail,
} from "./util.js";

const SUB_COOKIE = "sn_sub";
const VOTER_COOKIE = "sn_v";
const MAX_UPLOAD = 10 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error("unhandled", e && e.stack || e);
      return fail(500, "server_error", "Something went wrong on the server.");
    }
  },

  // Cron: release scheduled posts, send any unfinished notifications, tidy old rate-limit rows.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await runNotifications(env);
        await env.DB.prepare("DELETE FROM rate WHERE at < ?").bind(now() - 86400 * 1000).run();
      })()
    );
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const m = request.method;

  if (path.startsWith("/api/")) return api(request, env, ctx, url, path, m);

  let hit;
  if ((hit = /^\/confirm\/([0-9a-f]{20,64})$/.exec(path)) && m === "GET") return confirmPage(request, env, hit[1]);
  if ((hit = /^\/s\/([0-9a-f]{20,64})(?:\/([^/]*))?$/.exec(path)) && m === "GET") return readerLink(request, env, hit[1], hit[2]);
  if ((hit = /^\/unsubscribe\/([0-9a-f]{20,64})$/.exec(path))) return unsubscribe(request, env, hit[1], m);
  if ((hit = /^\/_blob\/([0-9a-f]{32})$/.exec(path)) && (m === "GET" || m === "HEAD")) return blob(request, env, hit[1]);

  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  out.headers.set("x-frame-options", "SAMEORIGIN");
  return out;
}

// ---------------------------------------------------------------- API

async function api(request, env, ctx, url, path, m) {
  // Anything that changes data must come from our own pages: a custom header (which other sites can't send
  // without our permission) and, when the browser sends one, a matching Origin.
  if (m !== "GET" && m !== "HEAD") {
    if (request.headers.get("x-sn") !== "1") return fail(403, "bad_request", "Missing request header.");
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return fail(403, "bad_origin", "Cross-site requests aren't allowed.");
  }

  const admin = await isAdmin(request, env);

  // ----- public
  if (path === "/api/site" && m === "GET") {
    const sub = admin ? null : await subscriberFrom(request, env);
    const { site, version } = await loadSite(env);
    return json({ site: viewFor(site, { admin, subscriber: !!sub }), version, me: { admin, subscribed: !!sub } });
  }
  if (path === "/api/social" && m === "GET") return social(request, env, admin);
  if (path === "/api/subscribe" && m === "POST") return subscribe(request, env, url);
  if (path === "/api/like" && m === "POST") return like(request, env, admin);
  if (path === "/api/vote" && m === "POST") return vote(request, env);
  if (path === "/api/comment" && m === "POST") return comment(request, env, admin);
  if (path === "/api/login" && m === "POST") return login(request, env);
  if (path === "/api/logout" && m === "POST") return logout(request);

  // ----- owner only
  if (!admin) return fail(401, "not_signed_in", "Sign in to edit.");

  if (path === "/api/site" && m === "PUT") return putSite(request, env, ctx);
  if (path === "/api/upload" && m === "POST") return upload(request, env);

  if (path === "/api/drafts") {
    if (m === "GET") {
      const r = await env.DB.prepare("SELECT data FROM drafts ORDER BY updated_at DESC LIMIT 200").all();
      return json({ drafts: r.results.map((x) => JSON.parse(x.data)) });
    }
    if (m === "PUT") {
      const b = await request.json().catch(() => null);
      if (!b || typeof b.id !== "string" || !b.data || typeof b.data !== "object") return fail(400, "bad_request", "Bad draft.");
      const data = JSON.stringify(b.data);
      if (data.length > 800_000) return fail(413, "too_large", "That draft is too large.");
      await env.DB.prepare("INSERT INTO drafts (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
        .bind(b.id.slice(0, 80), data, now()).run();
      return json({ ok: true });
    }
    if (m === "DELETE") {
      await env.DB.prepare("DELETE FROM drafts WHERE id = ?").bind(url.searchParams.get("id") || "").run();
      return json({ ok: true });
    }
  }

  if (path === "/api/subscribers" && m === "GET") return subscribersList(env);
  if (path === "/api/subscribers.csv" && m === "GET") return subscribersCsv(env);
  if (path === "/api/subscribers" && m === "DELETE") {
    await env.DB.prepare("DELETE FROM subscribers WHERE id = ?").bind(url.searchParams.get("id") || "").run();
    return json({ ok: true });
  }

  if (path === "/api/comments" && m === "GET") return commentsList(env, url.searchParams.get("status") || "pending");
  if (path === "/api/comments" && m === "POST") return commentsModerate(request, env);

  return fail(404, "not_found", "Not found.");
}

// ---------------------------------------------------------------- owner: content

async function putSite(request, env, ctx) {
  const b = await request.json().catch(() => null);
  if (!b) return fail(400, "bad_request", "Bad request.");
  const problem = validateSite(b.site);
  if (problem) return fail(400, "invalid_site", problem);
  const base = Number(b.baseVersion);
  if (!Number.isInteger(base)) return fail(400, "bad_request", "Missing version.");
  const r = await saveSite(env, b.site, base);
  if (r.conflict) return fail(409, "conflict", "A newer version was saved somewhere else.");
  ctx.waitUntil(runNotifications(env).catch((e) => console.error("notify", e)));
  return json({ ok: true, version: r.version, site: b.site });
}

async function upload(request, env) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_UPLOAD) return fail(413, "too_large", "That file is over 10 MB.");
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_UPLOAD) return fail(413, "too_large", "That file is over 10 MB.");
  const type = sniffImage(new Uint8Array(buf));
  if (!type) return fail(415, "bad_type", "Only PNG, JPEG, GIF, WebP and AVIF images can be uploaded.");
  const id = randHex(16); // random rather than a hash: hashing a 10 MB file would use up the free plan's 10 ms CPU allowance
  await env.MEDIA.put("img:" + id, buf, { metadata: { type } });
  return json({ ok: true, url: "/_blob/" + id, type });
}

function sniffImage(b) {
  const at = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF8")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (at(4, "ftypavif") || at(4, "ftypavis")) return "image/avif";
  return null;
}

async function blob(request, env, id) {
  const hdr = { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" };
  const got = await env.MEDIA.getWithMetadata("img:" + id, "arrayBuffer");
  if (got && got.value) return new Response(request.method === "HEAD" ? null : got.value, { headers: { ...hdr, "content-type": got.metadata?.type || "application/octet-stream" } });
  // Images that shipped with the site live in /public/blob-seed.
  for (const ext of ["jpg", "png", "webp", "gif"]) {
    const r = await env.ASSETS.fetch(new Request(new URL(`/blob-seed/${id}.${ext}`, request.url), { method: request.method }));
    if (r.ok) {
      const out = new Response(r.body, r);
      for (const [k, v] of Object.entries(hdr)) out.headers.set(k, v);
      return out;
    }
  }
  return new Response("Not found", { status: 404 });
}

// ---------------------------------------------------------------- subscribers

async function subscriberFrom(request, env) {
  const t = cookies(request)[SUB_COOKIE];
  if (!t || !/^[0-9a-f]{20,64}$/.test(t)) return null;
  return env.DB.prepare("SELECT id, email FROM subscribers WHERE token = ? AND status = 'confirmed'").bind(t).first();
}

async function subscribe(request, env, url) {
  const b = await request.json().catch(() => ({}));
  if (b.hp) return json({ ok: true }); // honeypot: bots fill hidden fields; pretend it worked
  const email = String(b.email || "").trim().toLowerCase();
  if (!validEmail(email)) return fail(400, "bad_email", "Enter a valid email address.");
  if (!(await rateAllow(env, await ipKey(env, request, "sub"), 6, 3600))) return fail(429, "slow_down", "Too many attempts. Try again in a little while.");

  // No confirmation email: entering an address subscribes it straight away.
  // Only a brand-new subscriber gets the "I'm a subscriber" cookie. Handing it out for an address that
  // already exists would let anyone type in someone else's email and take over their subscription.
  const t = now();
  const row = await env.DB.prepare("SELECT id, status FROM subscribers WHERE email = ?").bind(email).first();
  if (!row) {
    const id = randHex(8), token = randHex(24);
    await env.DB.prepare("INSERT INTO subscribers (id, email, token, status, created_at, confirmed_at) VALUES (?, ?, ?, 'confirmed', ?, ?)").bind(id, email, token, t, t).run();
    return json({ ok: true }, 200, { "set-cookie": cookie(SUB_COOKIE, token, { maxAge: 365 * 86400, secure: isHttps(request) }) });
  }
  if (row.status !== "confirmed") {
    // Includes people who unsubscribed earlier and are signing up again, and anyone left waiting from the old flow.
    await env.DB.prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ? WHERE id = ?").bind(t, row.id).run();
  }
  return json({ ok: true });
}

function redirect(location, headers = {}) {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const [k, v] of Object.entries(headers)) h.append(k, v);
  return new Response(null, { status: 302, headers: h });
}

async function confirmPage(request, env, token) {
  const row = await env.DB.prepare("SELECT id, status FROM subscribers WHERE token = ?").bind(token).first();
  if (!row) return redirect("/?s=invalid");
  if (row.status !== "confirmed") await env.DB.prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ? WHERE id = ?").bind(now(), row.id).run();
  return redirect("/?s=confirmed", { "set-cookie": cookie(SUB_COOKIE, token, { maxAge: 365 * 86400, secure: isHttps(request) }) });
}

// Link inside every post email: signs the reader in on this device so subscriber-only posts open.
async function readerLink(request, env, token, slug) {
  const row = await env.DB.prepare("SELECT id FROM subscribers WHERE token = ? AND status = 'confirmed'").bind(token).first();
  let dest = "/";
  if (row && slug) { try { dest = "/#p-" + encodeURIComponent(decodeURIComponent(slug)); } catch { /* malformed link: just go home */ } }
  return redirect(dest, row ? { "set-cookie": cookie(SUB_COOKIE, token, { maxAge: 365 * 86400, secure: isHttps(request) }) } : {});
}

async function unsubscribe(request, env, token, m) {
  const row = await env.DB.prepare("SELECT id, status FROM subscribers WHERE token = ?").bind(token).first();
  const page = (inner) =>
    html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>
<body style="font:17px/1.6 Georgia,serif;background:#05060b;color:#f3f4f8;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center"><div style="max-width:420px">${inner}</div></body>`);
  if (!row) return page(`<h1 style="font-weight:400">Link not recognized</h1><p><a style="color:#cfe0ff" href="/">Back to the site</a></p>`);
  if (m === "POST") {
    await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE id = ?").bind(row.id).run();
    return page(`<h1 style="font-weight:400">You're unsubscribed</h1><p>You won't get any more emails. Changed your mind? Subscribe again from the site any time.</p><p><a style="color:#cfe0ff" href="/">Back to the site</a></p>`);
  }
  if (m !== "GET") return new Response("Method not allowed", { status: 405 });
  // A plain GET never unsubscribes anyone (mail scanners open links); the button does.
  return page(`<h1 style="font-weight:400">Unsubscribe?</h1><form method="post" action="/unsubscribe/${esc(token)}"><button style="font:600 15px Arial;padding:12px 22px;border:0;border-radius:4px;background:#f3f4f8;color:#05060b;cursor:pointer">${row.status === "unsubscribed" ? "Already unsubscribed" : "Yes, unsubscribe me"}</button></form>`);
}

async function subscribersList(env) {
  const subs = await env.DB.prepare("SELECT id, email, status, created_at, confirmed_at FROM subscribers ORDER BY created_at DESC LIMIT 5000").all();
  const counts = { confirmed: 0, pending: 0, unsubscribed: 0 };
  subs.results.forEach((s) => counts[s.status]++);
  const notifications = await env.DB.prepare("SELECT post_id, title, state, sent, last_error, started_at FROM notified WHERE state != 'skipped' ORDER BY started_at DESC LIMIT 5").all();
  return json({ subscribers: subs.results, counts, notifications: notifications.results });
}

async function subscribersCsv(env) {
  const subs = await env.DB.prepare("SELECT email, status, created_at, confirmed_at FROM subscribers ORDER BY created_at").all();
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stops spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  const iso = (t) => (t ? new Date(t).toISOString() : "");
  const rows = ["email,status,subscribed_at,confirmed_at", ...subs.results.map((s) => [s.email, s.status, iso(s.created_at), iso(s.confirmed_at)].map(cell).join(","))];
  return new Response(rows.join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="subscribers.csv"', "cache-control": "no-store" } });
}

// ---------------------------------------------------------------- likes, polls, comments

async function voterId(request, env) {
  const existing = cookies(request)[VOTER_COOKIE];
  if (existing && /^[0-9a-f]{32}$/.test(existing)) return { id: existing, setCookie: null };
  const id = randHex(16);
  return { id, setCookie: cookie(VOTER_COOKIE, id, { maxAge: 2 * 365 * 86400, secure: isHttps(request) }) };
}

const withCookie = (res, setCookie) => {
  if (setCookie) res.headers.append("set-cookie", setCookie);
  return res;
};

async function social(request, env, admin) {
  const v = await voterId(request, env);
  const [likes, mine, votes, myVotes, comments] = await Promise.all([
    env.DB.prepare("SELECT post_id, COUNT(*) AS c FROM likes GROUP BY post_id").all(),
    env.DB.prepare("SELECT post_id FROM likes WHERE voter = ?").bind(v.id).all(),
    env.DB.prepare("SELECT poll_id, choice, COUNT(*) AS c FROM votes GROUP BY poll_id, choice").all(),
    env.DB.prepare("SELECT poll_id, choice FROM votes WHERE voter = ?").bind(v.id).all(),
    env.DB.prepare("SELECT id, post_id, name, body, created_at FROM comments WHERE status = 'approved' ORDER BY created_at LIMIT 3000").all(),
  ]);
  const polls = {};
  votes.results.forEach((r) => { (polls[r.poll_id] ||= { counts: {}, mine: null }).counts[r.choice] = r.c; });
  myVotes.results.forEach((r) => { (polls[r.poll_id] ||= { counts: {}, mine: null }).mine = r.choice; });
  const byPost = {};
  comments.results.forEach((c) => { (byPost[c.post_id] ||= []).push({ id: c.id, name: c.name, body: c.body, at: c.created_at }); });
  return withCookie(json({
    likes: Object.fromEntries(likes.results.map((r) => [r.post_id, r.c])),
    mine: Object.fromEntries(mine.results.map((r) => [r.post_id, true])),
    polls,
    comments: byPost,
  }), v.setCookie);
}

async function findPost(env, postId, admin) {
  const { site } = await loadSite(env);
  const p = site.posts.find((x) => x.id === postId);
  if (!p) return null;
  if (!admin && postTime(p, site) > now()) return null;
  return p;
}

async function like(request, env, admin) {
  const b = await request.json().catch(() => ({}));
  const postId = String(b.postId || "").slice(0, 80);
  if (!(await findPost(env, postId, admin))) return fail(404, "not_found", "Post not found.");
  const v = await voterId(request, env);
  if (!(await rateAllow(env, "like:" + v.id, 60, 600))) return fail(429, "slow_down", "Slow down a little.");
  const had = await env.DB.prepare("SELECT 1 AS x FROM likes WHERE post_id = ? AND voter = ?").bind(postId, v.id).first();
  if (had) await env.DB.prepare("DELETE FROM likes WHERE post_id = ? AND voter = ?").bind(postId, v.id).run();
  else await env.DB.prepare("INSERT OR IGNORE INTO likes (post_id, voter, created_at) VALUES (?, ?, ?)").bind(postId, v.id, now()).run();
  const c = await env.DB.prepare("SELECT COUNT(*) AS c FROM likes WHERE post_id = ?").bind(postId).first();
  return withCookie(json({ ok: true, count: c.c, mine: !had }), v.setCookie);
}

async function vote(request, env) {
  const b = await request.json().catch(() => ({}));
  const pollId = String(b.pollId || "").slice(0, 64);
  const choice = Number(b.choice);
  if (!pollId || !Number.isInteger(choice) || choice < 0 || choice > 19) return fail(400, "bad_request", "Bad vote.");
  const v = await voterId(request, env);
  if (!(await rateAllow(env, "vote:" + v.id, 60, 600))) return fail(429, "slow_down", "Slow down a little.");
  await env.DB.prepare("INSERT INTO votes (poll_id, voter, choice, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(poll_id, voter) DO UPDATE SET choice = excluded.choice")
    .bind(pollId, v.id, choice, now()).run();
  return withCookie(json({ ok: true }), v.setCookie);
}

async function comment(request, env, admin) {
  const b = await request.json().catch(() => ({}));
  if (b.hp) return json({ ok: true, status: "pending" }); // honeypot
  const post = await findPost(env, String(b.postId || ""), admin);
  if (!post) return fail(404, "not_found", "Post not found.");
  if (post.comments === "off") return fail(403, "closed", "Comments are closed on this post.");
  if (post.comments === "subscribers" && !admin && !(await subscriberFrom(request, env))) return fail(403, "subscribers_only", "Comments are open to subscribers.");

  const body = String(b.body || "").trim().slice(0, 2000);
  const name = String(b.name || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Reader";
  if (!body) return fail(400, "empty", "Write something first.");
  const v = await voterId(request, env);
  if (!admin) {
    if (!(await rateAllow(env, await ipKey(env, request, "cmt"), 6, 600))) return fail(429, "slow_down", "You're commenting too quickly. Try again in a few minutes.");
    if (!(await rateAllow(env, "cmtv:" + v.id, 20, 86400))) return fail(429, "slow_down", "That's enough comments for today.");
  }
  // The owner's own comments go straight up; everyone else's wait for approval.
  const status = admin ? "approved" : "pending";
  await env.DB.prepare("INSERT INTO comments (id, post_id, name, body, status, voter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(randHex(8), post.id, name, body, status, v.id, now()).run();
  return withCookie(json({ ok: true, status }), v.setCookie);
}

async function commentsList(env, status) {
  const where = ["pending", "approved", "rejected"].includes(status) ? "WHERE status = ?" : "";
  const stmt = env.DB.prepare(`SELECT id, post_id, name, body, status, created_at FROM comments ${where} ORDER BY created_at DESC LIMIT 300`);
  const r = await (where ? stmt.bind(status) : stmt).all();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS c FROM comments WHERE status = 'pending'").first();
  return json({ comments: r.results, pending: pending.c });
}

async function commentsModerate(request, env) {
  const b = await request.json().catch(() => ({}));
  const id = String(b.id || "");
  if (b.action === "delete") await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
  else if (b.action === "approve") await env.DB.prepare("UPDATE comments SET status = 'approved' WHERE id = ?").bind(id).run();
  else if (b.action === "reject") await env.DB.prepare("UPDATE comments SET status = 'rejected' WHERE id = ?").bind(id).run();
  else return fail(400, "bad_request", "Unknown action.");
  const pending = await env.DB.prepare("SELECT COUNT(*) AS c FROM comments WHERE status = 'pending'").first();
  return json({ ok: true, pending: pending.c });
}

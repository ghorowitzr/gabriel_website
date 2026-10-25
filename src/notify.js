// Emails confirmed subscribers when a post goes live. Runs right after the owner publishes
// and again every 10 minutes (cron), which is also what releases scheduled posts.
//
// Safety rules:
//  - A post is announced at most once (the `notified` table) and each subscriber gets it at most once (`deliveries`).
//  - Posts older than 36 hours with no record are never announced (backdated or imported posts).
//  - Posts with notify:false are never announced.
//  - If a run is cut off mid-send, its unfinished claims are released after 10 minutes and the same people are retried
//    with the same idempotency key, so the email provider drops anything it already sent.
//
// Cloudflare's free plan gives each run 10 ms of CPU and 50 database/network calls, so one run sends a few batches
// and the next scheduled run carries on. Raise MAX_BATCHES (in wrangler.toml [vars]) if you're on a paid plan.

import { loadSite, postTime } from "./site.js";
import { sendBatch, postEmail, idemKey, PH_READ, PH_UNSUB } from "./email.js";
import { now, esc } from "./util.js";

const BATCH = 100;
const FRESH_MS = 36 * 3600 * 1000;
const STALE_CLAIM_MS = 10 * 60 * 1000;

const plain = (h) =>
  String(h || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

function excerptOf(post) {
  const html = String(post.html || "").split(/<div class="w-paywall"[^>]*><\/div>/)[0];
  const t = plain(html);
  if (t.length <= 260) return t;
  return t.slice(0, 260).replace(/\s+\S*$/, "") + "…";
}

export async function runNotifications(env) {
  const base = String(env.SITE_URL || "").replace(/\/+$/, "");
  const { site } = await loadSite(env);
  const t = now();
  const maxBatches = Math.max(1, Number(env.MAX_BATCHES) || 2);
  const live = site.posts
    .filter((p) => postTime(p, site) <= t && !p.example)
    .sort((a, b) => postTime(a, site) - postTime(b, site));

  let batchesLeft = maxBatches;
  for (const p of live) {
    const row = await env.DB.prepare("SELECT state FROM notified WHERE post_id = ?").bind(p.id).first();
    if (row && row.state !== "sending") continue;

    if (!row) {
      const fresh = postTime(p, site) >= t - FRESH_MS;
      const state = p.notify === false || !fresh ? "skipped" : "sending";
      await env.DB.prepare("INSERT OR IGNORE INTO notified (post_id, state, started_at, finished_at, title) VALUES (?, ?, ?, ?, ?)")
        .bind(p.id, state, t, state === "skipped" ? t : null, p.title || "")
        .run();
      if (state === "skipped") continue;
    }
    if (!base) {
      await setError(env, p.id, "SITE_URL is empty in wrangler.toml, so links in the email can't be built.");
      continue;
    }
    batchesLeft = await sendPost(env, site, p, base, batchesLeft);
    if (batchesLeft <= 0) break;
  }
}

async function setError(env, postId, msg) {
  await env.DB.prepare("UPDATE notified SET last_error = ? WHERE post_id = ?").bind(msg, postId).run();
}

async function sendPost(env, site, post, base, batchesLeft) {
  const started = (await env.DB.prepare("SELECT started_at FROM notified WHERE post_id = ?").bind(post.id).first()).started_at;
  // Free anyone claimed by a run that never finished (it was cut off before sending or before recording the send).
  await env.DB.prepare("DELETE FROM deliveries WHERE post_id = ? AND status = 'claimed' AND at < ?").bind(post.id, now() - STALE_CLAIM_MS).run();

  // Build the email once; each subscriber only gets their own two links swapped in.
  const siteTitle = site.site?.title || "the site";
  const cover = /^\/_blob\/[0-9a-f]{32}$/.test(post.cover || "") ? base + post.cover : /^https:\/\//.test(post.cover || "") ? post.cover : "";
  const locked = post.audience === "subscribers" || /class="w-paywall"/.test(post.html || "");
  const tpl = postEmail({ siteTitle, post, excerpt: excerptOf(post), coverUrl: cover, address: env.MAILING_ADDRESS || "", locked, readUrl: PH_READ, unsubUrl: PH_UNSUB });

  while (batchesLeft > 0) {
    // Claim up to 100 subscribers who haven't been sent this post. RETURNING gives back only the rows we claimed,
    // so two overlapping runs can never claim the same person. The fixed ORDER keeps a retry's group identical.
    const claimed = await env.DB.prepare(
      `INSERT OR IGNORE INTO deliveries (post_id, subscriber_id, status, at)
       SELECT ?1, s.id, 'claimed', ?2 FROM subscribers s
       WHERE s.status = 'confirmed' AND s.confirmed_at <= ?3
         AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id = ?1 AND d.subscriber_id = s.id)
       ORDER BY s.created_at, s.id
       LIMIT ${BATCH}
       RETURNING subscriber_id`
    ).bind(post.id, now(), started).all();
    const ids = (claimed.results || []).map((r) => r.subscriber_id).sort();

    if (!ids.length) {
      await env.DB.prepare("UPDATE notified SET state = 'done', finished_at = ?, last_error = NULL WHERE post_id = ?").bind(now(), post.id).run();
      return batchesLeft;
    }

    const marks = ids.map(() => "?").join(",");
    const subs = await env.DB.prepare(`SELECT id, email, token FROM subscribers WHERE id IN (${marks})`).bind(...ids).all();
    const messages = subs.results.map((s) => {
      const unsub = `${base}/unsubscribe/${s.token}`;
      const read = `${base}/s/${s.token}/${encodeURIComponent(post.slug || "")}`;
      return {
        to: s.email,
        subject: tpl.subject,
        html: tpl.html.replaceAll(PH_READ, esc(read)).replaceAll(PH_UNSUB, esc(unsub)),
        text: tpl.text.replaceAll(PH_READ, read).replaceAll(PH_UNSUB, unsub),
        headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      };
    });

    try {
      await sendBatch(env, messages, await idemKey([post.id, ...ids]));
    } catch (e) {
      // Release the claim so the next run retries these people; remember why it failed so the owner can see it.
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM deliveries WHERE post_id = ? AND subscriber_id IN (${marks}) AND status = 'claimed'`).bind(post.id, ...ids),
        env.DB.prepare("UPDATE notified SET last_error = ? WHERE post_id = ?").bind(String(e.message || e).slice(0, 300), post.id),
      ]);
      return 0;
    }
    await env.DB.batch([
      env.DB.prepare(`UPDATE deliveries SET status = 'sent' WHERE post_id = ? AND subscriber_id IN (${marks})`).bind(post.id, ...ids),
      env.DB.prepare("UPDATE notified SET sent = sent + ?, last_error = NULL WHERE post_id = ?").bind(ids.length, post.id),
    ]);
    batchesLeft--;
  }
  return batchesLeft; // out of batches for this run; the next scheduled run continues
}

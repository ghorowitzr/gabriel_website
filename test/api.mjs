// End-to-end API test. Run the dev server first (npx wrangler dev --test-scheduled), then: node test/api.mjs
// Uses .dev.vars (EMAIL_MODE=log) so emails land in the local `outbox` table instead of being sent.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:8787";
const PASSWORD = "test-password-123";
let pass = 0, failed = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { failed++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny cookie-jar client
class Client {
  constructor() { this.jar = {}; }
  async req(method, path, body, headers = {}) {
    const h = { ...headers };
    if (method !== "GET" && !h["x-sn"] && !h.nosn) h["x-sn"] = "1";
    delete h.nosn;
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.cookie = cookie;
    let payload = body;
    if (body && typeof body === "object" && !(body instanceof Uint8Array)) { payload = JSON.stringify(body); h["content-type"] ||= "application/json"; }
    const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(";"); const i = pair.indexOf("=");
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c)) delete this.jar[k]; else this.jar[k] = v;
    }
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, data, text, headers: res.headers };
  }
  get(p, h) { return this.req("GET", p, undefined, h); }
  post(p, b, h) { return this.req("POST", p, b, h); }
  put(p, b, h) { return this.req("PUT", p, b, h); }
  del(p, h) { return this.req("DELETE", p, undefined, h); }
}

function sql(query) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", query], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out)[0].results;
}
const outbox = (where = "1=1") => sql(`SELECT to_addr, subject, body FROM outbox WHERE ${where} ORDER BY id`);
const linkIn = (row, re) => { const b = JSON.parse(row.body); return (re.exec(b.text) || [])[0]; };
const iso = (ms) => new Date(ms).toISOString().slice(0, 16);

const owner = new Client();   // signed in
const anon = new Client();    // an anonymous visitor
const reader = new Client();  // a confirmed subscriber

console.log("\nPublic site");
let r = await anon.get("/api/site");
ok(r.status === 200 && r.data.site.posts.length === 8, "anonymous visitor gets the 8 starting posts", r.status);
ok(r.data.me.admin === false && r.data.me.subscribed === false, "visitor is not owner and not subscriber");
let version = r.data.version;
r = await anon.get("/");
ok(r.status === 200, "home page is served");
r = await anon.get("/_blob/1e7c154bdfda261a754a81acb02a4c85");
ok(r.status === 200 && /image\/jpeg/.test(r.headers.get("content-type")), "starting images are served from /_blob", r.headers.get("content-type"));

console.log("\nProtection against cross-site requests and logged-out edits");
r = await owner.post("/api/login", { password: PASSWORD }, { nosn: true });
ok(r.status === 403, "POST without the custom header is refused", r.status);
r = await owner.post("/api/login", { password: PASSWORD }, { origin: "https://evil.example" });
ok(r.status === 403, "POST from another origin is refused", r.status);
r = await anon.put("/api/site", { site: {}, baseVersion: 1 });
ok(r.status === 401, "saving the site while logged out is refused", r.status);
r = await anon.post("/api/upload", new Uint8Array([1, 2, 3]));
ok(r.status === 401, "uploading while logged out is refused", r.status);
r = await anon.get("/api/subscribers");
ok(r.status === 401, "the subscriber list is private", r.status);

console.log("\nOwner login");
r = await owner.post("/api/login", { password: PASSWORD });
ok(r.status === 200 && owner.jar.sn_admin, "correct password signs in and sets the cookie");
ok(/HttpOnly/i.test(r.headers.get("set-cookie")), "session cookie is HttpOnly");
r = await owner.get("/api/site");
ok(r.data.me.admin === true, "server recognizes the owner");

console.log("\nSubscribing (double opt-in)");
r = await anon.post("/api/subscribe", { email: "not-an-email" });
ok(r.status === 400, "invalid email is rejected", r.status);
r = await anon.post("/api/subscribe", { email: "bot@example.com", hp: "gotcha" });
ok(r.status === 200 && outbox("to_addr='bot@example.com'").length === 0, "honeypot field: silently ignored, no email");
for (const e of ["reader@example.com", "late@example.com", "pending@example.com", "leaver@example.com"]) {
  r = await anon.post("/api/subscribe", { email: e });
  ok(r.status === 200, `subscribe ${e}`, r.status);
}
const confirmMails = outbox("subject LIKE 'Confirm your subscription%'");
ok(confirmMails.length === 4, "one confirmation email per address", confirmMails.length);
r = await anon.post("/api/subscribe", { email: "pending@example.com" });
ok(outbox("subject LIKE 'Confirm your subscription%'").length === 4, "re-submitting within 5 minutes doesn't send another email");
const tokens = {};
for (const m of confirmMails) tokens[m.to_addr] = /\/confirm\/([0-9a-f]+)/.exec(linkIn(m, /https?:\/\/\S+\/confirm\/[0-9a-f]+/))[1];
r = await new Client().get("/confirm/" + tokens["reader@example.com"]);
ok(r.status === 302 && /s=confirmed/.test(r.headers.get("location")), "confirm link redirects");
reader.jar.sn_sub = tokens["reader@example.com"];
r = await reader.get("/api/site");
ok(r.data.me.subscribed === true, "confirmed subscriber is recognized by the cookie");
await new Client().get("/confirm/" + tokens["leaver@example.com"]);
await new Client().get("/confirm/" + tokens["late@example.com"]);
r = await owner.get("/api/subscribers");
ok(r.data.counts.confirmed === 3 && r.data.counts.pending === 1, "owner sees 3 confirmed, 1 pending", r.data.counts);

console.log("\nPublishing a post emails confirmed subscribers once");
const mk = (over) => ({
  id: "t-" + Math.random().toString(36).slice(2, 8), tabId: "t1", title: "T", subtitle: "", slug: "t", audience: "everyone", comments: "everyone",
  cover: "", tags: [], pinned: false, order: 0, html: "<p>Hello world.</p>", ...over,
});
const t0 = Date.now();
const live = mk({ id: "live-1", title: "Fresh post", slug: "fresh-post", subtitle: "A sub", html: "<p>This is the first paragraph of the fresh post.</p>", at: t0 - 1000, date: iso(t0) });
let site = (await owner.get("/api/site")).data.site;
site.posts.push(live);
r = await owner.put("/api/site", { site, baseVersion: version });
ok(r.status === 200, "owner saves the site with a new post", r);
version = r.data.version;
await sleep(2500);
let mails = outbox("subject = 'Fresh post'");
ok(mails.length === 3, "3 confirmed subscribers emailed, pending one not", mails.map((m) => m.to_addr));
ok(!mails.some((m) => m.to_addr === "pending@example.com"), "unconfirmed address got nothing");
ok(outbox("subject NOT LIKE 'Confirm%' AND subject != 'Fresh post'").length === 0, "none of the 8 starting posts were emailed");
const mailBody = JSON.parse(mails[0].body);
ok(/\/unsubscribe\/[0-9a-f]+/.test(mailBody.text) && mailBody.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", "email has unsubscribe link and one-click header");
ok(/\/s\/[0-9a-f]+\/fresh-post/.test(mailBody.text), "email links straight to the post");
// saving again must not resend
site = (await owner.get("/api/site")).data.site;
r = await owner.put("/api/site", { site, baseVersion: version }); version = r.data.version;
await sleep(2000);
ok(outbox("subject = 'Fresh post'").length === 3, "saving again does not email anyone twice");

console.log("\nPosts that must NOT be emailed");
site = (await owner.get("/api/site")).data.site;
site.posts.push(mk({ id: "old-1", title: "Backdated post", slug: "backdated", at: t0 - 3 * 86400e3, date: iso(t0 - 3 * 86400e3) }));
site.posts.push(mk({ id: "quiet-1", title: "Quiet post", slug: "quiet", notify: false, at: t0 - 1000, date: iso(t0) }));
r = await owner.put("/api/site", { site, baseVersion: version }); version = r.data.version;
await sleep(2000);
ok(outbox("subject = 'Backdated post'").length === 0, "a post dated 3 days ago is not announced");
ok(outbox("subject = 'Quiet post'").length === 0, "a post with notifications switched off is not announced");

console.log("\nScheduled post: hidden until its time, then emailed by the scheduler");
site = (await owner.get("/api/site")).data.site;
const soon = Date.now() + 4000;
site.posts.push(mk({ id: "sched-1", title: "Scheduled post", slug: "scheduled", at: soon, date: iso(soon) }));
r = await owner.put("/api/site", { site, baseVersion: version }); version = r.data.version;
ok(!(await anon.get("/api/site")).data.site.posts.some((p) => p.id === "sched-1"), "visitors can't see a scheduled post early");
ok((await owner.get("/api/site")).data.site.posts.some((p) => p.id === "sched-1"), "owner can");
await sleep(500);
ok(outbox("subject = 'Scheduled post'").length === 0, "nothing emailed before its time");
await sleep(4500);
await fetch(BASE + "/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*");
await sleep(2500);
ok(outbox("subject = 'Scheduled post'").length === 3, "scheduler emails it once the time arrives", outbox("subject = 'Scheduled post'").length);
ok((await anon.get("/api/site")).data.site.posts.some((p) => p.id === "sched-1"), "and visitors can now see it");
await fetch(BASE + "/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*"); await sleep(1500);
ok(outbox("subject = 'Scheduled post'").length === 3, "a second scheduler run sends nothing more");

console.log("\nSubscriber-only posts stay on the server");
site = (await owner.get("/api/site")).data.site;
site.posts.push(mk({ id: "sub-1", title: "Members only", slug: "members", audience: "subscribers", html: "<p>SECRET-BODY-TEXT</p>", at: t0 - 500, date: iso(t0) }));
site.posts.push(mk({ id: "wall-1", title: "Half free", slug: "half", html: '<p>FREE-PART</p><div class="w-paywall"></div><p>PAID-PART</p>', at: t0 - 400, date: iso(t0), notify: false }));
r = await owner.put("/api/site", { site, baseVersion: version }); version = r.data.version;
const anonSite = (await anon.get("/api/site")).data.site;
const subOnly = anonSite.posts.find((p) => p.id === "sub-1");
ok(subOnly && subOnly.html === "" && subOnly.locked, "anonymous visitor gets no text of a subscribers-only post");
const walled = anonSite.posts.find((p) => p.id === "wall-1");
ok(walled && walled.html.includes("FREE-PART") && !walled.html.includes("PAID-PART") && /w-paywall/.test(walled.html), "paywalled post is cut at the marker on the server");
const readerSite = (await reader.get("/api/site")).data.site;
ok(readerSite.posts.find((p) => p.id === "sub-1").html.includes("SECRET-BODY-TEXT"), "subscriber gets the full text");
ok(!JSON.stringify(anonSite).includes("SECRET-BODY-TEXT") && !JSON.stringify(anonSite).includes("PAID-PART"), "secret text appears nowhere in the anonymous response");
// reader link in an email sets the cookie on a fresh device
const fresh = new Client();
const link = JSON.parse(outbox("subject = 'Fresh post' AND to_addr='reader@example.com'")[0].body).text.match(/https?:\/\/\S+\/s\/[0-9a-f]+\/fresh-post/)[0];
r = await fresh.get(new URL(link).pathname);
ok(r.status === 302 && fresh.jar.sn_sub && /#p-fresh-post/.test(r.headers.get("location")), "the link in an email signs the reader in on that device");
r = await fresh.get("/api/site");
ok(r.data.me.subscribed === true, "...and subscriber content opens there");

console.log("\nLikes and polls");
r = await anon.post("/api/like", { postId: "live-1" });
ok(r.status === 200 && r.data.count === 1 && r.data.mine === true, "like counts");
r = await anon.post("/api/like", { postId: "live-1" });
ok(r.data.count === 0 && r.data.mine === false, "liking again removes the like (one per visitor)");
await anon.post("/api/like", { postId: "live-1" });
await reader.post("/api/like", { postId: "live-1" });
r = await anon.get("/api/social");
ok(r.data.likes["live-1"] === 2 && r.data.mine["live-1"] === true, "two different visitors = 2 likes; each sees their own", r.data.likes);
r = await anon.post("/api/like", { postId: "sched-future-does-not-exist" });
ok(r.status === 404, "can't like a post that doesn't exist");
await anon.post("/api/vote", { pollId: "poll1", choice: 1 });
await reader.post("/api/vote", { pollId: "poll1", choice: 0 });
await reader.post("/api/vote", { pollId: "poll1", choice: 1 });
r = await anon.get("/api/social");
ok(r.data.polls.poll1.counts[1] === 2 && !r.data.polls.poll1.counts[0] && r.data.polls.poll1.mine === 1, "poll: changing your vote replaces it", r.data.polls);

console.log("\nComments are moderated");
r = await anon.post("/api/comment", { postId: "live-1", name: "Sam", body: "Nice post!" });
ok(r.status === 200 && r.data.status === "pending", "visitor's comment is held for review");
r = await anon.get("/api/social");
ok(!(r.data.comments["live-1"] || []).length, "held comment is not public");
r = await owner.get("/api/comments?status=pending");
ok(r.data.pending === 1 && r.data.comments[0].name === "Sam", "owner sees it in the queue");
const cid = r.data.comments[0].id;
r = await owner.post("/api/comments", { id: cid, action: "approve" });
r = await anon.get("/api/social");
ok(r.data.comments["live-1"]?.[0]?.body === "Nice post!", "approved comment appears for everyone");
ok(!JSON.stringify(r.data).includes("voter"), "comments don't expose who wrote them");
await anon.post("/api/comment", { postId: "live-1", body: "spam", hp: "x" });
ok((await owner.get("/api/comments?status=pending")).data.pending === 0, "honeypot comment is dropped");
r = await anon.post("/api/comment", { postId: "sub-1", body: "hi" });
ok(r.status === 200, "comments allowed on 'everyone' posts");
site = (await owner.get("/api/site")).data.site;
site.posts.find((p) => p.id === "live-1").comments = "subscribers";
site.posts.find((p) => p.id === "quiet-1").comments = "off";
r = await owner.put("/api/site", { site, baseVersion: version }); version = r.data.version;
r = await anon.post("/api/comment", { postId: "live-1", body: "hi" });
ok(r.status === 403, "subscribers-only comments refuse anonymous visitors", r.status);
r = await reader.post("/api/comment", { postId: "live-1", body: "hi from a subscriber" });
ok(r.status === 200, "...but accept subscribers");
r = await anon.post("/api/comment", { postId: "quiet-1", body: "hi" });
ok(r.status === 403, "comments switched off are refused");
r = await owner.post("/api/comment", { postId: "live-1", name: "Gabriel", body: "Thanks all" });
ok(r.data.status === "approved", "the owner's own comments publish immediately");
for (const c of (await owner.get("/api/comments?status=all")).data.comments) await owner.post("/api/comments", { id: c.id, action: "delete" });
ok((await owner.get("/api/comments?status=all")).data.comments.length === 0, "owner can delete comments");

console.log("\nImage upload");
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
r = await owner.post("/api/upload", png, { "content-type": "image/png" });
ok(r.status === 200 && /^\/_blob\/[0-9a-f]{32}$/.test(r.data.url), "owner uploads a PNG", r);
const up = r.data.url;
r = await anon.get(up);
ok(r.status === 200 && /image\/png/.test(r.headers.get("content-type")) && /immutable/.test(r.headers.get("cache-control")), "uploaded image is served and cacheable");
r = await owner.post("/api/upload", new TextEncoder().encode("<svg onload=alert(1)>"), { "content-type": "image/svg+xml" });
ok(r.status === 415, "SVG/HTML uploads are refused", r.status);

console.log("\nDrafts");
r = await owner.put("/api/drafts", { id: "d1", data: { id: "d1", title: "Draft title", updatedAt: 1 } });
ok(r.status === 200, "save draft");
r = await owner.get("/api/drafts");
ok(r.data.drafts.length === 1 && r.data.drafts[0].title === "Draft title", "list drafts");
r = await anon.get("/api/drafts");
ok(r.status === 401, "drafts are private");
await owner.del("/api/drafts?id=d1");
ok((await owner.get("/api/drafts")).data.drafts.length === 0, "delete draft");

console.log("\nSaving safely");
r = await owner.put("/api/site", { site: (await owner.get("/api/site")).data.site, baseVersion: 1 });
ok(r.status === 409, "saving from a stale copy is refused instead of overwriting", r.status);
r = await owner.put("/api/site", { site: { site: {}, tabs: [], posts: [] }, baseVersion: version });
ok(r.status === 400, "a site with no tabs is refused", r.status);

console.log("\nUnsubscribe");
const leaverTok = tokens["leaver@example.com"];
r = await anon.get("/unsubscribe/" + leaverTok);
ok(r.status === 200 && /Yes, unsubscribe/.test(r.text), "link shows a confirm button");
ok(sql(`SELECT status FROM subscribers WHERE email='leaver@example.com'`)[0].status === "confirmed", "opening the link alone doesn't unsubscribe (mail scanners do that)");
r = await anon.req("POST", "/unsubscribe/" + leaverTok, "List-Unsubscribe=One-Click", { nosn: true, "content-type": "application/x-www-form-urlencoded" });
ok(r.status === 200 && sql(`SELECT status FROM subscribers WHERE email='leaver@example.com'`)[0].status === "unsubscribed", "one-click POST unsubscribes");
site = (await owner.get("/api/site")).data.site;
const t1 = Date.now();
site.posts.push(mk({ id: "after-1", title: "After leaving", slug: "after", at: t1 - 100, date: iso(t1) }));
r = await owner.put("/api/site", { site, baseVersion: (await owner.get("/api/site")).data.version });
await sleep(2500);
const after = outbox("subject = 'After leaving'");
ok(after.length === 2 && !after.some((m) => m.to_addr === "leaver@example.com"), "unsubscribed person gets no more posts", after.map((m) => m.to_addr));
r = await owner.get("/api/subscribers.csv");
ok(/email,status/.test(r.text) && /reader@example.com/.test(r.text), "CSV export works");
r = await owner.get("/api/subscribers");
ok(r.data.notifications.some((n) => n.title === "Fresh post" && n.state === "done" && n.sent === 3), "owner can see how many people each post reached", r.data.notifications);

console.log("\nA send that was cut off part-way is recovered");
{
  const rid = sql("SELECT id FROM subscribers WHERE email='reader@example.com'")[0].id;
  const lid = sql("SELECT id FROM subscribers WHERE email='late@example.com'")[0].id;
  const t2 = Date.now();
  sql(`INSERT INTO notified (post_id,state,started_at,title) VALUES ('crash-1','sending',${t2},'Crash post')`);
  sql(`INSERT INTO deliveries (post_id,subscriber_id,status,at) VALUES ('crash-1','${rid}','claimed',${t2 - 15 * 60e3})`);   // abandoned 15 minutes ago
  sql(`INSERT INTO deliveries (post_id,subscriber_id,status,at) VALUES ('crash-1','${lid}','claimed',${t2 - 60e3})`);        // another run is working on this right now
  site = (await owner.get("/api/site")).data.site;
  site.posts.push(mk({ id: "crash-1", title: "Crash post", slug: "crash", at: t2 - 1000, date: iso(t2) }));
  r = await owner.put("/api/site", { site, baseVersion: (await owner.get("/api/site")).data.version });
  await sleep(2500);
  const got = outbox("subject = 'Crash post'").map((m) => m.to_addr);
  ok(got.includes("reader@example.com"), "someone claimed by an abandoned run still gets the email", got);
  ok(!got.includes("late@example.com"), "someone claimed by a run still in progress is not emailed twice", got);
}

console.log("\nPassword lockout (kept last: it blocks this machine for 15 minutes)");
const guesser = new Client();
let last;
for (let i = 0; i < 5; i++) last = await guesser.post("/api/login", { password: "wrong-" + i });
ok(last.status === 401, "wrong passwords are refused");
r = await guesser.post("/api/login", { password: PASSWORD });
ok(r.status === 429, "after 5 wrong tries even the right password is blocked for a while", r.status);
r = await guesser.get("/api/site");
ok(r.data.me.admin === false, "and no session was granted");

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

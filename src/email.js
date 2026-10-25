// Sending email. Production uses Resend (https://resend.com). To use a different provider,
// replace sendBatch() below; nothing else in the project talks to an email service.
//
// EMAIL_MODE=log (set in .dev.vars for local testing) writes messages to the `outbox` table instead.

import { esc, now, sha256Hex } from "./util.js";

// Placeholders used when an email is built once and personalised per subscriber.
export const PH_READ = "{{READ_URL}}";
export const PH_UNSUB = "{{UNSUB_URL}}";

// messages: [{ to, subject, html, text, headers }]  (max 100)
export async function sendBatch(env, messages, idempotencyKey) {
  if (!messages.length) return;
  if (env.EMAIL_MODE === "log") {
    await env.DB.batch(
      messages.map((m) =>
        env.DB.prepare("INSERT INTO outbox (at, to_addr, subject, body) VALUES (?, ?, ?, ?)").bind(now(), m.to, m.subject, JSON.stringify({ text: m.text, html: m.html, headers: m.headers || {} }))
      )
    );
    return;
  }
  if (!env.RESEND_API_KEY) throw new Error("Email isn't set up: the RESEND_API_KEY secret is missing.");
  if (!env.FROM_EMAIL) throw new Error("Email isn't set up: FROM_EMAIL is empty in wrangler.toml.");

  const body = messages.map((m) => ({
    from: env.FROM_EMAIL,
    to: [m.to],
    subject: m.subject,
    html: m.html,
    text: m.text,
    headers: m.headers || undefined,
    ...(env.REPLY_TO ? { reply_to: env.REPLY_TO } : {}),
  }));
  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey.slice(0, 250) } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Email provider said ${res.status}: ${detail}`);
  }
}

export const idemKey = async (parts) => (await sha256Hex(parts.join("|"))).slice(0, 40);

// ---------- templates ----------

function shell({ siteTitle, preheader, bodyHtml, footerHtml }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f6">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || "")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:6px">
<tr><td style="padding:28px 32px 6px;font:600 15px Georgia,serif;letter-spacing:.04em;color:#111">${esc(siteTitle)}</td></tr>
<tr><td style="padding:8px 32px 30px;font:16px/1.6 Georgia,'Times New Roman',serif;color:#222">${bodyHtml}</td></tr>
<tr><td style="padding:16px 32px 26px;border-top:1px solid #e8e8ec;font:12px/1.6 Arial,sans-serif;color:#777">${footerHtml}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href, label) =>
  `<p style="margin:26px 0"><a href="${esc(href)}" style="background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:4px;font:600 14px Arial,sans-serif;display:inline-block">${esc(label)}</a></p>`;

export function confirmEmail({ siteTitle, confirmUrl }) {
  return {
    subject: `Confirm your subscription to ${siteTitle}`,
    html: shell({
      siteTitle,
      preheader: "One click to confirm.",
      bodyHtml: `<p>Thanks for subscribing. Please confirm your email address to start getting new posts.</p>${button(confirmUrl, "Confirm subscription")}<p style="color:#666;font-size:14px">If you didn't ask for this, ignore this email and nothing will happen.</p>`,
      footerHtml: "You received this because someone entered this address on the site.",
    }),
    text: `Thanks for subscribing to ${siteTitle}.\n\nConfirm your email address: ${confirmUrl}\n\nIf you didn't ask for this, ignore this email and nothing will happen.`,
  };
}

export function postEmail({ siteTitle, post, excerpt, coverUrl, readUrl, unsubUrl, address, locked }) {
  const more = locked ? "Read the full post" : "Read on the site";
  return {
    subject: post.title || "New post",
    html: shell({
      siteTitle,
      preheader: excerpt.slice(0, 110),
      bodyHtml: `${coverUrl ? `<p style="margin:12px 0 18px"><a href="${esc(readUrl)}"><img src="${esc(coverUrl)}" alt="" width="496" style="width:100%;max-width:496px;height:auto;border-radius:4px;display:block"></a></p>` : ""}
<h1 style="font:400 30px/1.15 Georgia,serif;margin:14px 0 8px;color:#111"><a href="${esc(readUrl)}" style="color:#111;text-decoration:none">${esc(post.title)}</a></h1>
${post.subtitle ? `<p style="margin:0 0 16px;color:#666;font-size:18px">${esc(post.subtitle)}</p>` : ""}
<p style="margin:0 0 6px">${esc(excerpt)}</p>${button(readUrl, more)}`,
      footerHtml: `You're receiving this because you subscribed to ${esc(siteTitle)}.<br><a href="${esc(unsubUrl)}" style="color:#777">Unsubscribe</a>${address ? `<br>${esc(address)}` : ""}`,
    }),
    text: `${post.title}\n${post.subtitle ? post.subtitle + "\n" : ""}\n${excerpt}\n\n${more}: ${readUrl}\n\n--\nUnsubscribe: ${unsubUrl}${address ? "\n" + address : ""}`,
  };
}

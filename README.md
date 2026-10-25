# Gabriel Horowitz — your site, on your own domain

This is the site from your Claude chat, moved onto its own hosting so it can have:

- **Email signup for anyone** (no Claude account needed), with a confirmation email so nobody can sign up someone else.
- **An email to every subscriber when you publish a post** (also for scheduled posts, when they go live).
- **An "Edit" button** that asks for a password. Anyone with the password can edit the whole site from any browser. Nobody else sees any editing controls.
- **Likes**, and **comments that you approve** before they show.
- **Your own domain**, e.g. `yourname.com`.

Everything you had is carried over: tabs, layout, posts, images, the night-sky look, the launch screen.

Cost: Cloudflare's free plan is enough to start. Email goes through Resend, which also has a free plan. Check both sites' pricing pages for current limits. The domain itself costs roughly $10–15 a year.

---

## 1. Get a domain

Easiest: buy it from **Cloudflare** (dash.cloudflare.com → Domain Registration → Register Domains). Because Cloudflare also hosts the site, everything connects automatically.

If you buy elsewhere (Namecheap, Porkbun, …): in Cloudflare choose **Add a site**, then change the domain's nameservers at your registrar to the two Cloudflare gives you. Wait until Cloudflare says the site is **Active** (minutes to a few hours).

## 2. Put the site online

1. Install **Node.js** (the "LTS" download at nodejs.org).
2. Unzip this folder, open a terminal inside it, and run:
   ```
   npm install
   npm run setup
   ```
3. Follow the prompts. It logs you in to Cloudflare, creates the database and image storage, publishes the site, and asks you to choose your **edit password**. It prints a temporary address ending in `workers.dev`. Open it and the site is there.

You can skip the "site address" and email questions for now and fill them in after step 3 and 4.

## 3. Connect your domain

In Cloudflare: **Workers & Pages → gabriel-site → Settings → Domains & Routes → Add → Custom Domain**, enter `yourname.com`, and add. (Add `www.yourname.com` the same way if you want both.) Cloudflare creates the DNS record for you.

Then open `wrangler.toml`, set:

```
SITE_URL = "https://yourname.com"
```

and run `npm run deploy`. Email links use this address, so don't skip it.

## 4. Turn on email

Emails are sent through [Resend](https://resend.com). It needs to know you own the domain, otherwise mail goes to spam or is refused.

1. Create a free Resend account. **Domains → Add Domain** → enter `yourname.com`. Resend shows a few DNS records; if your domain is on Cloudflare, it can add them for you, otherwise add them in Cloudflare's **DNS** tab. Wait for Resend to show **Verified**.
2. **API Keys → Create API Key** (permission: sending). Copy it.
3. Save it: `npx wrangler secret put RESEND_API_KEY` and paste it.
4. In `wrangler.toml` set:
   ```
   FROM_EMAIL = "Gabriel Horowitz <hello@yourname.com>"
   MAILING_ADDRESS = "Your postal address"
   ```
   (Anti-spam laws such as CAN-SPAM generally require a real postal address in marketing email. A P.O. box works.)
5. `npm run deploy`.
6. **Test it:** open your site in a private window, subscribe with your own address, click the link in the confirmation email, then publish a post. You should get the email within a minute.

Until step 4 is finished, the subscribe form shows "Subscriptions are temporarily unavailable". That's deliberate, so nobody signs up and then never gets a confirmation.

---

## Using it

- **Edit button** (bottom right): enter the password. You're then in editing mode: **+ Post**, **Edit layout**, **Drafts**, **Subscribers**, **Comments**, **Sign out**. You stay signed in on that browser for 14 days.
- **Publishing:** the publish box has a checkbox "Email this post to N subscribers". Untick it for a post you don't want to announce. Updating a published post never emails anyone again.
- **Scheduled posts:** pick a future date. Visitors can't see the post before then. The announcement email goes out within about 10 minutes after the time arrives.
- **Comments:** new ones wait under **Comments** for you to Approve, Reject or Delete. Only you can see them until approved.
- **Subscribers:** shows who's confirmed, who's waiting, the last post's delivery result (and any error), a CSV download, and Remove.
- **Subscribers-only posts and paywall breaks:** the hidden part of the text is never sent to the browser of anyone who isn't a confirmed subscriber. Links inside the emails sign subscribers in automatically on whatever device they open them on.

## Change the password

```
npx wrangler secret put EDIT_PASSWORD
```
Existing sessions stay signed in for up to 14 days. To sign everyone out immediately, also change `SESSION_SECRET` the same way, to any new long random string.

## Back up your content

```
npx wrangler d1 export gabriel-site-db --remote --output backup.sql
```

## Things worth knowing

- **Free-plan limits.** Cloudflare's free plan allows roughly 100,000 dynamic requests a day and short bursts of processing per request. A personal site won't get near that. Emails go out 100 at a time, 2 batches per 10-minute run (`MAX_BATCHES` in `wrangler.toml`), so a big list simply finishes over the next few runs. If you ever pass a few hundred subscribers and want it faster, upgrade the Cloudflare plan and raise `MAX_BATCHES`.
- **Spam protection.** Subscribing is limited per visitor and per address, comments need your approval, and logging in locks out for 15 minutes after 5 wrong passwords. If bots ever become a problem, Cloudflare Turnstile (a free CAPTCHA) is the next step.
- **Who can do what.** The password is checked on the server and never appears in the page's code. A correct password gets a signed cookie; every save, upload and moderation action checks it. Likes are one per browser, not per person.
- **Old subscribers.** The Claude-hosted version had no subscribers or comments, so nothing needed importing.

## Troubleshooting

| What you see | What it means |
|---|---|
| "Editing isn't set up yet" | The `EDIT_PASSWORD` / `SESSION_SECRET` secrets are missing. Run `npm run setup` again. |
| "Subscriptions are temporarily unavailable" | Email isn't finished (step 4). |
| Post published but no email | Open **Subscribers**: the last post's line shows the error, e.g. a wrong key or unverified domain. Fix it, and the next scheduled run (≤10 min) retries automatically. |
| Confirmation emails land in spam | The domain isn't fully verified in Resend yet, or `FROM_EMAIL` uses a different domain. |

## For tinkering

```
cp .dev.vars.example .dev.vars   # local-only password and fake email mode
npm run db:migrate:local
npm run dev                      # http://localhost:8787 (emails are written to a local table, not sent)
npm test                         # 80+ automated checks against a local copy
```
- `public/index.html` is the whole front end. `src/` is the server (`worker.js` routes, `notify.js` announcement emails, `email.js` templates and the one place that talks to Resend).

// `npm run setup` — creates the Cloudflare database + image storage, deploys the site, and sets your secrets.
// Safe to run again: it reuses what already exists.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import readline from "node:readline";
import { parseD1Id, parseKvId, findInJsonList, setTomlValue, findWorkersDevUrl, validEmailAddr } from "./lib.mjs";

const DB_NAME = "gabriel-site-db";
const KV_NAME = "gabriel-site-media";
const TOML = "wrangler.toml";
const wr = (args, opts = {}) => spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", ...opts });
const say = (s = "") => console.log(s);
const step = (n, s) => say(`\n\x1b[1m${n}. ${s}\x1b[0m`);
const die = (s) => { console.error(`\n\x1b[31m${s}\x1b[0m`); process.exit(1); };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
function askHidden(q) {
  return new Promise((res) => {
    if (!process.stdin.isTTY) return ask(q).then(res);
    process.stdout.write(q);
    rl.pause();
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") { process.stdin.setRawMode(false); process.stdin.removeListener("data", onData); process.stdout.write("\n"); rl.resume(); return res(buf); }
        if (c === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1); else buf += c;
      }
    };
    process.stdin.on("data", onData);
  });
}

say("\nThis sets up your site on Cloudflare. It takes about five minutes.");
say("You'll need a free Cloudflare account (https://dash.cloudflare.com/sign-up).");

// 1. login
step(1, "Signing in to Cloudflare");
if (wr(["whoami"]).stdout?.includes("You are not authenticated") || wr(["whoami"]).status !== 0) {
  say("A browser window will open. Log in and click Allow.");
  if (spawnSync("npx", ["wrangler", "login"], { stdio: "inherit" }).status !== 0) die("Login didn't finish. Run `npm run setup` again.");
} else say("Already signed in.");

// Run the create commands from an empty folder so wrangler can't edit wrangler.toml itself.
const scratch = mkdtempSync(join(tmpdir(), "setup-"));
const inScratch = (args) => wr(args, { cwd: scratch });
let toml = readFileSync(TOML, "utf8");

// 2. database
step(2, "Creating the database (posts, subscribers, comments)");
let dbId;
{
  const r = inScratch(["d1", "create", DB_NAME]);
  dbId = parseD1Id((r.stdout || "") + (r.stderr || ""));
  if (!dbId || r.status !== 0) {
    const l = inScratch(["d1", "list", "--json"]);
    dbId = findInJsonList(l.stdout || "", "name", DB_NAME, "uuid");
  }
  if (!dbId) die(`Couldn't create or find the database.\n${(wr(["d1", "create", DB_NAME], { cwd: scratch }).stderr || "").slice(0, 500)}`);
  say(`Database ready (${dbId}).`);
  toml = setTomlValue(toml, "database_id", dbId);
}

// 3. image storage
step(3, "Creating image storage");
let kvId;
{
  const r = inScratch(["kv", "namespace", "create", KV_NAME]);
  kvId = parseKvId((r.stdout || "") + (r.stderr || ""));
  if (!kvId || r.status !== 0) {
    const l = inScratch(["kv", "namespace", "list"]);
    kvId = findInJsonList(l.stdout || "", "title", KV_NAME, "id");
  }
  if (!kvId) die("Couldn't create or find the image storage namespace.");
  say(`Image storage ready (${kvId}).`);
  toml = setTomlValue(toml, "id", kvId, { after: "[[kv_namespaces]]" });
}
writeFileSync(TOML, toml);

// 4. settings you may already know
step(4, "A few settings (press Enter to skip any; you can change them later in wrangler.toml)");
const cur = (k) => (new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m").exec(toml) || [])[1] || "";
const siteUrl = await ask(`Your site's address, e.g. https://yourname.com [${cur("SITE_URL") || "skip"}]: `);
if (siteUrl) toml = setTomlValue(toml, "SITE_URL", siteUrl.replace(/\/+$/, ""));
const from = await ask(`"From" for emails, e.g. Your Name <hello@yourname.com> [${cur("FROM_EMAIL") || "skip"}]: `);
if (from) toml = setTomlValue(toml, "FROM_EMAIL", from);
const addr = await ask(`Mailing address for email footers (recommended, usually required by anti-spam law) [${cur("MAILING_ADDRESS") || "skip"}]: `);
if (addr) toml = setTomlValue(toml, "MAILING_ADDRESS", addr);
writeFileSync(TOML, toml);

// 5. tables
step(5, "Creating the database tables");
if (spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote"], { stdio: "inherit" }).status !== 0) die("Couldn't create the tables. Fix the message above and run `npm run setup` again.");

// 6. deploy
step(6, "Publishing the site");
const deployOut = await new Promise((resolve) => {
  const p = spawn("npx", ["wrangler", "deploy"], { stdio: ["inherit", "pipe", "inherit"] });
  let out = ""; p.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
  p.on("close", (code) => resolve({ code, out }));
});
if (deployOut.code !== 0) die("Publishing failed. Fix the message above and run `npm run setup` again.");
const liveUrl = findWorkersDevUrl(deployOut.out);

// 7. secrets
step(7, "Your edit password and keys");
say("The edit password is what you'll type after clicking the Edit button. Use a long one (a few random words is great).");
let pw = "";
while (pw.length < 10) {
  pw = await askHidden("Choose an edit password (at least 10 characters): ");
  if (pw.length < 10) say("Too short. Try a longer one.");
}
const put = (name, value) => {
  const r = spawnSync("npx", ["wrangler", "secret", "put", name], { input: value + "\n", encoding: "utf8" });
  if (r.status !== 0) die(`Couldn't save ${name}.\n${(r.stderr || "").slice(0, 400)}`);
  say(`Saved ${name}.`);
};
put("EDIT_PASSWORD", pw);
put("SESSION_SECRET", randomBytes(32).toString("hex"));
const resend = await askHidden("Resend API key for sending email (press Enter to add later): ");
if (resend) put("RESEND_API_KEY", resend);

rl.close();
say("\n\x1b[32mDone.\x1b[0m");
if (liveUrl) say(`Your site is live at ${liveUrl}`);
say("Open it, click Edit (bottom right), and sign in with your password.");
say("Next: connect your domain and email. See README.md, sections 3 and 4.\n");

// `npm test`: wipes the LOCAL test database, starts the local server, runs the API tests, stops the server.
// Never touches your real (remote) site.
import { spawn, execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = 8787;
rmSync(".wrangler/state", { recursive: true, force: true });
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local"], { stdio: "ignore" });

const server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--test-scheduled"], { stdio: "ignore", detached: true });
const stop = () => { try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ } };
process.on("exit", stop);

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  up = await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false);
}
if (!up) { console.error("Local server did not start."); stop(); process.exit(1); }

const t = spawn("node", ["test/api.mjs"], { stdio: "inherit", env: { ...process.env, BASE: `http://127.0.0.1:${PORT}` } });
t.on("exit", (code) => { stop(); process.exit(code ?? 1); });

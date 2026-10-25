import assert from "node:assert/strict";
import { parseD1Id, parseKvId, findInJsonList, setTomlValue, findWorkersDevUrl } from "../scripts/lib.mjs";
import { readFileSync } from "node:fs";

assert.equal(parseD1Id('"database_id": "4f6c1e0a-9b1d-4c1e-8a57-0d2f6b7c9e11"'), "4f6c1e0a-9b1d-4c1e-8a57-0d2f6b7c9e11");
assert.equal(parseD1Id("no id here"), null);
assert.equal(parseKvId('id = "0123456789abcdef0123456789abcdef"'), "0123456789abcdef0123456789abcdef");
assert.equal(findInJsonList('warning\n[{"uuid":"aaa","name":"gabriel-site-db"}]', "name", "gabriel-site-db", "uuid"), "aaa");
assert.equal(findInJsonList("garbage", "name", "x", "uuid"), null);
assert.equal(findWorkersDevUrl("Deployed gabriel-site (1s)\n  https://gabriel-site.someone.workers.dev\nCurrent Version ID"), "https://gabriel-site.someone.workers.dev");

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const a = setTomlValue(toml, "database_id", "11111111-2222-3333-4444-555555555555");
assert.match(a, /database_id = "11111111-2222-3333-4444-555555555555"   # `npm run setup` replaces this/);
const b = setTomlValue(a, "id", "ffffffffffffffffffffffffffffffff", { after: "[[kv_namespaces]]" });
assert.match(b, /\nid = "ffffffffffffffffffffffffffffffff"/);
assert.equal((b.match(/database_id = "1111/g) || []).length, 1);          // database id untouched by the kv edit
const c = setTomlValue(b, "SITE_URL", 'https://x.com"; evil = "1');           // quotes can't break out of the value
assert.ok(!/^evil\s*=/m.test(c));
assert.match(c, /SITE_URL = "https:\/\/x\.com\\"; evil = \\"1"/);
console.log("setup helpers: all checks passed");

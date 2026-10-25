// Pure helpers for setup.mjs (kept separate so they can be tested without a Cloudflare account).

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const HEX32_RE = /\b[0-9a-f]{32}\b/i;

export const parseD1Id = (text) => (UUID_RE.exec(text) || [])[0] || null;
export const parseKvId = (text) => (HEX32_RE.exec(text) || [])[0] || null;

// `wrangler d1 list --json` -> [{uuid, name}], `wrangler kv namespace list` -> [{id, title}]
export function findInJsonList(text, field, value, idField) {
  try {
    const start = text.indexOf("[");
    const arr = JSON.parse(text.slice(start));
    const hit = arr.find((x) => x[field] === value);
    return hit ? hit[idField] : null;
  } catch { return null; }
}

// Set `key = "value"` in a TOML file, replacing the existing line (keeps any trailing comment).
export function setTomlValue(toml, key, value, { after } = {}) {
  const re = new RegExp(`^(${key}\\s*=\\s*)"[^"]*"(.*)$`, "m");
  const safe = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (after) {
    // only touch the first match that appears after a given section header
    const i = toml.indexOf(after);
    if (i < 0) throw new Error(`section ${after} not found`);
    const head = toml.slice(0, i), tail = toml.slice(i);
    if (!re.test(tail)) throw new Error(`${key} not found after ${after}`);
    return head + tail.replace(re, `$1"${safe}"$2`);
  }
  if (!re.test(toml)) throw new Error(`${key} not found`);
  return toml.replace(re, `$1"${safe}"$2`);
}

export function findWorkersDevUrl(text) {
  return (/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i.exec(text) || [])[0] || null;
}

export const validEmailAddr = (e) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(e);

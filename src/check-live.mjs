#!/usr/bin/env node
/**
 * check-live.mjs - stamp each role in sweep-final.json with whether it is still open.
 *
 * Postings decay. Between 30 September and 11 October 2026, 5 of the 19
 * roles closed between two checks eleven days apart, all of them unapplied. A worklist that does not
 * know what is dead sends you to dead links and hides the urgency.
 *
 * It also repairs one class of bad URL: a Workable "/apply" suffix 404s while the
 * base posting is fine, which made Pavago look closed when it was open.
 *
 *   node src/check-live.mjs            check everything not already applied to
 *   node src/check-live.mjs --home     only roles open to your country (fast pass)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => path.join(ROOT, ...p);
const HOME_ONLY = process.argv.includes('--home');
const you = JSON.parse(fs.readFileSync(P('you.json'), 'utf8'));
const COUNTRY = String(you.location.country || '');

const roles = JSON.parse(fs.readFileSync(P('state', 'roles.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const isHome = (r) => COUNTRY && new RegExp("\b" + COUNTRY.replace(/[.*+?^${}()|[]\]/g, "\$&") + "\b", "i").test(String(r.locationPolicy || ""));
const isUpwork = (r) => /upwork/i.test(String(r.applyUrl || '') + String(r.applyMethod || ''));

const DEAD_TEXT = /no longer accepting|no longer available|position (is )?closed|this job has expired|has been filled|vacancy (is )?closed|applications are closed/i;

async function probe(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: c.signal });
    clearTimeout(t);
    const body = await res.text();
    if (res.status === 404 || res.status === 410) return { state: 'dead', detail: 'HTTP ' + res.status };
    if (DEAD_TEXT.test(body)) return { state: 'closed', detail: 'page says closed' };
    if (res.ok) return { state: 'open', detail: 'HTTP 200' };
    return { state: 'unknown', detail: 'HTTP ' + res.status };
  } catch (e) {
    return { state: 'unknown', detail: e.name === 'AbortError' ? 'timeout' : 'fetch failed' };
  }
}

// A Workable apply URL 404s; its base posting does not. Try the repair before
// declaring anything dead.
function variants(url) {
  const out = [url];
  if (/apply\.workable\.com\/.+\/apply\/?$/.test(url)) out.push(url.replace(/\/apply\/?$/, ''));
  if (/careers-page\.com\/.+\/apply\/?$/.test(url)) out.push(url.replace(/\/apply\/?$/, ''));
  return out;
}

const todo = roles.filter((r) => !isUpwork(r) && (!HOME_ONLY || isHome(r)));
console.log('checking ' + todo.length + ' postings\n');

let open = 0, dead = 0, unknown = 0, repaired = 0;
for (const r of todo) {
  const start = r.applyUrl || r.url;
  if (!start) { r.live = 'unknown'; continue; }
  let result = { state: 'unknown', detail: 'no url' };
  let usedUrl = start;
  for (const v of variants(start)) {
    result = await probe(v);
    if (result.state === 'open') { usedUrl = v; break; }
  }
  if (result.state === 'open' && usedUrl !== start) { r.applyUrl = usedUrl; repaired += 1; }
  r.live = result.state;
  r.liveCheckedAt = new Date().toISOString().slice(0, 10);
  r.liveDetail = result.detail;
  if (result.state === 'open') open += 1;
  else if (result.state === 'open') unknown += 1;
  else if (result.state === 'unknown') unknown += 1;
  else dead += 1;
  const tag = result.state === 'open' ? 'OPEN' : result.state === 'unknown' ? 'UNKNOWN' : 'DEAD';
  console.log(tag.padEnd(9) + String(r.company || '?').slice(0, 24).padEnd(26) + String(r.title || '').slice(0, 42));
}

fs.writeFileSync(P('state', 'roles.json'), JSON.stringify(roles, null, 2), 'utf8');
console.log('\nopen ' + open + ' | dead or closed ' + dead + ' | unknown ' + unknown + ' | urls repaired ' + repaired);
console.log('stamped into state/roles.json. Re-run src/build-worklist.mjs next.');

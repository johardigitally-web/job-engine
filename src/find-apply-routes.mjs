#!/usr/bin/env node
/**
 * find-apply-routes.mjs - turn form-only roles into emailable ones.
 *
 * Most ATS apply endpoints sit behind reCAPTCHA or Turnstile, so they cannot be
 * submitted from a script and should not be. But the company behind the ATS
 * usually publishes a careers or contact address on its own site, and a direct,
 * specific email to a real inbox is a perfectly good application, often a better
 * one than the form.
 *
 * Reads state/sweep-partial.json (roles found by the sweep), resolves each
 * company's own domain from its name, then hunts that site for an address,
 * preferring careers@ and jobs@ over sales@.
 *
 *   node src/find-apply-routes.mjs
 *   node src/find-apply-routes.mjs --all     include roles that already have an email
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => path.join(ROOT, ...p);
const ALL = process.argv.includes('--all');

const roles = JSON.parse(fs.readFileSync(P('state', 'roles.json'), 'utf8'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
async function grab(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 14000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) return '';
    return await r.text();
  } catch { return ''; } finally { clearTimeout(t); }
}

const BOARD = /(workable|ashbyhq|jazzhr|applytojob|breezy|greenhouse|lever|wellfound|himalayas|remoterocketship|seojobs|careers-page|teamtailor|smartrecruiters|recruitee|bamboohr|indeed|linkedin|glassdoor)/i;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

const slugs = (name) => {
  const clean = String(name || '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|gmbh|bv|corp|co|company|the|group|labs?|technologies|systems|marketing|digital|agency|services|solutions)\b/gi, ' ')
    .replace(/[^a-z0-9 ]/gi, ' ').trim().toLowerCase();
  const w = clean.split(/\s+/).filter(Boolean);
  if (!w.length) return [];
  const out = [];
  for (const base of [...new Set([w.join(''), w.join('-'), w[0]])]) {
    if (base.length < 3) continue;
    for (const tld of ['.com', '.io', '.ai', '.co', '.app', '.dev', '.agency']) out.push(base + tld);
  }
  return out.slice(0, 14);
};

async function resolveDomain(role) {
  // A non-board link inside the posting is the most reliable signal.
  const direct = hostOf(role.applyUrl || '') || hostOf(role.url || '');
  if (direct && !BOARD.test(direct)) return direct;
  const needle = String(role.company || '').replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (needle.length < 4) return '';
  for (const cand of slugs(role.company)) {
    if (BOARD.test(cand)) continue;
    const html = await grab('https://' + cand);
    if (!html || html.length < 400) continue;
    if (html.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(needle)) return cand;
  }
  return '';
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JUNK = /(sentry|example|\.png|\.jpg|\.svg|\.webp|wixpress|godaddy|cloudflare|noreply|no-reply|donotreply|privacy@|abuse@|postmaster@|legal@|dpo@|unsubscribe)/i;

// For a job application, a careers inbox beats a sales inbox. This is the
// opposite ranking to agency-signals.mjs, which is pitching for work.
function bestEmail(list, domain) {
  const own = list.filter((e) => e.toLowerCase().endsWith('@' + domain));
  const pool = own.length ? own : list;
  // Only a real recruiting inbox counts as an application route. Railway proved
  // the point on 23 Sep: team@railway.com is their SUPPORT desk, and it replied
  // telling us to use the form instead. team@ and support@ are not careers@.
  const rank = (e) => {
    const l = e.toLowerCase();
    if (/^(careers|jobs|hiring|recruit(ing)?|apply|talent|joinus|join)@/.test(l)) return 0;
    if (/^(hr|people)@/.test(l)) return 1;
    if (/^(hello|hi)@/.test(l)) return 2;
    if (/^(contact|info|enquiries|inquiries)@/.test(l)) return 3;
    if (/^(team|support|help|admin|billing|sales|no-?reply)@/.test(l)) return 9;
    return 4;
  };
  return pool.sort((a, b) => rank(a) - rank(b))[0] || '';
}

async function findEmail(domain) {
  const found = new Set();
  for (const p of ['/careers', '/jobs', '/contact', '/about', '', '/contact-us', '/company/careers']) {
    const html = await grab('https://' + domain + p);
    if (!html) continue;
    for (const m of html.match(EMAIL_RE) || []) if (!JUNK.test(m)) found.add(m.toLowerCase());
    const mailto = html.match(/mailto:([^"'?>\s]+)/i);
    if (mailto && !JUNK.test(mailto[1])) found.add(mailto[1].toLowerCase());
    if ([...found].some((e) => /^(careers|jobs|hiring|recruit|apply|talent)@/.test(e))) break;
  }
  return bestEmail([...found], domain);
}

const out = [];
const todo = roles.filter((r) => ALL || !(r.applyEmail || '').includes('@'));
console.log('resolving routes for ' + todo.length + ' roles\n');

let i = 0;
for (const r of todo) {
  i += 1;
  const tag = String(r.company || '?').slice(0, 26).padEnd(28);
  process.stdout.write('  [' + i + '/' + todo.length + '] ' + tag);
  const domain = await resolveDomain(r);
  if (!domain) { console.log('no domain'); continue; }
  const email = await findEmail(domain);
  console.log(domain.padEnd(28) + (email || '(no address)'));
  out.push({ ...r, domain, foundEmail: email });
}

fs.writeFileSync(P('state', 'apply-routes.json'), JSON.stringify(out, null, 2), 'utf8');
const withEmail = out.filter((x) => x.foundEmail);
console.log('\n' + withEmail.length + ' of ' + todo.length + ' now have a direct address');
console.log('state/apply-routes.json');

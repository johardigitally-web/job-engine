#!/usr/bin/env node
/**
 * agency-signals.mjs - turn job adverts into sales leads.
 *
 * The reasoning, which is the opposite of the old outreach rule and is the point
 * of this script: a company advertising an SEO or marketing delivery role is
 * telling you, in public and for free, that it has more client work than hands.
 * For someone selling delivery capacity that is not a reason to skip them, it is
 * the strongest buying signal on the open web.
 *
 * Reads state/raw-latest.json (written by jobscan.mjs), keeps the agencies
 * hiring for delivery roles, finds a contact address on their own site, and
 * writes a lead CSV the existing outreach machine can send.
 *
 *   node src/jobscan.mjs && node src/agency-signals.mjs
 *   node src/agency-signals.mjs --no-enrich    skip the site fetch, just list them
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => path.join(ROOT, ...p);
const argv = process.argv.slice(2);
const NO_ENRICH = argv.includes('--no-enrich');

const rawPath = P('state', 'raw-latest.json');
if (!fs.existsSync(rawPath)) {
  console.error('no state/raw-latest.json. Run: node src/jobscan.mjs');
  process.exit(1);
}
const all = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

/* Is the employer an agency, studio or consultancy rather than an end brand? */
const AGENCY = /\b(agency|agencies|studio|consultanc|consulting|marketing firm|white ?label|our clients|for clients|client (relationships?|conversations?|accounts?|portfolio|work|delivery|outcomes)|book of clients|client-facing|per client|each client)\b/i;

/* Is the role a delivery role, the kind a contractor can absorb? */
const DELIVERY = /\b(seo|search engine optimi|ppc|paid (search|media|ads)|google ads|content marketing|web(site)? developer|shopify|wordpress|webflow|technical marketing|growth marketer|growth marketing|digital marketing|marketing (manager|specialist|lead|engineer|associate|coordinator)|ecommerce|e-commerce|lifecycle marketing|demand gen|crm marketing)\b/i;

/* Roles that mean they want an employee to run things, not hands to do work. */
const NOT_DELIVERY = /\b(chief|founder|co-?founder|vp of|vice president|head of (people|talent|hr|finance)|recruiter|talent acquisition|sales representative|account executive)\b/i;

const BAD_HOST = /(weworkremotely|remoteok|remotive|himalayas|arbeitnow|jobicy|greenhouse|lever\.co|workable|ashbyhq|bamboohr|linkedin|twitter|x\.com|facebook|instagram|youtube|github|news\.ycombinator|imgix|gravatar|w3\.org|schema\.org|google\.com|apple\.com|webflow\.com|wordpress\.(com|org)|shopify\.com|squarespace\.com|notion\.so|loom\.com|calendly|glassdoor|indeed\.com|wikipedia)/i;

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/* The employer's own domain, taken from the first non-board link in the post. */
function domainFor(job) {
  const links = String(job.text || '').match(/https?:\/\/[^\s<>")\]]+/gi) || [];
  for (const l of links) {
    const h = hostOf(l);
    if (h && !BAD_HOST.test(h) && h.includes('.')) return h;
  }
  return '';
}

/* Only WeWorkRemotely puts the employer's URL in the posting. Every other feed
 * gives a company name and nothing else, which threw away most of the list. So
 * when there is no link, guess the domain from the name and confirm it by
 * fetching the site and checking the name is actually on the page. */
const slugs = (name) => {
  const clean = String(name || '')
    .replace(/\b(inc|llc|ltd|limited|gmbh|bv|corp|co|company|the|labs?|group|agency|studio|technologies|tech)\b/gi, ' ')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .trim().toLowerCase();
  if (!clean) return [];
  const words = clean.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const joined = words.join('');
  const hyphen = words.join('-');
  const first = words[0];
  const out = [];
  for (const base of [...new Set([joined, hyphen, first])]) {
    if (base.length < 3) continue;
    for (const tld of ['.com', '.io', '.ai', '.co']) out.push(base + tld);
  }
  return out.slice(0, 10);
};

async function resolveDomain(name) {
  // Use the WHOLE flattened name. Truncating it matched "Sanctuary Computer"
  // against sanctuary.com, a completely unrelated company.
  const needle = String(name || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (needle.length < 5) return '';
  for (const cand of slugs(name)) {
    if (BAD_HOST.test(cand)) continue;
    const html = await grab('https://' + cand);
    if (!html || html.length < 500) continue;
    const flat = html.replace(/[^a-z0-9]/gi, '').toLowerCase();
    // The name has to appear on the page, or it is somebody else's domain.
    if (flat.includes(needle)) return cand;
  }
  return '';
}

const UA = 'Mozilla/5.0 (compatible; jobscan/1.0; +https://example.com/jobengine)';
async function grab(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) return '';
    return await r.text();
  } catch { return ''; } finally { clearTimeout(t); }
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JUNK = /(sentry|example|\.png|\.jpg|\.svg|\.webp|wixpress|godaddy|squarespace|shopify|cloudflare|domain|privacy@|abuse@|postmaster@|noreply|no-reply|donotreply)/i;

/* Prefer a human or team address over a legal one. */
function bestEmail(list, domain) {
  const own = list.filter((e) => e.toLowerCase().endsWith('@' + domain));
  const pool = own.length ? own : list;
  const rank = (e) => {
    const l = e.toLowerCase();
    if (/^(hello|hi|team|work|new ?business|newbiz|partnerships?)@/.test(l)) return 0;
    if (/^(contact|info|enquiries|inquiries|sales)@/.test(l)) return 1;
    if (/^(careers|jobs|apply|hr|recruit)@/.test(l)) return 3;
    return 2;
  };
  return pool.sort((a, b) => rank(a) - rank(b))[0] || '';
}

async function findEmail(domain) {
  const paths = ['', '/contact', '/contact-us', '/about', '/get-in-touch'];
  const found = new Set();
  for (const p of paths) {
    const html = await grab('https://' + domain + p);
    if (!html) continue;
    for (const m of html.match(EMAIL_RE) || []) {
      if (!JUNK.test(m)) found.add(m.toLowerCase());
    }
    // A mailto: is the most reliable signal, so stop as soon as one turns up.
    const mailto = html.match(/mailto:([^"'?>\s]+)/i);
    if (mailto && !JUNK.test(mailto[1])) { found.add(mailto[1].toLowerCase()); break; }
    if (found.size) break;
  }
  return bestEmail([...found], domain);
}

/* ---------- select ---------- */

const seen = new Set();
const leads = [];
for (const j of all) {
  const blob = (j.title || '') + ' ' + (j.company || '') + ' ' + String(j.text || '').slice(0, 2500);
  // The role must be one a contractor could absorb, and it must be the job on
  // offer rather than a passing mention, so the title has to carry it.
  if (!DELIVERY.test(j.title || '')) continue;
  if (NOT_DELIVERY.test(j.title || '')) continue;
  // Agencies resell the hours, so they are the warmer tier. An in-house team
  // hiring the same role is short of the same hands and still worth writing to.
  const tier = AGENCY.test(blob) ? 'agency' : 'inhouse';

  let domain = domainFor(j);
  if (!domain) domain = await resolveDomain(j.company);
  if (!domain || seen.has(domain)) continue;
  seen.add(domain);

  leads.push({
    company: j.company || domain.split('.')[0],
    domain,
    tier,
    hiringFor: j.title,
    source: j.source,
    postUrl: j.url,
    email: '',
  });
}

leads.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'agency' ? -1 : 1));
const nAgency = leads.filter((l) => l.tier === 'agency').length;
console.log('companies hiring delivery roles: ' + leads.length + ' (' + nAgency + ' agency, ' + (leads.length - nAgency) + ' in-house)');

if (!NO_ENRICH) {
  let i = 0;
  for (const l of leads) {
    i += 1;
    process.stdout.write('  [' + i + '/' + leads.length + '] ' + l.domain.padEnd(30));
    l.email = await findEmail(l.domain);
    console.log(l.email || '(none found)');
  }
}

const withEmail = leads.filter((l) => l.email);

const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
const header = ['company', 'domain', 'email', 'tier', 'hiringFor', 'source', 'postUrl'];
const csv = [header.join(',')]
  .concat(withEmail.map((l) => header.map((h) => esc(l[h])).join(',')))
  .join('\n');

fs.mkdirSync(P('out'), { recursive: true });
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(P('out', today + '-agency-leads.csv'), csv, 'utf8');
fs.writeFileSync(P('out', 'agency-leads.json'), JSON.stringify(leads, null, 2), 'utf8');

console.log('\nwith a contact address: ' + withEmail.length);
console.log('csv   out/' + today + '-agency-leads.csv');
console.log('json  out/agency-leads.json');

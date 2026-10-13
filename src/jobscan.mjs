#!/usr/bin/env node
/**
 * jobscan.mjs - pull every free remote-job source, score each posting against
 * profile.json, drop anything seen before, write a dated digest and a queue.
 *
 * No dependencies. No API keys. No paid tier. Node 18+ (native fetch).
 *
 *   node src/jobscan.mjs             normal daily run
 *   node src/jobscan.mjs --all       ignore the seen list, re-score everything
 *   node src/jobscan.mjs --min=25    override the score threshold
 *   node src/jobscan.mjs --quiet     no per-source chatter
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => path.join(ROOT, ...p);
const profile = JSON.parse(fs.readFileSync(P('profile.json'), 'utf8'));
const you = (() => {
  try { return JSON.parse(fs.readFileSync(P('you.json'), 'utf8')); }
  catch { console.error('No you.json. Copy you.example.json to you.json first.'); process.exit(1); }
})();

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.split('=')[1] : d;
};
const QUIET = flag('quiet');
const MIN = Number(opt('min', profile.minScore));
const log = (...a) => { if (!QUIET) console.log(...a); };

const UA = 'Mozilla/5.0 (compatible; jobscan/1.0; +https://example.com/jobengine)';
const TIMEOUT = 25000;

async function get(url, as = 'json') {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return as === 'json' ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* ---------- helpers ---------- */

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" };

// Decode entities BEFORE stripping tags, then strip again: some feeds (WWR)
// ship HTML that is entity-escaped inside CDATA, so one pass leaves raw markup.
const decode = (s) => String(s || '')
  .replace(/&([a-z#0-9x]+);/gi, (m, e) => ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : ' ');

const tags = (s) => String(s || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ');

const strip = (h) => tags(decode(tags(decode(h)))).replace(/\s+/g, ' ').trim();

const days = (d) => {
  const t = new Date(d).getTime();
  if (!t || Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86400000);
};

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const emailsIn = (s) => [...new Set(String(s).match(EMAIL_RE) || [])]
  .filter((e) => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e))
  .filter((e) => !/(sentry|example|wixpress|godaddy)/i.test(e));

/* ---------- sources ---------- */

const sources = {
  async remoteok() {
    const j = await get('https://remoteok.com/api');
    return j.slice(1).map((x) => ({
      source: 'RemoteOK',
      id: 'remoteok:' + x.id,
      title: x.position,
      company: x.company,
      url: x.url || ('https://remoteok.com/l/' + x.id),
      location: x.location || 'Remote',
      salary: x.salary_min ? '$' + x.salary_min + '-' + x.salary_max : '',
      tags: x.tags || [],
      posted: x.date,
      text: strip(x.description),
    }));
  },

  async remotive() {
    const j = await get('https://remotive.com/api/remote-jobs?limit=500');
    return (j.jobs || []).map((x) => ({
      source: 'Remotive',
      id: 'remotive:' + x.id,
      title: x.title,
      company: x.company_name,
      url: x.url,
      location: x.candidate_required_location || 'Remote',
      salary: x.salary || '',
      tags: x.tags || [],
      posted: x.publication_date,
      text: strip(x.description),
    }));
  },

  async arbeitnow() {
    const j = await get('https://www.arbeitnow.com/api/job-board-api');
    return (j.data || []).filter((x) => x.remote).map((x) => ({
      source: 'Arbeitnow',
      id: 'arbeitnow:' + x.slug,
      title: x.title,
      company: x.company_name,
      url: x.url,
      location: x.location || 'Remote',
      salary: '',
      tags: [...(x.tags || []), ...(x.job_types || [])],
      posted: x.created_at ? new Date(x.created_at * 1000).toISOString() : '',
      text: strip(x.description),
    }));
  },

  async jobicy() {
    const j = await get('https://jobicy.com/api/v2/remote-jobs?count=50');
    return (j.jobs || []).map((x) => ({
      source: 'Jobicy',
      id: 'jobicy:' + x.id,
      title: x.jobTitle,
      company: x.companyName,
      url: x.url,
      location: Array.isArray(x.jobGeo) ? x.jobGeo.join(', ') : (x.jobGeo || 'Remote'),
      salary: x.annualSalaryMin ? String(x.annualSalaryMin) + '+ ' + (x.salaryCurrency || '') : '',
      tags: [...(x.jobIndustry || []), ...(x.jobType || [])],
      posted: x.pubDate,
      text: strip(x.jobExcerpt || x.jobDescription),
    }));
  },

  async workingnomads() {
    const j = await get('https://www.workingnomads.com/api/exposed_jobs/');
    return (Array.isArray(j) ? j : []).map((x) => ({
      source: 'WorkingNomads',
      id: 'wn:' + (x.slug || x.url),
      title: x.title,
      company: x.company_name,
      url: x.url,
      location: x.location || 'Remote',
      salary: '',
      tags: String(x.category_name || '').split(',').concat(String(x.tags || '').split(',')).filter(Boolean),
      posted: x.pub_date,
      text: strip(x.description),
    }));
  },

  async jobspresso() {
    const xml = await get('https://jobspresso.co/feed/?post_type=job_listing', 'text');
    const items = xml.split(/<item>/).slice(1);
    return items.map((chunk) => {
      const pick = (tag) => {
        const m = chunk.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i'));
        if (!m) return '';
        return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
      };
      const raw = decode(pick('title'));
      const at = raw.lastIndexOf(' at ');
      return {
        source: 'Jobspresso',
        id: 'jobspresso:' + pick('link'),
        title: at > 0 ? raw.slice(0, at).trim() : raw,
        company: at > 0 ? raw.slice(at + 4).trim() : '',
        url: pick('link'),
        location: 'Remote',
        salary: '',
        tags: [],
        posted: pick('pubDate'),
        text: strip(pick('description') + ' ' + pick('content:encoded')),
      };
    });
  },

  async himalayas() {
    const pages = await Promise.all([0, 100, 200].map((off) =>
      get('https://himalayas.app/jobs/api?limit=100&offset=' + off).catch(() => ({ jobs: [] }))));
    const j = { jobs: pages.flatMap((p) => p.jobs || []) };
    return (j.jobs || []).map((x) => ({
      source: 'Himalayas',
      id: 'himalayas:' + (x.guid || x.applicationLink),
      title: x.title,
      company: x.companyName,
      url: x.applicationLink,
      location: (x.locationRestrictions || []).join(', ') || 'Worldwide',
      salary: x.minSalary ? '$' + x.minSalary + '-' + (x.maxSalary || '?') : '',
      tags: x.categories || [],
      posted: x.pubDate ? new Date(x.pubDate * 1000).toISOString() : '',
      text: strip(x.excerpt || x.description),
    }));
  },

  async weworkremotely() {
    const xml = await get('https://weworkremotely.com/remote-jobs.rss', 'text');
    const items = xml.split(/<item>/).slice(1);
    return items.map((chunk) => {
      const pick = (tag) => {
        const m = chunk.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i'));
        if (!m) return '';
        return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
      };
      const raw = decode(pick('title'));
      const parts = raw.split(':');
      const company = parts.length > 1 ? parts[0].trim() : '';
      const title = parts.length > 1 ? parts.slice(1).join(':').trim() : raw;
      return {
        source: 'WeWorkRemotely',
        id: 'wwr:' + pick('link'),
        title,
        company,
        url: pick('link'),
        location: pick('region') || 'Remote',
        salary: '',
        tags: [pick('category')].filter(Boolean),
        posted: pick('pubDate'),
        text: strip(pick('description')),
      };
    });
  },

  // Hacker News "Ask HN: Who is hiring?" - the monthly thread. Top-level
  // comments are the postings, and many carry a direct email address, which
  // makes this the one board we can apply to without going through a form.
  async hackernews() {
    const s = await get('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5');
    const story = (s.hits || []).find((h) => /who is hiring/i.test(h.title || ''));
    if (!story) return [];
    const item = await get('https://hn.algolia.com/api/v1/items/' + story.objectID);
    return (item.children || [])
      .filter((c) => c.text && !c.deleted)
      .map((c) => {
        const t = strip(c.text);
        return {
          source: 'HN whoishiring',
          id: 'hn:' + c.id,
          title: t.split(/[|\n]/)[0].slice(0, 110),
          company: c.author || '',
          url: 'https://news.ycombinator.com/item?id=' + c.id,
          location: /remote/i.test(t) ? 'Remote' : '',
          salary: '',
          tags: [],
          posted: c.created_at,
          text: t,
          emails: emailsIn(t),
        };
      })
      .filter((j) => /remote/i.test(j.text));
  },
};

/* ---------- scoring ---------- */

const rx = (k) => new RegExp(k, 'i');
const label = (k) => k.split('|')[0].replace(/\\b/g, '').replace(/[?]/g, '');

/* Can someone in your country actually take this job?
 *
 * Boards state eligibility in free text, so this is deliberately cautious: a
 * posting is rejected only when it names a restriction that clearly excludes
 * you. Anything ambiguous is kept and flagged, because a false reject is worse
 * than a false keep - you can skim a bad row in a second, but you never see a
 * role the filter silently threw away. */
const COUNTRY = String(you.location.country || '').trim();
const REGIONS = (you.location.regions || []).map((x) => String(x).toLowerCase());

function locationVerdict(job) {
  const where = (String(job.location || '') + ' ' + String(job.text || '').slice(0, 1200)).toLowerCase();
  const openToAll = /worldwide|anywhere in the world|fully remote|remote, global|work from anywhere|any country|globally/.test(where);
  const namesMe = COUNTRY && where.includes(COUNTRY.toLowerCase());
  const namesMyRegion = REGIONS.some((r) => r && where.includes(r));
  if (namesMe) return 'eligible';
  if (openToAll) return 'eligible';

  // An explicit "X only" that is not yours is the one safe reject.
  const onlyRe = /(?:only|must (?:be|reside|live)(?: located)?(?: in)?|based in|located in|authorized to work in|residents? of)[^.;)]{0,60}/g;
  const claims = where.match(onlyRe) || [];
  if (claims.length) {
    const mine = claims.some((c) => (COUNTRY && c.includes(COUNTRY.toLowerCase())) || REGIONS.some((r) => r && c.includes(r)));
    if (!mine) return 'restricted';
  }
  if (job.onsite && !you.location.acceptOnsite) return 'restricted';
  return 'unclear';
}

function score(job) {
  const title = String(job.title || '');
  const body = title + ' ' + (job.tags || []).join(' ') + ' ' + String(job.text || '').slice(0, 2500);
  if (!rx(profile.mustMatchOne).test(body)) return null;
  const loc = locationVerdict(job);
  if (loc === 'restricted' && you.location.hideRestricted !== false) return null;

  let total = 0;
  const why = [];
  for (const [k, w] of Object.entries(profile.score)) {
    if (!rx(k).test(body)) continue;
    const inTitle = rx(k).test(title);
    total += inTitle ? w * 2 : w;
    why.push(label(k) + (inTitle ? '*' : ''));
  }
  for (const [k, w] of Object.entries(profile.penalty)) {
    if (rx(k).test(body)) { total += w; why.push('-' + label(k)); }
  }
  // Seniority and role-type penalties only count in the title. "Head of Growth"
  // turns up in the body of half the postings on earth and is not a signal there.
  for (const [k, w] of Object.entries(profile.titlePenalty || {})) {
    if (rx(k).test(title)) { total += w; why.push('-' + label(k) + '*'); }
  }
  return { ...job, score: total, why, eligibility: loc };
}

/* ---------- state ---------- */

const seenPath = P('state', 'seen.json');
const seen = fs.existsSync(seenPath) ? JSON.parse(fs.readFileSync(seenPath, 'utf8')) : {};

/* ---------- run ---------- */

const all = [];
const report = [];
for (const [name, fn] of Object.entries(sources)) {
  try {
    const rows = await fn();
    all.push(...rows);
    report.push(name + ': ' + rows.length);
    log('  ' + name.padEnd(16) + String(rows.length).padStart(4) + ' postings');
  } catch (e) {
    report.push(name + ': FAILED (' + e.message + ')');
    log('  ' + name.padEnd(16) + '   ! ' + e.message);
  }
}

const fresh = flag('all') ? all : all.filter((j) => !seen[j.id]);
const aged = fresh.filter((j) => !j.posted || days(j.posted) <= profile.maxAgeDays);

const hits = aged
  .map(score)
  .filter(Boolean)
  .filter((j) => j.score >= MIN)
  .sort((a, b) => b.score - a.score)
  .slice(0, profile.digestTop);

const today = new Date().toISOString().slice(0, 10);
const L = [];
L.push('# Remote job scan - ' + today);
L.push('');
L.push('Pulled ' + all.length + ' postings from ' + Object.keys(sources).length + ' free sources. '
  + fresh.length + ' were new, ' + aged.length + ' inside ' + profile.maxAgeDays + ' days, '
  + '**' + hits.length + ' scored ' + MIN + ' or better.**');
L.push('');
L.push('Sources: ' + report.join(' | '));
L.push('');

if (!hits.length) {
  L.push('No matches today. That is a real answer, not a failure - see PLAYBOOK.md section 2 '
    + 'on why these boards run thin for this skill set, and why Upwork carries the volume.');
} else {
  for (const j of hits) {
    L.push('## ' + j.score + ' - ' + j.title);
    L.push('**' + (j.company || 'unknown') + '** | ' + j.source + ' | ' + (j.location || 'Remote')
      + (j.salary ? ' | ' + j.salary : '') + (j.posted ? ' | ' + days(j.posted) + 'd old' : ''));
    L.push('');
    L.push(j.url);
    if (j.emails && j.emails.length) L.push('Apply by email: ' + j.emails.join(', '));
    L.push('');
    L.push('Matched: ' + j.why.join(', ') + '  (* = in the title, scored double)');
    L.push('');
    L.push('> ' + String(j.text).slice(0, 320) + '...');
    L.push('');
  }
}

fs.mkdirSync(P('out'), { recursive: true });
fs.writeFileSync(P('out', today + '-digest.md'), L.join('\n'), 'utf8');

// The queue is a standing worklist, not a snapshot. Merge today's hits into
// whatever is still pending, drop anything already applied to, and drop
// anything that has aged out. Re-running the scan must never lose work.
const queuePath = P('out', 'queue.json');
const prev = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : [];
const appliedPath = P('state', 'applied.json');
const applied = fs.existsSync(appliedPath) ? JSON.parse(fs.readFileSync(appliedPath, 'utf8')) : {};
const doneIds = new Set((applied.boards || []).map((a) => a.id));

const byId = new Map();
for (const j of [...(Array.isArray(prev) ? prev : []), ...hits]) {
  if (doneIds.has(j.id)) continue;
  if (j.posted && days(j.posted) > profile.maxAgeDays) continue;
  byId.set(j.id, { ...(byId.get(j.id) || {}), ...j });
}
const queue = [...byId.values()].sort((a, b) => b.score - a.score);
fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');

// Every normalised posting, so other lenses can read the same pull without
// re-fetching or duplicating the source code. agency-signals.mjs uses this.
fs.writeFileSync(P('state', 'raw-latest.json'), JSON.stringify(all, null, 2), 'utf8');

// The canonical role store. check-live.mjs stamps it, build-worklist.mjs renders
// it. Merged rather than overwritten so yesterday's matches are not lost.
const rolesPath = P('state', 'roles.json');
const prevRoles = fs.existsSync(rolesPath) ? JSON.parse(fs.readFileSync(rolesPath, 'utf8')) : [];
const roleById = new Map(prevRoles.map((r) => [r.id || r.url, r]));
for (const h of hits) roleById.set(h.id || h.url, { ...(roleById.get(h.id || h.url) || {}), ...h,
  applyUrl: h.url, locationPolicy: h.location, company: h.company, title: h.title });
fs.writeFileSync(rolesPath, JSON.stringify([...roleById.values()], null, 2), 'utf8');
console.log('roles   state/roles.json (' + roleById.size + ' total)');

for (const j of all) seen[j.id] = seen[j.id] || today;
fs.mkdirSync(P('state'), { recursive: true });
fs.writeFileSync(seenPath, JSON.stringify(seen, null, 2), 'utf8');

console.log('\nscanned ' + all.length + ' | new ' + fresh.length + ' | matched ' + hits.length + ' (min ' + MIN + ')');
console.log('digest  out/' + today + '-digest.md');
console.log('queue   out/queue.json');

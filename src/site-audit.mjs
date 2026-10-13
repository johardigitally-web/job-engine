#!/usr/bin/env node
/**
 * site-audit.mjs - find real, checkable technical SEO faults on a site.
 *
 * This exists because the strongest applications in this campaign all opened
 * with something specific the reader could verify on their own property, not a
 * claim about the candidate. The same thing should drive client outreach: do not offer
 * an audit, show one finding from it.
 *
 * Dependency free, no API keys. PageSpeed Insights is not used because its
 * keyless quota is exhausted; everything here is checked by fetching the pages.
 *
 *   node src/site-audit.mjs example.com
 *   node src/site-audit.mjs example.com --json
 */

import { argv } from 'node:process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const JSON_OUT = argv.includes('--json');

async function get(url, timeout = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: c.signal });
    const body = await r.text();
    return { ok: r.ok, status: r.status, url: r.url, body, headers: r.headers, bytes: body.length };
  } catch (e) {
    return { ok: false, status: 0, url, body: '', headers: new Headers(), bytes: 0, err: e.name };
  } finally { clearTimeout(t); }
}

const tag = (html, re) => { const m = html.match(re); return m ? m[1].trim() : ''; };
const all = (html, re) => [...html.matchAll(re)];
const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function jsonLdBlocks(html) {
  const out = [];
  for (const m of all(html, /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      for (const node of (Array.isArray(parsed) ? parsed : [parsed])) {
        const graph = node['@graph'];
        for (const n of (graph ? graph : [node])) if (n && n['@type']) out.push(n);
      }
    } catch { out.push({ '@type': 'INVALID_JSON' }); }
  }
  return out;
}

async function auditPage(url) {
  const r = await get(url);
  if (!r.ok) return { url, reachable: false, status: r.status, err: r.err };
  const h = r.body;
  const types = jsonLdBlocks(h).map((n) => String(Array.isArray(n['@type']) ? n['@type'][0] : n['@type']));
  return {
    url: r.url,
    reachable: true,
    status: r.status,
    bytes: r.bytes,
    title: strip(tag(h, /<title[^>]*>([\s\S]*?)<\/title>/i)),
    metaDesc: tag(h, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
      || tag(h, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i),
    h1s: all(h, /<h1[^>]*>([\s\S]*?)<\/h1>/gi).map((m) => strip(m[1])).filter(Boolean),
    canonical: tag(h, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i),
    noindex: /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(h),
    hreflang: all(h, /<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']+)["']/gi).map((m) => m[1]),
    jsonLdTypes: [...new Set(types)],
    imgTotal: all(h, /<img\b[^>]*>/gi).length,
    imgNoAlt: all(h, /<img\b(?![^>]*\balt=)[^>]*>/gi).length,
    renderBlockingCss: all(h, /<link[^>]+rel=["']stylesheet["'][^>]*>/gi).length,
    // matchAll needs a global regex, so the head is pulled with a plain match first.
    headScripts: (() => {
      const head = h.match(/<head[\s\S]*?<\/head>/i);
      if (!head) return 0;
      return all(head[0], /<script\b(?![^>]*\b(?:async|defer)\b)(?![^>]*application\/ld\+json)[^>]*\bsrc=/gi).length;
    })(),
    viewport: /<meta[^>]+name=["']viewport["']/i.test(h),
    platform: /cdn\.shopify\.com|shopify/i.test(h) ? 'Shopify'
      : /wp-content|wp-includes/i.test(h) ? 'WordPress'
      : /cdn\.webflow|webflow\.io/i.test(h) ? 'Webflow'
      : /squarespace/i.test(h) ? 'Squarespace' : 'unknown',
  };
}

export async function auditSite(domain) {
  const base = 'https://' + String(domain).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const findings = [];
  const home = await auditPage(base);
  if (!home.reachable) return { domain, reachable: false, findings: [], home };

  // robots.txt and sitemap
  const robots = await get(base + '/robots.txt');
  const hasRobots = robots.ok && /user-agent/i.test(robots.body);
  const sitemapInRobots = hasRobots && /sitemap:/i.test(robots.body);
  let sitemapOk = false;
  if (sitemapInRobots) {
    const sm = (robots.body.match(/sitemap:\s*(\S+)/i) || [])[1];
    if (sm) { const r = await get(sm); sitemapOk = r.ok && /<urlset|<sitemapindex/i.test(r.body); }
  } else {
    const r = await get(base + '/sitemap.xml');
    sitemapOk = r.ok && /<urlset|<sitemapindex/i.test(r.body);
  }

  const F = (severity, what, evidence) => findings.push({ severity, what, evidence });

  if (!hasRobots) F('high', 'No robots.txt', base + '/robots.txt does not return a valid robots file.');
  if (!sitemapOk) F('high', 'No reachable XML sitemap', sitemapInRobots
    ? 'robots.txt declares a sitemap but it does not return valid XML.'
    : 'No sitemap declared in robots.txt and /sitemap.xml does not return valid XML. Google has no crawl map.');
  if (home.noindex) F('critical', 'Homepage carries noindex', 'The homepage meta robots tag contains noindex, so it is excluded from search entirely.');
  if (!home.canonical) F('medium', 'No canonical tag on the homepage', 'Nothing tells Google which URL is authoritative, which invites duplicate indexing of parameter and trailing-slash variants.');
  if (!home.title) F('high', 'Homepage has no title tag', 'There is no <title> element at all.');
  else if (home.title.length > 65) F('low', 'Homepage title is ' + home.title.length + ' characters', 'It will be truncated in results. Current: "' + home.title.slice(0, 90) + '"');
  if (!home.metaDesc) F('medium', 'No meta description on the homepage', 'Google writes its own snippet instead, so the result text is not yours.');
  if (home.h1s.length === 0) F('medium', 'No H1 on the homepage', 'Nothing states the page topic in the primary heading.');
  else if (home.h1s.length > 1) F('low', home.h1s.length + ' H1 tags on the homepage', 'Multiple H1s: ' + home.h1s.slice(0, 3).map((x) => '"' + x.slice(0, 40) + '"').join(', '));
  if (home.jsonLdTypes.length === 0) F('high', 'No structured data anywhere on the homepage',
    'There is no JSON-LD on the page, so no Organization, LocalBusiness or Product markup. Nothing is eligible for rich results and answer engines have no structured record of the business.');
  else if (home.jsonLdTypes.includes('INVALID_JSON')) F('high', 'Structured data present but the JSON does not parse', 'A ld+json block on the homepage is malformed, so Google discards it silently.');
  if (home.imgTotal > 4 && home.imgNoAlt / home.imgTotal > 0.4)
    F('medium', home.imgNoAlt + ' of ' + home.imgTotal + ' homepage images have no alt attribute', 'Image search and accessibility both lose, and it is a one-pass template fix.');
  if (home.headScripts >= 3) F('medium', home.headScripts + ' render-blocking scripts in the head',
    'Each one delays first paint. These are the usual cause of a poor LCP and INP on mobile.');
  if (!home.viewport) F('high', 'No viewport meta tag', 'The site is not declaring mobile responsiveness, which affects mobile ranking directly.');
  if (home.bytes > 400000) F('low', 'Homepage HTML is ' + Math.round(home.bytes / 1024) + 'KB before images',
    'Large HTML payloads slow first paint on mobile connections.');

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { domain, reachable: true, platform: home.platform, home, findings };
}

if (argv[2] && !argv[2].startsWith('--')) {
  const res = await auditSite(argv[2]);
  if (JSON_OUT) { console.log(JSON.stringify(res, null, 2)); }
  else {
    console.log('\n' + res.domain + (res.platform && res.platform !== 'unknown' ? '  [' + res.platform + ']' : ''));
    if (!res.reachable) { console.log('  not reachable'); }
    else if (!res.findings.length) { console.log('  no obvious faults found'); }
    else for (const f of res.findings) console.log('  [' + f.severity.toUpperCase() + '] ' + f.what + '\n        ' + f.evidence);
  }
}

# Job Engine

Finds job postings from nine public sources, scores them against your profile,
checks they are still open, researches each company, and builds a ranked list
you can work through in a few minutes.

No API keys. No paid services. No account anywhere. Node 18 or newer is the only
requirement.

---

## What it does, and what it deliberately does not

It does everything up to the submit button:

- pulls from nine public job sources, roughly 500 postings a day
- scores each one against skills and keywords you set
- drops anything whose stated eligibility excludes your country
- checks every posting is still live, and repairs broken apply URLs
- finds a real application route, preferring a careers inbox over a form
- audits a company's own website for faults you can open an application with
- writes a ranked worklist with every answer prepared

**It does not submit applications for you, and that is on purpose.**

Across a real three week campaign the numbers were:

| Route | Sent | Interviews |
|---|---|---|
| Email | 28 | 0 |
| Company application form | 1 | 1 |

Twenty-eight automated emails produced nothing. The single application put
through a company's own form produced a booked interview. Twenty-one of those
emails had gone to `info@`, `hello@` or `support@` addresses, which are sales and
support desks that never reach anyone hiring.

Most ATS forms also sit behind reCAPTCHA or Cloudflare Turnstile and cannot be
submitted by a script. So the engine prepares and you click. Two minutes a day
beats a bot that applies to the wrong things quickly.

---

## Setup

```bash
git clone <this repo>
cd job-engine
cp you.example.json you.json
cp profile.example.json profile.json
```

Then edit the two files. Nothing else is needed and nothing is installed.

### `you.json` — who you are

```json
{
  "name": "Your Name",
  "email": "you@example.com",
  "location": {
    "country": "Pakistan",
    "city": "Lahore",
    "timezone": "UTC+5",
    "regions": ["south asia", "apac", "asia"],
    "acceptOnsite": true,
    "acceptRemote": true,
    "hideRestricted": true
  },
  "rate": { "hourly": "$20", "monthly": "$1,500 full time" }
}
```

This is used two ways. It fills the "standard answers" block at the top of your
worklist so you never retype your details, and it drives the location filter.

### `profile.json` — what you want to do

This is the part that decides which jobs reach you. Keys are case-insensitive
regular expressions, values are points. **A match in the job title scores
double.**

```json
{
  "score": {
    "senior (software|backend) engineer": 30,
    "\\bpython\\b|\\bdjango\\b": 26,
    "\\bpostgres(ql)?\\b|\\bredis\\b": 18,
    "\\bAWS\\b|terraform": 16
  },
  "penalty": {
    "unpaid|equity only": -100,
    "us only|citizens? only|security clearance": -60
  },
  "titlePenalty": {
    "\\bintern\\b": -30,
    "sales|account manager": -40
  },
  "mustMatchOne": "\\bpython\\b|\\bdjango\\b|backend|software engineer",
  "minScore": 30,
  "maxAgeDays": 21
}
```

Four things to understand:

- **`score`** is what you want. Put your strongest, most specific skills at the
  top with the highest numbers. Be specific: `"django"` is far more useful than
  `"programming"`.
- **`penalty`** subtracts anywhere in the posting. Use it for hard
  disqualifiers, especially eligibility ones like `us only`.
- **`titlePenalty`** subtracts only on a title match. Seniority and role-type
  words belong here, because phrases like "head of" appear in the body of half
  of all job adverts and mean nothing there.
- **`mustMatchOne`** is the gate. A posting that does not match it is never
  scored at all. Keep this broad; narrow with penalties instead.

---

## How to find jobs in your location

The location filter is deliberately cautious. A posting is rejected only when it
names a restriction that clearly excludes you, because a false reject is worse
than a false keep: you can skim a bad row in a second, but you never see a role
the filter silently threw away.

Set your country, city and the regions you might plausibly be included in:

```json
"regions": ["south asia", "apac", "asia", "emea"]
```

Each matched posting is then labelled:

| Verdict | Meaning |
|---|---|
| `eligible` | names your country, or says worldwide |
| `unclear` | states no restriction either way, which is most postings |
| `restricted` | names an "only" rule that is not yours, so it is hidden |

Set `"hideRestricted": false` if you would rather see everything and judge for
yourself.

The worklist then groups results into three tiers:

- **Tier A** — postings that name your country. These are the least contested
  and the best use of your time, because you are in the target pool rather than
  asking for an exception.
- **Tier B** — genuinely worldwide.
- **Tier C** — remote, with no eligibility stated.

### About onsite work

Be realistic about this. Seven of the nine sources are remote-only job boards,
so for **onsite roles in a specific city** this engine is thin. Arbeitnow carries
European onsite listings and HN "Who is hiring" includes some, but the big local
boards (LinkedIn, Indeed, and most country-specific sites) actively block
automated access and are not included.

Where it is strong is **remote work that will accept someone in your country**,
which is a different and often better question than "jobs in my city".

---

## Daily use

```bash
npm run daily
```

That runs the scan, the liveness check and the worklist in sequence. Then open
`out/APPLY-NOW.md` and work down from Tier A.

Individual commands:

```bash
npm run scan          # pull and score today's postings
npm run scan:loose    # same, with a lower threshold when the board is quiet
npm run live          # re-check every saved posting is still open
npm run routes        # find a careers inbox for roles that only show a form
npm run list          # rebuild the worklist
npm run audit -- example.com    # audit one site for faults
```

### Why the liveness check matters

Postings decay. In one eleven day gap, about a quarter of the saved roles had
closed, including the single best one, all of them unapplied. `npm run live`
stamps each posting open, dead or unknown, and the worklist hides the dead ones.
Run it before every session or the list quietly sends you to 404s.

---

## The site auditor

```bash
npm run audit -- somecompany.com
```

Checks structured data, canonical tags, robots.txt and sitemap health, H1s,
render-blocking scripts, insecure resources, image lazy-loading, viewport and
page weight.

This is the part worth using even if you ignore everything else. An application
or pitch that opens with a real fault on the reader's own site does not read like
the other two hundred they received. Real example from live use: a shop with over
a thousand products had `Sitemap: https://www.example.com/sitemap_index.xml` in
its robots.txt, because a plugin's placeholder domain was never replaced. That is
one line, verifiable in ten seconds, and it starts a conversation.

**Verify every finding by hand before you send it.** The auditor follows
redirects and is conservative, but a wrong claim in a first message costs more
than no message.

---

## Layout

```
src/jobscan.mjs          pull, score, filter by location, dedupe
src/check-live.mjs       is each posting still open, repair apply URLs
src/find-apply-routes.mjs find a careers inbox for form-only roles
src/site-audit.mjs       audit one site for technical faults
src/build-worklist.mjs   render the ranked worklist
src/agency-signals.mjs   companies hiring delivery roles, as contract leads
you.json                 your details        (gitignored)
profile.json             your scoring rules  (gitignored)
state/roles.json         every role found, with liveness stamps
out/APPLY-NOW.md         what to do next
```

`you.json`, `profile.json`, `state/` and `out/` are all gitignored. Your details
and your job search never leave your machine.

---

## Sources

RemoteOK · Remotive · Arbeitnow · Jobicy · Himalayas · WeWorkRemotely ·
WorkingNomads · Jobspresso · Hacker News "Who is hiring"

All public, all free, no keys. Some ask for a link back if you republish their
listings; check their terms before you do anything public with the output.

---

## One honest note on expectations

More applications do not reliably produce more interviews. In the campaign this
was built from, 38 applications produced one interview, and the thing that
mattered was targeting and a specific opening line, not volume.

Use it to apply to ten well-chosen roles a week with a real hook, not five
hundred with none.

MIT licensed. Use it however you like.

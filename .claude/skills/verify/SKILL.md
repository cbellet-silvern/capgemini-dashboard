---
name: verify
description: Build, run, and drive the AI Engagement Ledger to observe a change working end-to-end. Use before committing anything that touches the billing engine, the pages, the seed, or the CSV exports.
---

# Verifying this app

The surface is a **web server**. Verification means driving HTTP and looking at
what comes back — not running the test suite, which proves only that CI works.

## Handle

```sh
npm install                 # Node >= 22.5 required (uses built-in node:sqlite)
npm run seed                # or: npm run reset  (deterministic; safe to redo)
npm run dev                 # http://localhost:3000
```

Two things that will waste your time if you don't know them:

- **The dev server cannot bind a port under the command sandbox** — it fails with
  `EPERM`. Run it with the sandbox disabled. Same for any `curl` to localhost.
- **`npm run reset` replaces the database file.** `lib/db.ts` detects the new inode
  and reopens, so a running server picks it up without a restart. If you ever see
  figures that contradict the engine, confirm that reopen is still working before
  believing the page — a cached handle on a deleted file renders perfectly and is
  entirely wrong.

## Drive it

One command sweeps every route and flags the failure modes that matter (non-200,
`NaN`, `Infinity`, `undefined`, crash overlays):

```sh
node -e '
const B="http://localhost:3000";
const R=[["/","portfolio"],["/projects","projects"],["/invoices","invoices"],
["/usage","usage"],["/time","time"],["/settings","settings"],
["/projects/pr_ngf_core","project"],["/projects/pr_ngf_core/billing","stmt-client"],
["/projects/pr_ngf_core/billing?view=internal","stmt-internal"],
["/api/export/statement?project=pr_ngf_core&month=2026-06","csv-statement"],
["/api/export/usage?month=2026-06","csv-usage"],
["/api/export/time?month=2026-06","csv-time"],
["/api/export/margin?month=2026-06","csv-margin"]];
for(const [p,l] of R){const r=await fetch(B+p);const b=await r.text();
const bad=[[/Application error/i,"APP-ERR"],[/>\s*NaN\s*</,"NaN"],[/\$NaN/,"$NaN"],
[/>\s*Infinity\s*</,"Inf"],[/>\s*undefined\s*</,"undef"],[/="NaN"/,"NaN-attr"]]
.filter(([re])=>re.test(b)).map(([,n])=>n);
if(r.status!==200)bad.push("HTTP-"+r.status);
console.log(String(r.status).padEnd(4),String(b.length).padStart(7)+"B",l.padEnd(15),bad.join(" ")||"ok");}
'
```

`node_modules` appears in every dev-mode page (the Next devtools script URL). Do
not treat it as a leak — a naive "does the body contain node_modules" check
false-positives on all of them.

## What to actually check, by what you changed

**The billing engine (`lib/billing.ts`, `lib/pricing.ts`)** — open a statement in
both views and check the arithmetic *as printed*, because that is what a client
does:

```
/projects/pr_ngf_core/billing?month=2026-06&view=internal
```

Every hours line must satisfy `qty x unitPrice == amount` exactly. Token lines may
be up to a cent out (the quantity and the blended rate are each rounded for
display) and no more. This has broken three separate ways — total-hours-as-quantity,
a blended rate across two rate cards, and a 2dp rate on a 198-million-token line
that was $1.69 out — so check it every time, and check the CSV too:

```sh
curl -s 'http://localhost:3000/api/export/statement?project=pr_hhx_provider&month=2026-06'
```

The CSV is the artifact a client multiplies in a spreadsheet. It has regressed
independently of the page at least once.

**A page** — drive it and *measure* the layout rather than eyeballing it. In a
browser console on the page:

```js
document.querySelectorAll('.card,.table-wrap,table.data,svg').forEach(el => {
  if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0)
    console.log('overflow', el.className, el.scrollWidth, el.clientWidth); });
document.querySelectorAll('svg').forEach(svg => {          // SVG text escaping its box
  const [vx,,vw] = (svg.getAttribute('viewBox')||'0 0 0 0').split(/\s+/).map(Number);
  svg.querySelectorAll('text').forEach(t => { const b = t.getBBox();
    if (b.x < vx - 0.5 || b.x + b.width > vx + vw + 0.5) console.log('escapes', t.textContent); }); });
```

Both must print nothing. A label drawn outside its viewBox is clipped by the card
and reads as truncated text — the heatmap shipped 63px outside its box once.

**The seed (`scripts/seed.mjs`)** — reseed, then look at the portfolio. Budgets are
derived from the hours the generator produced, so a change to hours generation
silently changes every burn percentage. The demo should show roughly 19 workstreams
on budget, 2 to watch, 1 over. If most engagements are flagged over, the
calibration is wrong and the app reads as broken rather than as a portfolio.

**A Server Action (`app/actions.ts`)** — drive the form, not the exported function.
On `/time`, tick two rows, submit, and confirm the pending count drops by exactly
two and both ids leave the queue. Then submit with **nothing** ticked and confirm
the count does not move — an empty-selection mass approve is the failure worth
guarding.

## Probes worth repeating

These have all found something, or protect something that broke before:

| Probe | Expected |
|---|---|
| `/?month=not-a-month`, `?month=9999-99` | falls back to the latest month; the CSV filename names the month actually used |
| `/api/export/statement` with no `project` | 404, plain text, no stack |
| `/api/export/<unknown kind>` | 404 — the kind is allow-listed, never used to build a query or filename |
| `/projects/pr_nope` | 404 page, not a crash |
| A markup of `1` in Settings | stores 1%, not 100% (this one billed a client 100x) |
| A tax rate of `50` in Settings | refused, not stored as 5,000% |
| `/api/export/time` | no field starts with `=`, `+`, `@`, or a tab (CSV injection) |

## The cheap checks

`npm run check` (unit tests, pricing parity across every usage row, an integration
pass over all 32 project-months, and the chart-palette validator) is fast and needs
no browser. It is not a substitute for driving the app, but a failure there means
don't bother driving anything yet.

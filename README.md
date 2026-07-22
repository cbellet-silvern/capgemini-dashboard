# AI Engagement Ledger

A local demo web app for **Meridian Advisory**, an independent consulting firm, that
tracks Claude usage alongside consultant hours across the firm's engagements. It meters
Claude token spend from usage rows, attributes that spend to projects and workstreams,
and rebills it to clients under an explicit per-workstream policy. The output is a
client-ready billing statement per project and period that shows professional-services
hours, fixed-fee milestones, and Claude platform cost as separate, checkable lines.

Everything runs on one machine against a SQLite file. There is no external service, no
account, and no network call.

## Running it

Node **>= 22.5** is required, not recommended: the app reads SQLite through the built-in
`node:sqlite` module, which does not exist in earlier releases. There is no native
database driver to compile.

```sh
npm install
npm run seed     # builds data/ledger.db
npm run dev      # http://localhost:3000
```

The dataset is synthetic and deterministic — `scripts/seed.mjs` is seeded from a fixed
PRNG, so the same clients, consultants, time entries, usage rows and invoices come out
every time, and any number quoted in a demo stays quoted. `npm run seed` refuses to
overwrite an existing database; `npm run reset` (`node scripts/seed.mjs --force`) drops
and rebuilds it.

Workstream budgets are **derived from the hours the generator produced**, not chosen
alongside them. Hours come out of allocation percentages, working-day caps and a calendar;
a budget picked independently of that has no relationship to it, and the first version
proved the point — eight of twenty-two workstreams landed between 115% and 258% of budget,
so every engagement was flagged over and the dashboard read as broken rather than as a
portfolio worth reviewing. The seeder now sets each budget from the hours actually logged
and a target *pace* (budget consumed relative to schedule elapsed), which yields a
believable mix: nineteen workstreams on budget, two to watch, one genuinely over. The
budget *amount* is derived through the same rate precedence the app uses rather than from a
blended average, because a senior-skewed team bills above blended and the two figures
otherwise drift apart.

Node prints `ExperimentalWarning: SQLite is an experimental feature` on startup. That is
`node:sqlite` announcing itself and is expected; nothing is wrong.

If you start the dev server before seeding, the first page load fails with an explicit
error from `lib/db.ts` telling you to run `npm run seed`.

| Script | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run seed` | Create `data/ledger.db` from the schema and the synthetic generator |
| `npm run reset` | Same, forcing a rebuild over an existing file |
| `npm test` | Billing-engine unit tests — rate precedence, policies, allocation, rounding |
| `npm run test:parity` | Recomputes every stored usage cost with the app's formula; asserts it matches the seeder's |
| `npm run test:statements` | Drives the real engine over every project-month in the seeded database |
| `npm run check:palette` | Recomputes the chart palette's lightness band, chroma floor, colour-vision separation and contrast |
| `npm run check` | All four checks above |

The checks need no dependencies and no build step: Node strips the types and
`scripts/ts-loader.mjs` resolves the extensionless imports, so they execute the real
engine files unmodified. The engine is therefore verifiable before `npm install` has ever
run — which is how the two defects noted under [Rounding](#rounding) and
[Untagged usage](#untagged-usage) were found.

## The billing model

This is the part a partner should be able to check line by line. The engine is
`lib/billing.ts`; it is pure, takes rows as arguments, and never reads the clock, so the
same inputs always produce the same statement.

### Resolving a bill rate

For each time entry, the rate is resolved in this order and stops at the first hit
(`resolveBillRate`):

1. **Assignment override** — `assignments.bill_rate_override`, if the consultant has an
   assignment to that workstream and the override is not null. This is the negotiated
   exception, and it wins.
2. **Project rate card by grade, effective-dated** — the `rate_cards` row for the
   consultant's grade with the greatest `effective_from` that is still on or before the
   *work date*. A rate change part-way through an engagement therefore prices old work at
   the old rate.
3. **Consultant default** — `consultants.default_bill_rate`.

Cost rates resolve the same way minus step 1: rate card by grade and date, then
`consultants.default_cost_rate`. There is no per-assignment cost override.

### Which hours reach a statement

An entry is billed only if `billable = 1` **and** its status is `approved` or `invoiced`
(the default `billableStatuses`). Draft and submitted time is visible in the app and
counted in hours totals, but bills nothing — it carries cost with no revenue.

Non-billable hours still accrue internal cost, and they are deliberately excluded from
the rate-weighting used to display an average bill rate per grade, so that pro-bono or
written-off time does not appear as a rate cut.

### The three AI rebilling policies

A project sets `ai_policy_default` and `ai_markup_pct_default`. A workstream may override
either; a null column means "inherit" (`effectivePolicy`).

| Policy | What is billed | Effect on margin |
|---|---|---|
| `at_cost` | Metered Claude cost, passed through unchanged | Neutral. Revenue equals cost; margin comes from labour only. |
| `markup` | Metered cost, plus a separate management-fee line at `ai_markup_pct` of that cost | Positive. The markup line is pure margin — cost 0, margin 100%. |
| `absorbed` | Nothing | Negative. The full Claude cost stays on the firm's P&L and shows as a negative margin contribution. |

Under `markup`, the statement carries the cost pass-through and the markup as **two
lines**, not one inflated unit price, so the client can see what was metered and what was
charged for managing it.

### How Claude cost is metered

Cost is computed from token counts, never estimated from a session count.
`PricingBook.cost()` in `lib/pricing.ts` charges each token class separately, per million
tokens:

```
cost = input_tokens       / 1e6 * input_per_mtok
     + output_tokens      / 1e6 * output_per_mtok
     + cache_read_tokens  / 1e6 * cache_read_per_mtok
     + cache_write_tokens / 1e6 * (cache_write_1h_per_mtok if ttl = '1h'
                                   else cache_write_5m_per_mtok)
```

Cache reads and cache writes are priced at their own rates — cached input is cheaper than
fresh input, and writing to the cache costs more, with a higher rate for the 1-hour TTL
than the 5-minute one. If the row went through the Batch API (`batch = 1`), the whole
result is halved (`BATCH_DISCOUNT = 0.5`).

The rate applied is the one **in effect on the usage date**: the `model_pricing` row for
that model with the greatest `effective_from` that is still on or before `usage_date`.
Repricing is therefore never retroactive — a September rate change does not rewrite a June
invoice. `claude_usage.cost_usd` additionally freezes the metered figure at seed time for
the same reason. A model with no rate row costs 0 rather than throwing, and is surfaced
separately as a data-quality warning on the usage screen (`unpricedModels`).

Rates live in the `model_pricing` table, not in a file, so editing them on the Settings
screen is a real change. `lib/model-pricing.json` is only the seed input, and
`scripts/pricing.mjs` carries the same formula in plain JavaScript for the seeder — if the
formula changes, both must change.

### Untagged usage

Not every Claude session carries a workstream tag. Rows with `workstream_id IS NULL` form
an **unattributed pool**, and `allocateUnattributed` spreads it as follows:

- **Per consultant, not globally.** Each consultant's untagged cost is allocated only
  across the workstreams *that consultant* logged hours to in the period. A global
  pro-rata split would charge a client for a consultant who never touched their
  engagement.
- **The denominator is the consultant's GLOBAL period hours** — total logged hours across
  every project, not just the project being computed. Without this, a consultant who
  splits their week between two clients would have their entire untagged spend billed to
  each client in turn: the same dollars billed twice. `projectBillingInput` always passes
  `globalHoursByConsultant`.
- **Anything unallocable is reported, not absorbed.** A consultant with untagged usage but
  no logged hours anywhere in the period has no basis for allocation; that cost lands in
  `unattributedResidualCost` and is shown as a residual. The share belonging to a
  consultant's *other* engagements is reported as `unattributedElsewhereCost`, so the pool
  visibly adds up: allocated + elsewhere + residual = pool.

The allocated share is always its own statement line ("allocated share of untagged
sessions"), with the percentage of the pool as the quantity — never folded into a model
line, because it is an estimate and should read as one.

Per-seat subscription cost (`claude_seats`) is stored and reported but is not token-metered
and is not rebilled by the engine.

## Rounding

Money is rounded to cents **once**, at the invoice line. Subtotals, group subtotals and
the grand total are sums of already-rounded line amounts (`round2`, `sum`).

That ordering is the whole point. If you round the lines for display but compute the
subtotal from unrounded parts, the printed lines do not add up to the printed total — off
by a cent or two on a long statement. A client who adds up the column and gets a different
answer than the invoice stops trusting the invoice, and the conversation is no longer about
the work. Here, the total always equals the lines, because it *is* the lines.

`round2` rounds half away from zero, so −0.005 becomes −0.01 rather than −0.00. It also
applies a magnitude-relative epsilon before rounding, and that is not superstition: a
decimal like `1.005` has no exact binary form and is stored as `1.00499999999999989`, so a
naive `Math.round(n * 100)` — and `toFixed(2)` — silently drop the cent. A fixed
`Number.EPSILON` is orders of magnitude too small to bridge that gap at 100.5, let alone at
100,000.5, so the correction scales with the value. `npm test` pins both directions: 1.005
rounds up, 1.00499 does not.

### Every line multiplies out

A stronger promise than "the lines sum to the total": each printed line's quantity times its
printed unit price equals its printed amount. That is the arithmetic a client actually does
with a calculator, and it is enforced exactly for every hours line and to within a cent for
token lines (`npm test`, `npm run test:statements`).

Getting there took three fixes, each of which had been silently wrong:

- **The quantity was total logged hours** while the rate and amount covered only billable,
  approved hours. Ten of eleven labour lines on a real statement failed to multiply out; one
  Partner line was $3,525 off. The invoice now charges `billableHours`, and the internal view
  states how many hours were logged but not charged.
- **A grade group could hold two different rates** — an assignment override, or a rate card
  that changed mid-period — and a single line showing the blended average cannot reproduce
  its own amount. Labour is now grouped by grade *and* rate, so a grade with two rates in the
  period is honestly two lines.
- **The per-MTok rate was rounded to cents.** A blended Claude rate is a few dollars per
  million tokens and a line can carry hundreds of millions of tokens, so two decimals is an
  error multiplier: the printed product sat $1.69 from the printed amount on the worst line.
  Rates now carry four decimals and token quantities three, which holds the residual to a
  cent. The metered amount stays authoritative — a derived blend across four token buckets
  cannot be made to round-trip exactly, and the tests assert the bound rather than pretending
  otherwise.

Ratios that would divide by zero return `null`, and `null` renders as an em dash — the app
never shows `NaN`, `Infinity`, or `$NaN`. `npm run test:statements` walks every number in
all 32 statements to enforce that.

One consequence worth knowing about: the four untagged-pool figures on the internal
reconciliation panel are each rounded to cents independently, so their displayed sum can
sit a cent from the displayed pool on a perfectly sound statement (it does on 11 of the 32).
The panel's balance check therefore comes from the engine, which tests the identity
*before* rounding (`Statement.unattributedBalances`), and the UI annotates the cent instead
of flagging it. A tolerance-based check in the page produced a red "do not issue this
invoice" banner on those 11.

## Architecture

- **Next.js App Router.** Pages are async Server Components.
- **Server Components query SQLite directly** through `lib/queries.ts`. There is no API
  layer between a page and its data, and no client-side data fetching. `lib/db.ts` and
  `lib/queries.ts` are server-only and must never be imported into a `"use client"` file,
  directly or transitively.
- **Every SQL value is a `?` placeholder.** The only dynamic identifier is a sort column,
  resolved through an allow-list (`sortClause`).
- **The billing engine is pure.** `lib/billing.ts` has no I/O and no database import; it
  takes a `BillingInput` of rows and returns totals, so it is reproducible and readable in
  isolation.
- **Charts are hand-rolled inline SVG.** No chart library, no D3. Each chart is a small
  client component in `components/charts/` that renders its own axes, marks and hover
  layer, and ships a `<TableView>` so the numbers are reachable without colour or hover.
- **Styling is plain CSS.** One stylesheet, `app/globals.css`, built on custom properties
  (`--surface-*`, `--ink-*`, `--series-1..8`, `--seq-100..700`). No Tailwind, no CSS-in-JS.
- **Dependencies:** `next`, `react`, `react-dom`, plus TypeScript and type packages. That
  is the entire tree.

### File by file

| Path | What it is |
|---|---|
| `scripts/schema.sql` | The authoritative schema. Dates are ISO text, money is REAL, enums are `CHECK`-constrained so a bad seed fails loudly. |
| `scripts/seed.mjs` | Deterministic synthetic-data generator. Creates clients, consultants, projects, workstreams, rate cards, assignments, milestones, time entries, Claude usage, seats and invoices. |
| `scripts/pricing.mjs` | The metering formula in plain JS, used by the seeder before any TypeScript exists. Mirrors `lib/pricing.ts`. |
| `scripts/check-palette.mjs` | Reads the series colours straight out of `app/globals.css` and recomputes the palette checks against each mode's surface. |
| `scripts/validate_palette.js` | The palette maths: OKLCH lightness and chroma, Machado colour-vision simulation, WCAG contrast. |
| `scripts/ts-loader.mjs`, `scripts/register-loader.mjs` | Resolve extensionless imports so the tests can run the app's real `.ts` files under plain Node, with no build step. |
| `lib/billing.test.ts` | Unit tests for the engine: rate precedence, effective dating, the three policies, rounding, allocation. |
| `lib/pricing.parity.test.ts` | Asserts the seeder's cost formula and the app's agree on every stored usage row. |
| `lib/statements.test.ts` | Integration test: builds every project-month against the seeded database and checks the invariants. |
| `lib/model-pricing.json` | Seed input: effective-dated Claude rates per model. |
| `lib/db.ts` | `node:sqlite` connection plus `all/get/run/scalar/tx/inClause/sortClause`. Copies null-prototype rows into plain objects so React can serialise them. |
| `lib/types.ts` | Every row type, domain type, and label map. |
| `lib/pricing.ts` | `PricingBook`: effective-dated rate lookup, token→money metering, display names, tiers. |
| `lib/billing.ts` | The engine: rate resolution, untagged allocation, budget burn, per-workstream and per-project roll-up, statement construction, portfolio totals. |
| `lib/queries.ts` | All data access, and the assembly of `BillingInput` for one project or all of them. |
| `lib/format.ts` | Formatters: `usd`, `usdRate`, `hours`, `pct`, `tokens`, `mtok`, `date`, `monthLabel` and friends. |
| `app/globals.css` | The design system: colour tokens, layout, cards, tables, badges, meters, chart primitives, statement styles. |
| `app/layout.tsx` | Shell: sidebar, nav, main column. |
| `app/page.tsx` | Portfolio dashboard — firm-level revenue, cost, margin, AI share, projects at risk. |
| `app/projects/page.tsx` | Project list with budget burn and risk. |
| `app/projects/[id]/page.tsx` | Project detail: workstreams, hours, usage, budget. |
| `app/projects/[id]/billing/page.tsx` | The client billing statement for a project and period. |
| `app/invoices/page.tsx` | Invoice register. |
| `app/usage/page.tsx` | Claude usage analytics: by day, model, surface, attribution, consultant. |
| `app/time/page.tsx` | Time-entry approval queue. |
| `app/settings/page.tsx` | Rate cards, AI policy, model pricing. |
| `app/api/export/[kind]/route.ts` | CSV export. |
| `components/Nav.tsx` | Sidebar navigation with active-item highlighting. |
| `components/StatTile.tsx`, `Badge.tsx`, `Meter.tsx`, `PeriodPicker.tsx` | Shared UI primitives. |
| `components/charts/` | `LineChart`, `StackedBarChart`, `BarChart`, `DonutChart`, `Heatmap`, `Sparkline`, `TableView`, plus `scale.ts` and `valueFormat.ts`. |

## What this demo does not do

- **No authentication or authorisation.** Every visitor sees every client's numbers,
  including internal cost and margin. There are no users, roles, or audit trail; approvals
  record an approver name that is supplied, not verified.
- **No multi-currency conversion.** `clients.currency`, `projects.currency`,
  `rate_cards.currency` and `invoices.currency` all exist and are stored, but every seeded
  rate is USD and nothing converts between currencies. A non-USD client would render its
  amounts with a dollar sign.
- **No real Anthropic Admin API integration.** All Claude usage is synthetic. The seam is
  `scripts/seed.mjs` writing into the `claude_usage` table — one row per consultant /
  workstream / day / model / surface. A real implementation would replace the generator
  with a pull from the Anthropic Admin usage and cost endpoints and land rows in that same
  shape; nothing downstream of the table would change. Workstream attribution would have to
  come from whatever tagging the firm applies at the source, and whatever it cannot tag
  falls into the untagged pool as it does here.
- **No double-entry accounting and no GL export.** Revenue and cost are computed for
  presentation, not posted. There are no journals, no accounts receivable, no revenue
  recognition schedule, no tax engine beyond a single flat `tax_rate` multiplier, and no
  export to a finance system. CSV export is for spreadsheets, not for a ledger.
- **Invoice snapshots are stored but not immutable.** `invoices` and `invoice_lines`
  persist what was billed, but nothing prevents an edit, and the engine will happily
  recompute a period whose invoice is already issued. There is no locking, versioning, or
  credit-note flow, so a real "issued" invoice cannot be relied on to be frozen.
- **Time entry is an approval queue, not a timesheet UI.** You can review and approve
  seeded entries. You cannot create, edit, split, transfer, or reject an entry, and there
  is no week grid, no submission workflow, and no utilisation target.

## Data-visualisation conventions

The charts follow a small set of rules consistently, so a reader learns the vocabulary
once:

- **Fixed categorical slot order.** A series takes slot 1..8 (`--series-n`) and keeps it;
  slots are never cycled and no hue is generated. A ninth series folds into "Other".
- **Single-hue sequential ramps for heatmaps.** Light to dark on one hue (`--seq-100` to
  `--seq-700`), with a labelled scale. Never a rainbow.
- **No dual-axis charts.** Two measures on different scales get two charts stacked, which
  removes the reader's ability to be misled by a chosen axis ratio.
- **A legend whenever there are two or more series.** A single-series chart gets none — the
  title already says what it is.
- **A table view under every chart.** Each chart ships a `<TableView>` disclosure, so the
  numbers are reachable without colour, hover, or a mouse.
- **Text never wears the series colour.** Identity comes from a coloured swatch beside the
  label; values and ticks use ink tokens. Labelling is selective — an endpoint or an
  extreme, never a number on every point.
- **Dark mode is chosen, not inverted.** Each token has separately picked light and dark
  values, because inverting a palette wrecks the ordering of a sequential ramp and the
  relative weight of the categorical hues.

The **slot order is a safety property, not a style choice**, and `npm run check:palette`
enforces it. Adjacent slots are the pairs a reader most often has to tell apart — touching
segments in a stack, neighbouring bars — so the order was picked by enumerating all 5,040
orderings (slot 1 pinned to blue, which doubles as the UI accent) and maximising the worst
adjacent-pair separation under protanopia, deuteranopia and tritanopia across *both* modes
at once. A slot's hue has to be the same in light and dark, so optimising either mode alone
is the trap: the order this palette ships with elsewhere scores ΔE 24.2 in light but only
7.9 in dark, while the order used here scores 25.0 and 27.6. Reordering the slots to taste
would quietly undo that.

Three light-mode hues sit below 3:1 against the light surface, which the check reports as a
warning rather than a failure. That is not dismissable — it obligates the relief the charts
already ship: selective direct labels, the table view under every chart, and a 2px
surface-coloured gap between touching marks so adjacency is carried by geometry as well as
hue.

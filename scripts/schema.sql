-- AI Engagement Ledger — schema
--
-- Conventions
--   * ids            : short readable TEXT keys (cl_acme, pr_acme_core, ws_acme_core_01)
--   * dates          : TEXT, ISO-8601 'YYYY-MM-DD' — sorts and compares lexicographically
--   * money          : REAL, in the row's currency. Rounding happens once, per invoice
--                      line, in the billing engine — never mid-aggregate.
--   * booleans       : INTEGER 0/1
--   * enum-ish text  : constrained with CHECK so a bad seed fails loudly

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Parties ──────────────────────────────────────────────────────────────────

CREATE TABLE clients (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  industry              TEXT NOT NULL,
  initials              TEXT NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'USD',
  payment_terms_days    INTEGER NOT NULL DEFAULT 30,
  billing_contact_name  TEXT NOT NULL,
  billing_contact_email TEXT NOT NULL,
  region                TEXT NOT NULL
);

CREATE TABLE consultants (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,
  grade             TEXT NOT NULL CHECK (grade IN
                      ('partner','principal','manager','senior_consultant','consultant','analyst')),
  practice          TEXT NOT NULL,
  location          TEXT NOT NULL,
  initials          TEXT NOT NULL,
  default_bill_rate REAL NOT NULL,
  default_cost_rate REAL NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1
);

-- ── Engagement structure ─────────────────────────────────────────────────────

CREATE TABLE projects (
  id                    TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES clients(id),
  code                  TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('active','closing','closed')),
  engagement_type       TEXT NOT NULL CHECK (engagement_type IN
                          ('time_and_materials','capped_tm','fixed_fee')),
  start_date            TEXT NOT NULL,
  end_date              TEXT NOT NULL,
  contract_value        REAL NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'USD',
  engagement_partner    TEXT NOT NULL,
  delivery_lead         TEXT NOT NULL,
  po_number             TEXT NOT NULL,
  -- Default AI rebilling posture, inherited by workstreams that don't override it.
  ai_policy_default     TEXT NOT NULL CHECK (ai_policy_default IN
                          ('markup','at_cost','absorbed')),
  ai_markup_pct_default REAL NOT NULL DEFAULT 0
);

CREATE TABLE workstreams (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  code               TEXT NOT NULL,
  name               TEXT NOT NULL,
  lead_consultant_id TEXT REFERENCES consultants(id),
  status             TEXT NOT NULL CHECK (status IN ('active','complete','on_hold')),
  start_date         TEXT NOT NULL,
  end_date           TEXT NOT NULL,
  budget_hours       REAL NOT NULL,
  budget_amount      REAL NOT NULL,
  fixed_fee_amount   REAL,               -- NULL unless the workstream is fixed-fee
  -- NULL on either column means "inherit the project default".
  ai_policy          TEXT CHECK (ai_policy IN ('markup','at_cost','absorbed')),
  ai_markup_pct      REAL,
  description        TEXT NOT NULL,
  UNIQUE (project_id, code)
);

-- Per-project rate card by grade. Falls back to consultants.default_*_rate.
CREATE TABLE rate_cards (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  grade          TEXT NOT NULL,
  bill_rate      REAL NOT NULL,
  cost_rate      REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  effective_from TEXT NOT NULL,
  UNIQUE (project_id, grade, effective_from)
);

CREATE TABLE assignments (
  id                 TEXT PRIMARY KEY,
  consultant_id      TEXT NOT NULL REFERENCES consultants(id),
  workstream_id      TEXT NOT NULL REFERENCES workstreams(id),
  allocation_pct     REAL NOT NULL,
  bill_rate_override REAL,               -- highest-precedence rate when present
  start_date         TEXT NOT NULL,
  end_date           TEXT NOT NULL,
  UNIQUE (consultant_id, workstream_id)
);

CREATE TABLE milestones (
  id            TEXT PRIMARY KEY,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id),
  name          TEXT NOT NULL,
  due_date      TEXT NOT NULL,
  amount        REAL NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','delivered','invoiced'))
);

-- ── The two things we bill ───────────────────────────────────────────────────

CREATE TABLE time_entries (
  id            TEXT PRIMARY KEY,
  consultant_id TEXT NOT NULL REFERENCES consultants(id),
  workstream_id TEXT NOT NULL REFERENCES workstreams(id),
  work_date     TEXT NOT NULL,
  hours         REAL NOT NULL,
  billable      INTEGER NOT NULL DEFAULT 1,
  activity_code TEXT NOT NULL,
  narrative     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft','submitted','approved','invoiced')),
  approved_by   TEXT,
  invoice_id    TEXT REFERENCES invoices(id)
);

-- One row per consultant / workstream / day / model / surface. workstream_id is
-- NULL when the usage could not be attributed to a workstream — those rows form
-- the "unattributed pool" and are allocated pro-rata by logged hours.
CREATE TABLE claude_usage (
  id                 TEXT PRIMARY KEY,
  consultant_id      TEXT NOT NULL REFERENCES consultants(id),
  workstream_id      TEXT REFERENCES workstreams(id),
  usage_date         TEXT NOT NULL,
  model              TEXT NOT NULL,
  surface            TEXT NOT NULL CHECK (surface IN
                       ('claude_code','api','agent_sdk','claude_ai_seat')),
  requests           INTEGER NOT NULL DEFAULT 0,
  sessions           INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_ttl    TEXT NOT NULL DEFAULT '5m' CHECK (cache_write_ttl IN ('5m','1h')),
  batch              INTEGER NOT NULL DEFAULT 0,
  -- Cost as billed: computed from the rate in effect on usage_date and frozen
  -- here, so a later repricing never rewrites history.
  cost_usd           REAL NOT NULL,
  attribution        TEXT NOT NULL CHECK (attribution IN
                       ('tagged','inferred','unattributed')),
  invoice_id         TEXT REFERENCES invoices(id)
);

-- Per-seat monthly cost. Not token-metered, so it is allocated, never metered.
CREATE TABLE claude_seats (
  id            TEXT PRIMARY KEY,
  consultant_id TEXT NOT NULL REFERENCES consultants(id),
  plan          TEXT NOT NULL CHECK (plan IN ('team','enterprise')),
  month         TEXT NOT NULL,           -- 'YYYY-MM'
  monthly_cost  REAL NOT NULL,
  UNIQUE (consultant_id, month)
);

-- ── Reference data ───────────────────────────────────────────────────────────

CREATE TABLE model_pricing (
  model                   TEXT NOT NULL,
  display_name            TEXT NOT NULL,
  tier                    TEXT NOT NULL,
  effective_from          TEXT NOT NULL,
  input_per_mtok          REAL NOT NULL,
  output_per_mtok         REAL NOT NULL,
  cache_read_per_mtok     REAL NOT NULL,
  cache_write_5m_per_mtok REAL NOT NULL,
  cache_write_1h_per_mtok REAL NOT NULL,
  note                    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (model, effective_from)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Invoicing ────────────────────────────────────────────────────────────────

CREATE TABLE invoices (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  number             TEXT NOT NULL UNIQUE,
  period_start       TEXT NOT NULL,
  period_end         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft','issued','paid')),
  issued_date        TEXT,
  due_date           TEXT,
  currency           TEXT NOT NULL DEFAULT 'USD',
  subtotal_labor     REAL NOT NULL DEFAULT 0,
  subtotal_ai_cost   REAL NOT NULL DEFAULT 0,
  ai_markup_amount   REAL NOT NULL DEFAULT 0,
  subtotal_fixed_fee REAL NOT NULL DEFAULT 0,
  discount_amount    REAL NOT NULL DEFAULT 0,
  tax_rate           REAL NOT NULL DEFAULT 0,
  tax_amount         REAL NOT NULL DEFAULT 0,
  total              REAL NOT NULL DEFAULT 0,
  notes              TEXT NOT NULL DEFAULT ''
);

CREATE TABLE invoice_lines (
  id            TEXT PRIMARY KEY,
  invoice_id    TEXT NOT NULL REFERENCES invoices(id),
  workstream_id TEXT REFERENCES workstreams(id),
  kind          TEXT NOT NULL CHECK (kind IN
                  ('labor','ai_passthrough','ai_markup','fixed_fee','discount')),
  sort          INTEGER NOT NULL DEFAULT 0,
  description   TEXT NOT NULL,
  qty           REAL NOT NULL,
  unit          TEXT NOT NULL,
  unit_price    REAL NOT NULL,
  amount        REAL NOT NULL,
  meta_json     TEXT NOT NULL DEFAULT '{}'
);

-- ── Indices ──────────────────────────────────────────────────────────────────

CREATE INDEX idx_projects_client        ON projects(client_id);
CREATE INDEX idx_workstreams_project    ON workstreams(project_id);
CREATE INDEX idx_assignments_ws         ON assignments(workstream_id);
CREATE INDEX idx_assignments_consultant ON assignments(consultant_id);
CREATE INDEX idx_time_ws_date           ON time_entries(workstream_id, work_date);
CREATE INDEX idx_time_consultant_date   ON time_entries(consultant_id, work_date);
CREATE INDEX idx_time_status            ON time_entries(status);
CREATE INDEX idx_usage_ws_date          ON claude_usage(workstream_id, usage_date);
CREATE INDEX idx_usage_consultant_date  ON claude_usage(consultant_id, usage_date);
CREATE INDEX idx_usage_model            ON claude_usage(model);
CREATE INDEX idx_usage_attribution      ON claude_usage(attribution);
CREATE INDEX idx_invoices_project       ON invoices(project_id);
CREATE INDEX idx_invoice_lines_invoice  ON invoice_lines(invoice_id);
CREATE INDEX idx_milestones_ws          ON milestones(workstream_id);

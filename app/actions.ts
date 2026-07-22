"use server";

/**
 * Server Actions. Everything here runs on the server and writes to SQLite, so
 * every value arriving from a FormData is treated as hostile until it has been
 * checked against a literal set, an allow-list, or a numeric range. Nothing is
 * passed straight through to a query.
 */

import { revalidatePath } from "next/cache";

import {
  approveTimeEntries,
  getClient,
  getInvoice,
  getProject,
  getSetting,
  getWorkstream,
  setInvoiceStatus,
  setSetting,
  setWorkstreamAiPolicy,
} from "@/lib/queries";
import type { AiPolicy, InvoiceStatus } from "@/lib/types";

/** Ids in this dataset are short slugs; anything longer is not one of ours. */
const MAX_ID_LEN = 64;

function readString(fd: FormData, key: string): string | null {
  const raw = fd.get(key);
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v.length > 0 && v.length <= MAX_ID_LEN ? v : null;
}

/**
 * Percent fields post 0..100 and the store keeps ratios, so the conversion has
 * to happen in exactly one place with no inference about the units. Guessing —
 * treating a small number as an already-divided ratio — makes 1% and 100%
 * indistinguishable, and both are values a user types. Out of range is refused
 * rather than clamped: a rejected save is visible, a silently altered rate is not.
 */
function readPercentAsRatio(fd: FormData, key: string): number | null {
  const raw = fd.get(key);
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n / 100;
}

/** ISO 'YYYY-MM-DD' + n days, done arithmetically so no timezone can shift it. */
function addDays(iso: string, days: number): string {
  const [ys, ms, ds] = iso.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso;
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export async function approveEntriesAction(formData: FormData): Promise<void> {
  const ids: string[] = [];
  for (const raw of formData.getAll("entryId")) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (id.length > 0 && id.length <= MAX_ID_LEN) ids.push(id);
  }
  if (ids.length === 0) return;

  const approver = getSetting("approver_name", "Approver");
  approveTimeEntries(ids, approver);

  revalidatePath("/time");
  revalidatePath("/");
}

const POLICY_VALUES = ["markup", "at_cost", "absorbed", "inherit"] as const;
type PolicyChoice = (typeof POLICY_VALUES)[number];

function isPolicyChoice(v: string): v is PolicyChoice {
  return (POLICY_VALUES as readonly string[]).includes(v);
}

export async function setPolicyAction(formData: FormData): Promise<void> {
  const workstreamId = readString(formData, "workstreamId");
  const policyRaw = readString(formData, "policy");
  if (!workstreamId || !policyRaw || !isPolicyChoice(policyRaw)) return;

  const workstream = getWorkstream(workstreamId);
  if (!workstream) return;

  if (policyRaw === "inherit") {
    setWorkstreamAiPolicy(workstreamId, null, null);
  } else {
    const policy: AiPolicy = policyRaw;
    let markup = 0;
    if (policy === "markup") {
      const ratio = readPercentAsRatio(formData, "markupPct");
      if (ratio === null) return;
      markup = ratio;
    }
    setWorkstreamAiPolicy(workstreamId, policy, markup);
  }

  revalidatePath("/settings");
  revalidatePath("/");
  revalidatePath(`/projects/${workstream.project_id}`);
  revalidatePath(`/projects/${workstream.project_id}/billing`);
}

/**
 * Keys a form is allowed to write. Numeric keys carry the range they are stored
 * in — both are ratios, edited as ratios on /settings — and a value outside it is
 * refused, not clamped: a tax rate of 50 is a typo for 0.5, not a request to bill
 * 5,000%, and quietly turning it into 1.0 would be just as wrong as storing 50.
 */
type SettingSpec = { kind: "text" } | { kind: "number"; min: number; max: number };

const SETTING_KEYS: Record<string, SettingSpec> = {
  tax_rate: { kind: "number", min: 0, max: 1 },
  default_ai_markup_pct: { kind: "number", min: 0, max: 1 },
  approver_name: { kind: "text" },
  firm_name: { kind: "text" },
  firm_address: { kind: "text" },
};

export async function setSettingAction(formData: FormData): Promise<void> {
  let wrote = false;

  for (const [key, spec] of Object.entries(SETTING_KEYS)) {
    const raw = formData.get(key);
    if (typeof raw !== "string") continue; // absent from this form — leave it alone
    const value = raw.trim();

    if (spec.kind === "number") {
      if (value.length === 0) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) continue;
      setSetting(key, String(n));
    } else {
      setSetting(key, value.slice(0, 500));
    }
    wrote = true;
  }

  if (!wrote) return;
  revalidatePath("/settings");
  revalidatePath("/");
}

const INVOICE_STATUSES = ["draft", "issued", "paid"] as const;

function isInvoiceStatus(v: string): v is InvoiceStatus {
  return (INVOICE_STATUSES as readonly string[]).includes(v);
}

export async function setInvoiceStatusAction(formData: FormData): Promise<void> {
  const invoiceId = readString(formData, "invoiceId");
  const statusRaw = readString(formData, "status");
  if (!invoiceId || !statusRaw || !isInvoiceStatus(statusRaw)) return;

  const invoice = getInvoice(invoiceId);
  if (!invoice) return;

  let issued = invoice.issued_date;
  let due = invoice.due_date;

  if (statusRaw === "issued") {
    // Issuing dates the invoice at the period end and derives the due date from
    // the client's terms, so the register never shows an issued invoice undated.
    issued = invoice.period_end;
    const project = getProject(invoice.project_id);
    const client = project ? getClient(project.client_id) : undefined;
    const terms = client && Number.isFinite(client.payment_terms_days)
      ? client.payment_terms_days
      : 30;
    due = addDays(invoice.period_end, terms);
  } else if (statusRaw === "draft") {
    issued = null;
    due = null;
  }

  setInvoiceStatus(invoiceId, statusRaw, issued, due);
  revalidatePath("/invoices");
  revalidatePath(`/projects/${invoice.project_id}/billing`);
}

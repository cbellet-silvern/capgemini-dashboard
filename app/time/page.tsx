import { Fragment } from "react";

import { approveEntriesAction } from "@/app/actions";
import { Badge, StatusBadge } from "@/components/Badge";
import { StatTile } from "@/components/StatTile";
import { count, date, hours, usd } from "@/lib/format";
import {
  approvalQueue,
  listConsultants,
  listTimeEntries,
  listWorkstreams,
} from "@/lib/queries";
import { GRADE_LABEL, type Grade } from "@/lib/types";

export const dynamic = "force-dynamic";

function gradeLabel(grade: string): string {
  return GRADE_LABEL[grade as Grade] ?? grade;
}

export default async function TimePage() {
  const queue = approvalQueue();
  const consultants = listConsultants();
  const byId = new Map(consultants.map((c) => [c.id, c]));

  const pendingHours = queue.reduce((acc, e) => acc + e.hours, 0);
  const estimatedValue = queue.reduce((acc, e) => {
    if (e.billable !== 1) return acc;
    const rate = byId.get(e.consultant_id)?.default_bill_rate ?? 0;
    return acc + e.hours * rate;
  }, 0);

  // Group by client so an approver can work one relationship at a time.
  const clients: string[] = [];
  const byClient = new Map<string, typeof queue>();
  for (const entry of queue) {
    const bucket = byClient.get(entry.client_name);
    if (bucket) {
      bucket.push(entry);
    } else {
      clients.push(entry.client_name);
      byClient.set(entry.client_name, [entry]);
    }
  }

  const workstreams = new Map(listWorkstreams().map((w) => [w.id, w]));
  const recent = listTimeEntries({ statuses: ["approved"], limit: 15 });

  const COLS = 11;

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-eyebrow">Operations</div>
        <h1 className="page-title">Time approvals</h1>
        <p className="page-sub">
          {hours(pendingHours)} across {count(queue.length)}{" "}
          {queue.length === 1 ? "entry" : "entries"} are awaiting approval. Only approved
          and invoiced hours reach a client statement — the billing engine ignores draft
          and submitted time, so anything left here is revenue that cannot be invoiced.
        </p>
      </div>

      <div className="grid grid-3">
        <StatTile
          label="Entries pending"
          value={count(queue.length)}
          foot="Status draft or submitted"
        />
        <StatTile
          label="Hours pending"
          value={hours(pendingHours)}
          foot="Billable and non-billable combined"
        />
        <StatTile
          label="Estimated value"
          value={usd(estimatedValue)}
          foot="Estimate only — billable hours at each consultant's default rate, not the project rate card"
        />
      </div>

      <div className="spacer" />

      <form action={approveEntriesAction}>
        {queue.length > 0 ? (
          <div className="toolbar">
            <button type="submit" className="btn is-primary">
              Approve selected
            </button>
            <span className="micro">
              {count(queue.length)} pending · {hours(pendingHours)}
            </span>
          </div>
        ) : null}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Approval queue</div>
              <div className="card-sub">
                Tick the entries to release, then approve. Approval stamps the entry with
                the approver name from Settings.
              </div>
            </div>
          </div>
          <div className="card-body is-flush">
            {queue.length === 0 ? (
              <p className="empty">Nothing awaiting approval.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>
                        <span className="micro">Sel</span>
                      </th>
                      <th>Date</th>
                      <th>Consultant</th>
                      <th>Client</th>
                      <th>Project</th>
                      <th>Workstream</th>
                      <th>Activity</th>
                      <th>Narrative</th>
                      <th className="num">Hours</th>
                      <th>Billable</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map((clientName) => {
                      const rows = byClient.get(clientName) ?? [];
                      const clientHours = rows.reduce((a, r) => a + r.hours, 0);
                      return (
                        <Fragment key={clientName}>
                          <tr className="is-group">
                            <td colSpan={COLS}>
                              {clientName} · {count(rows.length)} pending ·{" "}
                              {hours(clientHours)}
                            </td>
                          </tr>
                          {rows.map((e) => (
                            <tr key={e.id}>
                              <td>
                                <input
                                  type="checkbox"
                                  name="entryId"
                                  value={e.id}
                                  aria-label={`Approve ${e.consultant_name} ${e.work_date}`}
                                />
                              </td>
                              <td className="nowrap">{date(e.work_date)}</td>
                              <td>
                                <span className="cell-strong">{e.consultant_name}</span>
                                <span className="cell-sub">{gradeLabel(e.grade)}</span>
                              </td>
                              <td>{e.client_name}</td>
                              <td className="mono nowrap">{e.project_code}</td>
                              <td>
                                {e.workstream_name}
                                <span className="cell-sub">{e.workstream_code}</span>
                              </td>
                              <td className="mono nowrap">{e.activity_code}</td>
                              <td>{e.narrative}</td>
                              <td className="num">{hours(e.hours)}</td>
                              <td>
                                <Badge tone={e.billable === 1 ? "ok" : "neutral"}>
                                  {e.billable === 1 ? "Billable" : "Non-billable"}
                                </Badge>
                              </td>
                              <td>
                                <StatusBadge status={e.status} />
                              </td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {queue.length > 0 ? (
            <div className="card-foot">
              <button type="submit" className="btn is-primary">
                Approve selected
              </button>
            </div>
          ) : null}
        </div>
      </form>

      <div className="spacer" />

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Recently approved</div>
            <div className="card-sub">
              The last 15 approvals. These hours are now eligible for a statement.
            </div>
          </div>
        </div>
        <div className="card-body is-flush">
          {recent.length === 0 ? (
            <p className="empty">No approved entries yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Consultant</th>
                    <th>Workstream</th>
                    <th>Narrative</th>
                    <th className="num">Hours</th>
                    <th>Approved by</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((e) => {
                    const consultant = byId.get(e.consultant_id);
                    const ws = workstreams.get(e.workstream_id);
                    return (
                      <tr key={e.id}>
                        <td className="nowrap">{date(e.work_date)}</td>
                        <td>
                          <span className="cell-strong">
                            {consultant?.name ?? "Unknown consultant"}
                          </span>
                          {consultant ? (
                            <span className="cell-sub">{gradeLabel(consultant.grade)}</span>
                          ) : null}
                        </td>
                        <td>
                          {ws?.name ?? "Unknown workstream"}
                          {ws ? <span className="cell-sub">{ws.code}</span> : null}
                        </td>
                        <td>{e.narrative}</td>
                        <td className="num">{hours(e.hours)}</td>
                        <td>{e.approved_by ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

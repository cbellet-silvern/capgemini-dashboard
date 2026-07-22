export interface TableViewColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

export interface TableViewProps {
  columns: TableViewColumn[];
  rows: Array<Record<string, string | number>>;
  caption?: string;
  summaryLabel?: string;
}

/** Callers normally pass pre-formatted strings; a raw number is a fallback path. */
function cell(v: string | number | undefined): string {
  if (v === undefined) return "—";
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US");
}

export function TableView({
  columns,
  rows,
  caption,
  summaryLabel = "Show data table",
}: TableViewProps) {
  return (
    <details className="table-view">
      <summary>{summaryLabel}</summary>
      {rows.length === 0 ? (
        <p className="empty">No data for this period.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            {caption ? <caption>{caption}</caption> : null}
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className={c.numeric ? "num" : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.numeric ? "num" : undefined}>
                      {cell(r[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

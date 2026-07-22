"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactElement } from "react";
import { monthLabel } from "@/lib/format";

export interface PeriodPickerProps {
  months: string[];
  current: string;
}

export function PeriodPicker({
  months,
  current,
}: PeriodPickerProps): ReactElement {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();

  if (months.length <= 1) {
    const only = months[0] ?? current;
    return <span className="badge">{monthLabel(only)}</span>;
  }

  const hrefFor = (month: string): string => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("month", month);
    return `${pathname}?${params.toString()}`;
  };

  return (
    <div className="seg" role="group" aria-label="Billing period">
      {months.map((m) => (
        <Link
          key={m}
          href={hrefFor(m)}
          className={m === current ? "is-active" : undefined}
          aria-current={m === current ? "true" : undefined}
        >
          {monthLabel(m)}
        </Link>
      ))}
    </div>
  );
}

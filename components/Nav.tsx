"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";

export interface NavProps {
  pendingApprovals: number;
  projects: number;
}

type Glyph =
  | "portfolio"
  | "projects"
  | "invoices"
  | "usage"
  | "time"
  | "settings";

interface NavItem {
  href: string;
  label: string;
  glyph: Glyph;
  count?: number;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const G = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Glyph({ name }: { name: Glyph }): ReactElement {
  return (
    <svg
      className="nav-glyph"
      width={15}
      height={15}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      {name === "portfolio" ? (
        <>
          <rect x={2} y={2} width={5.2} height={5.2} rx={1.2} {...G} />
          <rect x={8.8} y={2} width={5.2} height={5.2} rx={1.2} {...G} />
          <rect x={2} y={8.8} width={5.2} height={5.2} rx={1.2} {...G} />
          <rect x={8.8} y={8.8} width={5.2} height={5.2} rx={1.2} {...G} />
        </>
      ) : null}
      {name === "projects" ? (
        <>
          <path d="M2 4.6a1.2 1.2 0 0 1 1.2-1.2h2.9l1.3 1.6h4.4A1.2 1.2 0 0 1 13 6.2v5.4a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.6Z" {...G} />
        </>
      ) : null}
      {name === "invoices" ? (
        <>
          <path d="M3.6 2h6.1l2.7 2.7v9.3H3.6Z" {...G} />
          <path d="M5.9 7.4h4.2M5.9 10h4.2" {...G} />
        </>
      ) : null}
      {name === "usage" ? (
        <>
          <path d="M2.4 13.2h11.2" {...G} />
          <path d="M4.4 13.2V8.6M7.6 13.2V4.4M10.8 13.2V6.8" {...G} />
        </>
      ) : null}
      {name === "time" ? (
        <>
          <circle cx={8} cy={8} r={5.7} {...G} />
          <path d="M8 4.9V8l2.3 1.5" {...G} />
        </>
      ) : null}
      {name === "settings" ? (
        <>
          <circle cx={8} cy={8} r={2.1} {...G} />
          <path d="M8 1.9v1.8M8 12.3v1.8M2.9 8H1.1M14.9 8h-1.8M4.2 4.2 3 3M13 13l-1.2-1.2M11.8 4.2 13 3M3 13l1.2-1.2" {...G} />
        </>
      ) : null}
    </svg>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Nav({ pendingApprovals, projects }: NavProps): ReactElement {
  const pathname = usePathname() ?? "/";

  const sections: NavSection[] = [
    {
      title: "Overview",
      items: [
        { href: "/", label: "Portfolio", glyph: "portfolio" },
        {
          href: "/projects",
          label: "Projects",
          glyph: "projects",
          count: projects > 0 ? projects : undefined,
        },
        { href: "/invoices", label: "Invoices", glyph: "invoices" },
      ],
    },
    {
      title: "Analysis",
      items: [{ href: "/usage", label: "Claude usage", glyph: "usage" }],
    },
    {
      title: "Operations",
      items: [
        {
          href: "/time",
          label: "Time approvals",
          glyph: "time",
          count: pendingApprovals > 0 ? pendingApprovals : undefined,
        },
        { href: "/settings", label: "Settings", glyph: "settings" },
      ],
    },
  ];

  return (
    <nav aria-label="Main">
      {sections.map((section) => (
        <div key={section.title}>
          <div className="nav-section">{section.title}</div>
          {section.items.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "nav-item is-active" : "nav-item"}
                aria-current={active ? "page" : undefined}
              >
                <Glyph name={item.glyph} />
                <span>{item.label}</span>
                {item.count !== undefined ? (
                  <span className="nav-count">{item.count}</span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

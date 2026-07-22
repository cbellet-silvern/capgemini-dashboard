import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
import { counts } from "@/lib/queries";
import "./globals.css";

export const metadata: Metadata = {
  title: "Engagement Ledger — Meridian Advisory",
  description:
    "Consultant hours and Claude usage, costed and rebilled per project and workstream.",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // The shell must render even before scripts/seed has created the database,
  // so a missing file shows the chrome plus the page's own error, not a blank screen.
  let pendingApprovals = 0;
  let projects = 0;
  try {
    const c = counts();
    pendingApprovals = c.pendingApprovals;
    projects = c.projects;
  } catch {
    pendingApprovals = 0;
    projects = 0;
  }

  return (
    <html lang="en">
      <body>
        <div className="app">
          <aside className="sidebar">
            <div className="sidebar-brand">
              <div className="sidebar-mark" aria-hidden="true">
                MA
              </div>
              <div className="sidebar-name">
                Meridian Advisory
                <span>Engagement Ledger</span>
              </div>
            </div>
            <Nav pendingApprovals={pendingApprovals} projects={projects} />
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}

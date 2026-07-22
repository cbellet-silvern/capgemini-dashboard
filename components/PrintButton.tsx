"use client";

import type { ReactElement } from "react";

/** The statement page is a server component, so the print handler lives here. */
export function PrintButton(): ReactElement {
  return (
    <button
      type="button"
      className="btn is-ghost"
      onClick={() => window.print()}
    >
      <svg
        width={14}
        height={14}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4.5 6.2V2.4h7v3.8" />
        <path d="M4.5 11.8H3.2A1.2 1.2 0 0 1 2 10.6V7.4a1.2 1.2 0 0 1 1.2-1.2h9.6A1.2 1.2 0 0 1 14 7.4v3.2a1.2 1.2 0 0 1-1.2 1.2h-1.3" />
        <path d="M4.5 9.6h7v4H4.5z" />
      </svg>
      Print / PDF
    </button>
  );
}

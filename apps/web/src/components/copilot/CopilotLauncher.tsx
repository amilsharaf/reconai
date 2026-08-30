"use client";

import { useState } from "react";
import { CopilotPanel } from "./CopilotPanel";

export function CopilotLauncher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border px-3 py-2 text-sm font-medium"
        style={{ borderColor: "var(--border)", color: "var(--accent)", background: "var(--surface-card)" }}
      >
        💬 Finance Copilot
      </button>
      <CopilotPanel open={open} onClose={() => setOpen(false)} />
    </>
  );
}

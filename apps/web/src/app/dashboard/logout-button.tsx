"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  // Named handler + `void` at the call site (React attributes expect void).
  async function doLogout() {
    setBusy(true);
    try {
      // Server-side revocation via the BFF proxy (P-GAP-05).
      await fetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        void doLogout();
      }}
      className="rounded-lg border border-line px-3 py-1.5 text-sm text-slate-700 transition hover:bg-surface disabled:opacity-60"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
// ─── GSC view helpers (server-side only) ───
// Window arithmetic and formatters shared by the Search Performance surfaces.
// The default window mirrors the API's incremental planner: 28 days ending
// yesterday — today's Google numbers are incomplete all day and must never be
// presented as final.

import type { GscWindow } from "./types";

export function defaultWindow(): GscWindow {
  const end = new Date(Date.now() - 86_400_000);
  const start = new Date(end.getTime() - 27 * 86_400_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

export function windowQuery(window: GscWindow, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ ...extra, startDate: window.startDate, endDate: window.endDate });
  return params.toString();
}

export function fmtInt(value: number): string {
  return value.toLocaleString("en-US");
}

export function fmtCtr(ctr: number): string {
  return `${(ctr * 100).toFixed(2)}%`;
}

export function fmtPosition(position: number): string {
  return position > 0 ? position.toFixed(2) : "—";
}

export function fmtDate(date: string | null | undefined): string {
  return date ? date.slice(0, 10) : "—";
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

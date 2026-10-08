"use client";

export function PrintReportButton() {
  return (
    <button
      type="button"
      onClick={() => {
        window.print();
      }}
      className="print:hidden rounded bg-ink-950 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800"
    >
      Print or save as PDF
    </button>
  );
}

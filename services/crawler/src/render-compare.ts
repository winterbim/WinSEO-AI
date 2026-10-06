// ─── Source-vs-render comparison (PHASE-3-RENDER, pure) ───
// Compares the HTTP_FAST source snapshot with the browser-rendered DOM on the
// fields the deterministic rules care about. Divergences are OBSERVED facts
// about two documents — never a claim about what any engine will do.

import { parseHtmlPage, type ParsedPage } from "./html-parser.ts";

export interface FieldDivergence {
  field: string;
  source: string;
  rendered: string;
}

export interface RenderComparison {
  rendered: ParsedPage;
  divergences: FieldDivergence[];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Parse the rendered DOM and diff it against the already-parsed source page.
 * Fields: title, meta description, canonical, robots meta, H1s, html lang.
 */
export function compareSourceRender(
  source: ParsedPage,
  renderedHtml: string,
  pageUrl: string,
): RenderComparison {
  const rendered = parseHtmlPage(renderedHtml, pageUrl);
  const divergences: FieldDivergence[] = [];

  const cmp = (field: string, a: string | null, b: string | null) => {
    if ((a ?? "") !== (b ?? "")) {
      divergences.push({ field, source: a ?? "(absent)", rendered: b ?? "(absent)" });
    }
  };

  cmp("title", source.title, rendered.title);
  cmp("meta description", source.metaDescription, rendered.metaDescription);
  cmp("canonical", source.canonical, rendered.canonical);
  cmp("robots meta", source.robotsMeta, rendered.robotsMeta);
  cmp("html lang", source.lang, rendered.lang);
  if (!sameList(source.h1, rendered.h1)) {
    divergences.push({
      field: "H1 headings",
      source: source.h1.join(" | ") || "(none)",
      rendered: rendered.h1.join(" | ") || "(none)",
    });
  }

  return { rendered, divergences };
}

/** One-line human summary persisted with the evidence. */
export function describeDivergences(divergences: FieldDivergence[]): string {
  if (divergences.length === 0) return "source and rendered DOM agree on compared fields";
  return divergences
    .map((d) => `${d.field}: source="${d.source}" rendered="${d.rendered}"`)
    .join("; ");
}
export interface GeoCapture {
  engine: string;
  promptId: string;
  brandMentioned: boolean;
  clientCited: boolean;
  citationDomains: string[];
}

export interface GeoEngineStats {
  engine: string;
  runs: number;
  mentionRate: number;
  mentionWilson95: [number, number];
  citationRate: number;
  citationWilson95: [number, number];
  uniqueCitationDomains: number;
  topCitationDomains: [string, number][];
}

export interface GeoStats {
  inputRows: number;
  engines: GeoEngineStats[];
  warning: string;
}

export type GeoCaptureProvenance = "user_supplied" | "illustrative";

export function geoCaptureProvenanceLabel(source: GeoCaptureProvenance): string {
  return source === "illustrative" ? "ILLUSTRATIVE EXAMPLE" : "USER-SUPPLIED CAPTURE";
}

function truth(value: string): boolean {
  return ["1", "true", "yes", "y"].includes(value.trim().toLowerCase());
}

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      out.push(value);
      value = "";
      continue;
    }
    value += char;
  }
  out.push(value);
  return out.map((cell) => cell.trim());
}

export function parseGeoCsv(csv: string): GeoCapture[] {
  const lines = csv
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0] ?? "").map((h) => h.toLowerCase());
  const required = ["engine", "prompt_id", "brand_mentioned", "client_cited"];
  for (const column of required) {
    if (!header.includes(column)) {
      throw new Error(`Missing required CSV column: ${column}`);
    }
  }

  const idx = (name: string) => header.indexOf(name);
  const domainIndex = idx("citation_domains");

  return lines.slice(1).map((line, rowIndex) => {
    const cells = parseCsvLine(line);
    const engine = cells[idx("engine")]?.trim() ?? "";
    const promptId = cells[idx("prompt_id")]?.trim() ?? "";
    if (!engine || !promptId) {
      throw new Error(`Row ${rowIndex + 2} is missing engine or prompt_id`);
    }
    return {
      engine,
      promptId,
      brandMentioned: truth(cells[idx("brand_mentioned")] ?? ""),
      clientCited: truth(cells[idx("client_cited")] ?? ""),
      citationDomains:
        domainIndex >= 0
          ? (cells[domainIndex] ?? "")
              .split(";")
              .map((domain) => domain.trim().toLowerCase())
              .filter(Boolean)
          : [],
    };
  });
}

export function computeGeoStats(rows: readonly GeoCapture[]): GeoStats {
  const byEngine = new Map<string, GeoCapture[]>();
  for (const row of rows) {
    const list = byEngine.get(row.engine) ?? [];
    list.push(row);
    byEngine.set(row.engine, list);
  }

  const engines = [...byEngine.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([engine, captures]) => {
      const runs = captures.length;
      const mentions = captures.filter((r) => r.brandMentioned).length;
      const citations = captures.filter((r) => r.clientCited).length;
      const domains = new Map<string, number>();
      for (const capture of captures) {
        for (const domain of capture.citationDomains) {
          domains.set(domain, (domains.get(domain) ?? 0) + 1);
        }
      }

      return {
        engine,
        runs,
        mentionRate: runs ? mentions / runs : 0,
        mentionWilson95: wilson(mentions, runs),
        citationRate: runs ? citations / runs : 0,
        citationWilson95: wilson(citations, runs),
        uniqueCitationDomains: domains.size,
        topCitationDomains: [...domains.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 10),
      };
    });

  return {
    inputRows: rows.length,
    engines,
    warning:
      "AI-answer visibility is stochastic. Treat these as repeated-sample measurements, not deterministic rankings.",
  };
}

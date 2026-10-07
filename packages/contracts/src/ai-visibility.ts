/** User supplied AI-answer captures. These are reports of captured answers,
 * not authenticated observations from an AI provider. */
export interface AiVisibilityCapture {
  engine: string;
  promptId: string;
  brandMentioned: boolean;
  clientCited: boolean;
  citationDomains: string[];
  /** ISO 8601 timestamp when the answer was sampled; absent means import time. */
  sampledAt?: string;
}

export interface AiVisibilityStat {
  engine: string;
  promptId: string;
  /** Distinct prompt IDs observed for this engine, across the same import. */
  promptsObserved: number;
  runs: number;
  mentionCount: number;
  citationCount: number;
  mentionRate: number;
  mentionWilson95: [number, number];
  citationRate: number;
  citationWilson95: [number, number];
  uniqueCitationDomains: number;
  topCitationDomains: [string, number][];
}

export const AI_VISIBILITY_MAX_ROWS = 5_000;
export const AI_VISIBILITY_MAX_CSV_BYTES = 1_048_576;

/** Two-sided 95% Wilson score interval using z=1.96. */
export function wilsonInterval95(successes: number, total: number): [number, number] {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(total) ||
    total < 0 ||
    successes < 0 ||
    successes > total
  ) {
    throw new Error("Wilson interval requires integer counts with 0 <= successes <= total.");
  }
  if (total === 0) return [0, 0];
  const z = 1.96;
  const zSquared = z * z;
  const observedRate = successes / total;
  const denominator = 1 + zSquared / total;
  const center = (observedRate + zSquared / (2 * total)) / denominator;
  const halfWidth =
    (z * Math.sqrt((observedRate * (1 - observedRate)) / total + zSquared / (4 * total * total))) /
    denominator;
  return [Math.max(0, center - halfWidth), Math.min(1, center + halfWidth)];
}

type CsvRecord = string[];

function parseCsvRecords(csv: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;

  const finishCell = () => {
    record.push(cell.trim());
    cell = "";
    closedQuote = false;
  };
  const finishRecord = () => {
    finishCell();
    if (record.some((value) => value.length > 0)) records.push(record);
    record = [];
  };

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (csv[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (char === "\r" && csv[index + 1] === "\n") {
        cell += "\n";
        index += 1;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      if (cell.trim().length !== 0 || closedQuote) {
        throw new Error(`Unexpected quote at CSV character ${index + 1}.`);
      }
      quoted = true;
      continue;
    }
    if (char === ",") {
      finishCell();
      continue;
    }
    if (char === "\n" || char === "\r") {
      finishRecord();
      if (char === "\r" && csv[index + 1] === "\n") index += 1;
      continue;
    }
    if (closedQuote && char.trim().length > 0) {
      throw new Error(`Unexpected character after closing quote at CSV character ${index + 1}.`);
    }
    cell += char;
  }

  if (quoted) throw new Error("CSV ends inside a quoted field.");
  if (cell.length > 0 || record.length > 0 || closedQuote) finishRecord();
  return records;
}

function parseBoolean(value: string, rowNumber: number, column: string): boolean {
  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "y":
      return true;
    case "false":
    case "0":
    case "no":
    case "n":
      return false;
    default:
      throw new Error(`Row ${rowNumber}: ${column} must be true/false, yes/no, y/n, or 1/0.`);
  }
}

function normalizeCitationDomain(value: string, rowNumber: number): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    domain.length === 0 ||
    domain.length > 253 ||
    !domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error(`Row ${rowNumber}: invalid citation domain '${value}'.`);
  }
  return domain;
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}

/** Parse and strictly validate the exact CSV text submitted for import. */
export function parseAiVisibilityCsv(csvText: string): AiVisibilityCapture[] {
  if (new TextEncoder().encode(csvText).byteLength > AI_VISIBILITY_MAX_CSV_BYTES) {
    throw new Error("CSV exceeds the 1 MiB import limit.");
  }
  const normalizedCsv = csvText.replace(/^\uFEFF/, "");
  const records = parseCsvRecords(normalizedCsv);
  if (records.length < 2)
    throw new Error("CSV must include a header and at least one capture row.");

  const header = (records[0] ?? []).map((value) => value.toLowerCase());
  const allowed = new Set([
    "engine",
    "prompt_id",
    "brand_mentioned",
    "client_cited",
    "citation_domains",
    "sampled_at",
  ]);
  if (new Set(header).size !== header.length) throw new Error("CSV contains duplicate columns.");
  for (const column of header) {
    if (!allowed.has(column)) throw new Error(`Unsupported CSV column: ${column || "(empty)"}.`);
  }
  for (const required of ["engine", "prompt_id", "brand_mentioned", "client_cited"]) {
    if (!header.includes(required)) throw new Error(`Missing required CSV column: ${required}.`);
  }

  const columnIndex = (name: string): number => header.indexOf(name);
  const result: AiVisibilityCapture[] = [];
  for (const [recordIndex, cells] of records.slice(1).entries()) {
    const rowNumber = recordIndex + 2;
    if (cells.length !== header.length) {
      throw new Error(
        `Row ${rowNumber}: expected ${header.length} columns, received ${cells.length}.`,
      );
    }
    const engine = cells[columnIndex("engine")]?.trim() ?? "";
    const promptId = cells[columnIndex("prompt_id")]?.trim() ?? "";
    if (!engine || engine.length > 100) {
      throw new Error(`Row ${rowNumber}: engine must contain 1–100 characters.`);
    }
    if (containsControlCharacters(engine)) {
      throw new Error(`Row ${rowNumber}: engine cannot contain control characters.`);
    }
    if (!promptId || promptId.length > 500) {
      throw new Error(`Row ${rowNumber}: prompt_id must contain 1–500 characters.`);
    }
    if (containsControlCharacters(promptId)) {
      throw new Error(`Row ${rowNumber}: prompt_id cannot contain control characters.`);
    }

    const domainsCell = cells[columnIndex("citation_domains")] ?? "";
    const citationDomains = [
      ...new Set(
        domainsCell
          .split(";")
          .map((domain) => domain.trim())
          .filter(Boolean)
          .map((domain) => normalizeCitationDomain(domain, rowNumber)),
      ),
    ];
    if (citationDomains.length > 50) {
      throw new Error(`Row ${rowNumber}: citation_domains may contain at most 50 domains.`);
    }

    const sampledAtCell = cells[columnIndex("sampled_at")]?.trim() ?? "";
    let sampledAt: string | undefined;
    if (sampledAtCell) {
      const timestamp =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(
          sampledAtCell,
        );
      const year = Number(timestamp?.[1]);
      const month = Number(timestamp?.[2]);
      const day = Number(timestamp?.[3]);
      const hour = Number(timestamp?.[4]);
      const minute = Number(timestamp?.[5]);
      const second = Number(timestamp?.[6]);
      const offsetHour = Number(timestamp?.[9] ?? 0);
      const offsetMinute = Number(timestamp?.[10] ?? 0);
      const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      const validCalendarDate =
        timestamp !== null &&
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= (daysInMonth[month - 1] ?? 0);
      const validTime = hour <= 23 && minute <= 59 && second <= 59;
      const validOffset = offsetHour <= 23 && offsetMinute <= 59;
      const parsedDate = new Date(sampledAtCell);
      if (
        !validCalendarDate ||
        !validTime ||
        !validOffset ||
        !Number.isFinite(parsedDate.getTime())
      ) {
        throw new Error(`Row ${rowNumber}: sampled_at must be a valid ISO 8601 timestamp.`);
      }
      sampledAt = parsedDate.toISOString();
    }

    result.push({
      engine,
      promptId,
      brandMentioned: parseBoolean(
        cells[columnIndex("brand_mentioned")] ?? "",
        rowNumber,
        "brand_mentioned",
      ),
      clientCited: parseBoolean(
        cells[columnIndex("client_cited")] ?? "",
        rowNumber,
        "client_cited",
      ),
      citationDomains,
      ...(sampledAt ? { sampledAt } : {}),
    });
    if (result.length > AI_VISIBILITY_MAX_ROWS) {
      throw new Error("CSV contains more than 5,000 capture rows.");
    }
  }
  if (result.length === 0) throw new Error("CSV contains no capture rows.");
  return result;
}

/** Pure grouping helper used for a single stored import and browser previews. */
export function computeAiVisibilityStats(
  captures: readonly AiVisibilityCapture[],
): AiVisibilityStat[] {
  const grouped = new Map<string, AiVisibilityCapture[]>();
  const promptsByEngine = new Map<string, Set<string>>();
  for (const capture of captures) {
    const key = JSON.stringify([capture.engine, capture.promptId]);
    const group = grouped.get(key) ?? [];
    group.push(capture);
    grouped.set(key, group);
    const prompts = promptsByEngine.get(capture.engine) ?? new Set<string>();
    prompts.add(capture.promptId);
    promptsByEngine.set(capture.engine, prompts);
  }
  return [...grouped.values()]
    .map((rows) => {
      const first = rows[0];
      if (!first) return null;
      const domains = new Map<string, number>();
      for (const row of rows) {
        for (const domain of new Set(row.citationDomains)) {
          domains.set(domain, (domains.get(domain) ?? 0) + 1);
        }
      }
      const mentionCount = rows.filter((row) => row.brandMentioned).length;
      const citationCount = rows.filter((row) => row.clientCited).length;
      const topCitationDomains = [...domains.entries()]
        .sort(
          ([aDomain, aCount], [bDomain, bCount]) =>
            bCount - aCount || aDomain.localeCompare(bDomain),
        )
        .slice(0, 10);
      return {
        engine: first.engine,
        promptId: first.promptId,
        promptsObserved: promptsByEngine.get(first.engine)?.size ?? 0,
        runs: rows.length,
        mentionCount,
        citationCount,
        mentionRate: mentionCount / rows.length,
        mentionWilson95: wilsonInterval95(mentionCount, rows.length),
        citationRate: citationCount / rows.length,
        citationWilson95: wilsonInterval95(citationCount, rows.length),
        uniqueCitationDomains: domains.size,
        topCitationDomains,
      };
    })
    .filter((stat): stat is AiVisibilityStat => stat !== null)
    .sort((a, b) => a.engine.localeCompare(b.engine) || a.promptId.localeCompare(b.promptId));
}

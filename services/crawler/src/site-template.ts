import { createHash } from "node:crypto";
import { parse } from "parse5";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MAX_TEMPLATE_HTML_BYTES = 128 * 1024;
const MAX_TEMPLATE_NODES = 30_000;

const STRUCTURAL_TAGS = new Set([
  "header",
  "nav",
  "main",
  "article",
  "aside",
  "footer",
  "section",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "li",
  "template",
  "figure",
  "img",
  "video",
  "iframe",
  "form",
  "table",
]);

const COUNTED_TAGS = ["h1", "h2", "h3", "img", "video", "iframe", "figure", "form", "table"];
const SENSITIVE_ROUTE_SEGMENTS = new Set(
  "access auth code codes confirm download invite magic-link password-reset recover reset session sessions share shares token verify".split(
    " ",
  ),
);
const SAFE_ROUTE_SEGMENTS = new Set([
  ...`about articles authors blog blogs categories category contact docs faq guide help news offers orders page pages pricing product products recipes resources search services shop stories tags users videos`.split(
    " ",
  ),
  ...SENSITIVE_ROUTE_SEGMENTS,
]);
const RECOGNIZED_COLLECTION_SEGMENTS = new Set(
  "articles authors blog blogs categories pages products recipes stories tags videos".split(" "),
);
const DYNAMIC_SUFFIX_PREFIXES = new Set(
  "article item page post product recipe story video".split(" "),
);

interface ShapeNode {
  tag: string;
  children: ShapeNode[];
}

interface HtmlNode {
  tagName?: string;
  namespaceURI?: string;
  childNodes?: HtmlNode[];
  content?: { childNodes?: HtmlNode[] };
}

export interface SitePageShape {
  url: string;
  html: string;
  /** Null means no semantic HTML fingerprint is available for this page. */
  domSignatureHash?: string | null;
}

export interface SitePageStructure {
  url: string;
  domSignatureHash: string | null;
}

export interface SiteTemplateGroup {
  id: string;
  routePattern: string;
  domSignatureHash: string | null;
  pageCount: number;
  sampleUrls: string[];
  groupingMethod:
    | "URL_PATTERN_AND_SEMANTIC_DOM_V2"
    | "URL_PATTERN_ONLY_PRIVACY_SINGLETON_V2"
    | "SEMANTIC_DOM_PRIVACY_SINGLETON_V1";
}

export interface SiteTemplateGrouping {
  groups: SiteTemplateGroup[];
  byUrl: Map<string, SiteTemplateGroup>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

interface IdCandidate {
  family: string;
  pathLabel: string;
  value: string;
}

interface PreparedPage {
  page: SitePageShape;
  signature: string | null;
  rawSegments: string[];
  idCandidate: IdCandidate | null;
  siblingKey: string | null;
}

function rawRouteSegments(url: string): string[] {
  return new URL(url).pathname.split("/").filter(Boolean).map(decodeSegment);
}

function candidateForLeaf(segment: string | undefined): IdCandidate | null {
  if (!segment) return null;
  const lower = segment.toLowerCase();
  if (/^\d+$/.test(segment)) return { family: "numeric", pathLabel: ":id", value: lower };
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment))
    return { family: "uuid", pathLabel: ":id", value: lower };
  if (/^\d{4}-\d{2}-\d{2}$/.test(segment))
    return { family: "date", pathLabel: ":date", value: lower };
  const numericSuffix = /^([a-z]+)[-_](\d+)$/i.exec(segment);
  const prefix = numericSuffix?.[1]?.toLowerCase();
  if (numericSuffix && prefix && DYNAMIC_SUFFIX_PREFIXES.has(prefix)) {
    return {
      family: `suffix:${prefix}`,
      pathLabel: `${prefix}-:id`,
      value: numericSuffix[2] ?? lower,
    };
  }
  return null;
}

function safeRouteSegments(
  rawSegments: string[],
  idPathLabel?: string,
  allowSanitizedParameters = false,
): string[] {
  let sensitivePath = false;
  return rawSegments.map((segment, index) => {
    const lower = segment.toLowerCase();
    if (SENSITIVE_ROUTE_SEGMENTS.has(lower)) {
      sensitivePath = true;
      return lower;
    }
    if (sensitivePath) return ":private";
    if (idPathLabel && index === rawSegments.length - 1) return idPathLabel;
    if (allowSanitizedParameters && isSafeRouteParameter(lower)) return lower;
    if (SAFE_ROUTE_SEGMENTS.has(lower)) return lower;
    return ":private";
  });
}

function isSafeRouteParameter(segment: string): boolean {
  if ([":private", ":id", ":date"].includes(segment)) return true;
  const suffix = /^([a-z]+)-:id$/.exec(segment);
  return suffix?.[1] !== undefined && DYNAMIC_SUFFIX_PREFIXES.has(suffix[1]);
}

function bucket(count: number): string {
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count <= 4) return "2-4";
  return "5+";
}

function samplePath(url: string, allowSanitizedParameters = false): string {
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const rawSegments = rawRouteSegments(url);
  const leafCandidate = candidateForLeaf(rawSegments.at(-1));
  parsed.pathname = `/${safeRouteSegments(rawSegments, leafCandidate?.pathLabel, allowSanitizedParameters).join("/")}`;
  return parsed.href;
}

/** Validate legacy group summaries before exposing them from persisted crawl history. */
export function isPrivacySafeTemplateGroupMetadata(
  routePattern: string,
  sampleUrls: string[],
  groupingMethod?: SiteTemplateGroup["groupingMethod"],
  pageCount?: number,
): boolean {
  if (!routePattern.startsWith("/") || routePattern.length > 2_048) return false;
  const routeSegments = routePattern.split("/").filter(Boolean);
  if (
    routeSegments.some(
      (segment) => !SAFE_ROUTE_SEGMENTS.has(segment) && !isSafeRouteParameter(segment),
    )
  )
    return false;
  const leaf = routeSegments.at(-1);
  const suffix = leaf ? /^([a-z]+)-:id$/.exec(leaf) : null;
  const generalizedIdRoute = leaf === ":id" || leaf === ":date" || suffix !== null;
  if (
    generalizedIdRoute &&
    groupingMethod !== "URL_PATTERN_AND_SEMANTIC_DOM_V2" &&
    groupingMethod !== "URL_PATTERN_ONLY_PRIVACY_SINGLETON_V2" &&
    groupingMethod !== "SEMANTIC_DOM_PRIVACY_SINGLETON_V1"
  )
    return false;
  if (
    generalizedIdRoute &&
    groupingMethod === "URL_PATTERN_AND_SEMANTIC_DOM_V2" &&
    (!routeSegments.at(-2) || !RECOGNIZED_COLLECTION_SEGMENTS.has(routeSegments.at(-2) ?? ""))
  )
    return false;
  if (
    generalizedIdRoute &&
    groupingMethod === "URL_PATTERN_AND_SEMANTIC_DOM_V2" &&
    (pageCount ?? 0) < 3
  )
    return false;
  if (groupingMethod === "URL_PATTERN_AND_SEMANTIC_DOM_V2" && routeSegments.includes(":private"))
    return false;
  if (groupingMethod === "SEMANTIC_DOM_PRIVACY_SINGLETON_V1" && pageCount !== 1) return false;
  if (sampleUrls.length === 0) return false;
  if (pageCount === 1 && sampleUrls.length !== 1) return false;

  return sampleUrls.every((sampleUrl) => {
    try {
      const url = new URL(sampleUrl);
      const normalizedSample = samplePath(sampleUrl, true);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password &&
        normalizedSample === sampleUrl &&
        new URL(normalizedSample).pathname === routePattern
      );
    } catch {
      return false;
    }
  });
}

function shapeSignature(root: ShapeNode): string {
  const signatures = new Map<ShapeNode, string>();
  const stack: { node: ShapeNode; visited: boolean }[] = [{ node: root, visited: false }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (!current.visited) {
      stack.push({ node: current.node, visited: true });
      for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
        const child = current.node.children[index];
        if (child) stack.push({ node: child, visited: false });
      }
      continue;
    }

    const childCounts = new Map<string, number>();
    for (const child of current.node.children) {
      const signature = signatures.get(child) ?? "";
      childCounts.set(signature, (childCounts.get(signature) ?? 0) + 1);
    }
    const children = [...childCounts].map(([signature, count]) => `${signature}*${bucket(count)}`);
    signatures.set(current.node, hash(`${current.node.tag}[${children.join(",")}]`));
  }
  return signatures.get(root) ?? hash("root[]");
}

/** Hash a content-free HTML5 DOM shape; oversized pages are intentionally ungrouped. */
export function semanticDomSignature(html: string): string | null {
  if (Buffer.byteLength(html, "utf8") > MAX_TEMPLATE_HTML_BYTES) return null;

  const document = parse(html, { scriptingEnabled: true }) as unknown as HtmlNode;
  const root: ShapeNode = { tag: "root", children: [] };
  const counts = new Map<string, number>();
  const stack: { node: HtmlNode; nearestShape: ShapeNode }[] = [
    { node: document, nearestShape: root },
  ];
  let visitedNodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    visitedNodes += 1;
    if (visitedNodes > MAX_TEMPLATE_NODES) return null;

    let nearestShape = current.nearestShape;
    const tagName = current.node.tagName?.toLowerCase();
    if (tagName && current.node.namespaceURI === HTML_NAMESPACE && STRUCTURAL_TAGS.has(tagName)) {
      const shapeNode: ShapeNode = { tag: tagName, children: [] };
      current.nearestShape.children.push(shapeNode);
      nearestShape = shapeNode;
      if (COUNTED_TAGS.includes(tagName)) counts.set(tagName, (counts.get(tagName) ?? 0) + 1);
    }

    const children = [
      ...(current.node.childNodes ?? []),
      ...(tagName === "template" ? (current.node.content?.childNodes ?? []) : []),
    ];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) stack.push({ node: child, nearestShape });
    }
  }

  const countSignature = COUNTED_TAGS.map((tag) => `${tag}:${bucket(counts.get(tag) ?? 0)}`).join(
    ",",
  );
  return hash(`${shapeSignature(root)}\n${countSignature}`);
}

/** Group already-fingerprinted pages so callers need not retain fetched HTML. */
export function groupSitePageStructures(pages: SitePageStructure[]): SiteTemplateGrouping {
  return groupSitePagesByTemplate(
    pages.map((page) => ({ url: page.url, html: "", domSignatureHash: page.domSignatureHash })),
  );
}

/**
 * Groups pages by a conservative URL pattern plus an HTML5 semantic DOM
 * signature. This describes observed structure; it does not identify a CMS or
 * claim that pages share an implementation template.
 */
export function groupSitePagesByTemplate(pages: SitePageShape[]): SiteTemplateGrouping {
  const prepared: PreparedPage[] = pages.map((page) => {
    const rawSegments = rawRouteSegments(page.url);
    const parent = rawSegments.at(-2)?.toLowerCase();
    const idCandidate = candidateForLeaf(rawSegments.at(-1));
    const safeParent = safeRouteSegments(rawSegments.slice(0, -1));
    const parentSafe = rawSegments
      .slice(0, -1)
      .every((segment) => SAFE_ROUTE_SEGMENTS.has(segment.toLowerCase()));
    const siblingKey =
      parentSafe && parent && RECOGNIZED_COLLECTION_SEGMENTS.has(parent) && idCandidate
        ? `${safeParent.join("/")}\n${idCandidate.family}`
        : null;
    const signature =
      page.domSignatureHash !== undefined ? page.domSignatureHash : semanticDomSignature(page.html);
    return { page, signature, rawSegments, idCandidate, siblingKey };
  });

  const siblingValues = new Map<string, Set<string>>();
  for (const item of prepared) {
    if (!item.siblingKey || !item.idCandidate) continue;
    const values = siblingValues.get(item.siblingKey) ?? new Set<string>();
    values.add(item.idCandidate.value);
    siblingValues.set(item.siblingKey, values);
  }

  const keyed = prepared.map((item, index) => {
    const isProvenIdRoute =
      item.siblingKey !== null &&
      (siblingValues.get(item.siblingKey)?.size ?? 0) >= 3 &&
      item.idCandidate !== null;
    const routeSegments = safeRouteSegments(item.rawSegments, item.idCandidate?.pathLabel);
    const routePattern = `/${routeSegments.join("/")}`;
    const containsUnknownSegment = routeSegments.includes(":private");
    const privacySingleton =
      item.signature !== null &&
      (containsUnknownSegment || item.idCandidate !== null) &&
      !isProvenIdRoute;
    const groupingMethod =
      item.signature === null
        ? ("URL_PATTERN_ONLY_PRIVACY_SINGLETON_V2" as const)
        : privacySingleton
          ? ("SEMANTIC_DOM_PRIVACY_SINGLETON_V1" as const)
          : ("URL_PATTERN_AND_SEMANTIC_DOM_V2" as const);
    const groupingKey =
      item.signature && !privacySingleton
        ? `${routePattern}\n${item.signature}`
        : `singleton\n${routePattern}\n${index}`;
    return {
      page: item.page,
      routePattern,
      domSignatureHash: item.signature,
      groupingMethod,
      groupingKey,
    };
  });

  const grouped = new Map<string, typeof keyed>();
  for (const item of keyed) {
    const entries = grouped.get(item.groupingKey) ?? [];
    entries.push(item);
    grouped.set(item.groupingKey, entries);
  }

  const groups: SiteTemplateGroup[] = [];
  const byUrl = new Map<string, SiteTemplateGroup>();
  for (const entries of grouped.values()) {
    const first = entries[0];
    if (!first) continue;
    const routeSegments = first.routePattern.split("/").filter(Boolean);
    const leaf = routeSegments.at(-1);
    const generalizedIdRoute =
      leaf === ":id" || leaf === ":date" || (leaf ? /^[a-z]+-:id$/.test(leaf) : false);
    const groupingMethod =
      first.groupingMethod === "URL_PATTERN_AND_SEMANTIC_DOM_V2" &&
      generalizedIdRoute &&
      entries.length < 3
        ? ("SEMANTIC_DOM_PRIVACY_SINGLETON_V1" as const)
        : first.groupingMethod;
    const group: SiteTemplateGroup = {
      id: hash(first.groupingKey).slice(0, 16),
      routePattern: first.routePattern,
      domSignatureHash: first.domSignatureHash,
      pageCount: entries.length,
      sampleUrls: [...new Set(entries.map((entry) => samplePath(entry.page.url)))]
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 3),
      groupingMethod,
    };
    groups.push(group);
    for (const entry of entries) byUrl.set(entry.page.url, group);
  }
  groups.sort((a, b) => a.routePattern.localeCompare(b.routePattern) || a.id.localeCompare(b.id));
  return { groups, byUrl };
}

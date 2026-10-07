// ─── Render escalation decision (PHASE-3-RENDER, pure) ───
// HTTP_FAST stays the default. Rendering is an expensive escalation that must
// be justified by DETERMINISTIC signals in the source document — never on a
// whim, never silently. Every escalation carries explicit reasons that are
// persisted with the evidence (Blueprint §12.4 two-pass rendering).

import { stripTags, type ParsedPage } from "./html-parser.ts";

export interface EscalationDecision {
  escalate: boolean;
  /** Human-readable, persisted reasons explaining WHY rendering was triggered. */
  reasons: string[];
}

/** Minimum visible body text (chars) before a page counts as content-complete. */
const THIN_BODY_TEXT = 250;

function bodyText(html: string): string {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return stripTags(m?.[1] ?? "");
}

/**
 * Decide whether the HTTP_FAST snapshot justifies a browser render.
 * Signals (all observable in the fetched source, no guessing):
 *  1. SHELL_ONLY_BODY   — visible body text is very thin (typical SPA shell).
 *  2. APP_MOUNT_EMPTY    — a framework mount node (#root / #__next) exists but
 *                          carries almost no server-rendered content.
 *  3. NOSCRIPT_CONTENT   — content is explicitly gated behind JavaScript.
 *  4. HEAD_UNPOPULATED   — both title and meta description are missing in the
 *                          source (frequently injected at runtime).
 */
export function shouldRender(parsed: ParsedPage, html: string): EscalationDecision {
  const reasons: string[] = [];

  const text = bodyText(html);
  if (text.length < THIN_BODY_TEXT) {
    reasons.push(
      `SHELL_ONLY_BODY: visible body text is ${text.length} chars (< ${THIN_BODY_TEXT}) — content is likely JavaScript-rendered`,
    );
  }

  const mount = /<div[^>]*(?:id="root"|id="__next")[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (mount) {
    const mountText = stripTags(mount[1] ?? "");
    if (mountText.length < THIN_BODY_TEXT) {
      reasons.push(
        `APP_MOUNT_EMPTY: framework mount node is present but nearly empty ("${mountText.trim().slice(0, 60)}")`,
      );
    }
  }

  const noscript = /<noscript[^>]*>([\s\S]*?)<\/noscript>/i.exec(html);
  if (noscript && stripTags(noscript[1] ?? "").trim().length > 20) {
    reasons.push("NOSCRIPT_CONTENT: page ships content that requires JavaScript to view");
  }

  if (!parsed.title && !parsed.metaDescription) {
    reasons.push(
      "HEAD_UNPOPULATED: source has neither <title> nor meta description (often injected at runtime)",
    );
  }

  return { escalate: reasons.length > 0, reasons };
}

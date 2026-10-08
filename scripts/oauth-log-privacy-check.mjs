import { readFileSync } from "node:fs";

export function containsOAuthCredentialLog(logText) {
  if (typeof logText !== "string") throw new TypeError("logText must be a string");

  for (const rawLine of logText.split(/\r?\n/)) {
    if (containsCredentialText(rawLine)) return true;

    const decodedLine = decodeRepeatedly(rawLine);
    if (decodedLine.exhausted) return true;
    for (const candidate of decodedLine.value === rawLine
      ? [rawLine]
      : [rawLine, decodedLine.value]) {
      try {
        if (hasOAuthCredentialValue(JSON.parse(candidate))) return true;
      } catch {
        // Request logs may also be plain text; the URL checks above cover those.
      }
    }
  }

  return false;
}

function decodeRepeatedly(value) {
  let decoded = value;
  for (let pass = 0; pass < 10; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return { value: decoded, exhausted: false };
      decoded = next;
      if (pass === 9) {
        try {
          return {
            value: decoded,
            exhausted: decodeURIComponent(decoded) !== decoded,
          };
        } catch {
          return { value: decoded, exhausted: decoded.includes("%") };
        }
      }
    } catch {
      // A malformed percent escape can hide a credential before the decoder
      // rejects the whole string. Treat any remaining escape marker as
      // uninspectable content so the privacy gate fails closed.
      return { value: decoded, exhausted: decoded.includes("%") };
    }
  }
  return { value: decoded, exhausted: false };
}

function containsCredentialText(value) {
  const { value: decoded, exhausted } = decodeRepeatedly(value);
  return (
    exhausted ||
    /\/gsc\/oauth\/callback\s*\?/i.test(decoded) ||
    /(?:[?&\s])(?:code|state)\s*=\s*[^&\s"']+/i.test(decoded)
  );
}

function hasOAuthCredentialValue(value, depth = 0) {
  if (depth > 12) return true;
  if (typeof value === "string") {
    if (containsCredentialText(value)) return true;
    const { value: decoded, exhausted } = decodeRepeatedly(value);
    if (exhausted) return true;
    if (decoded !== value) {
      try {
        if (hasOAuthCredentialValue(JSON.parse(decoded), depth + 1)) return true;
      } catch {
        // Strings may not contain encoded JSON; their raw query was checked above.
      }
    }
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string" || parsed !== value) {
        return hasOAuthCredentialValue(parsed, depth + 1);
      }
    } catch {
      // Ordinary text values are leaves.
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((child) => hasOAuthCredentialValue(child, depth + 1));
  if (value === null || typeof value !== "object") return false;

  return Object.entries(value).some(([key, child]) => {
    if (/^(?:code|state)$/i.test(key) && hasNonEmptyString(child)) return true;
    return hasOAuthCredentialValue(child, depth + 1);
  });
}

function hasNonEmptyString(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasNonEmptyString);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasNonEmptyString);
  }
  return false;
}

export function scanOAuthLogFile(path) {
  return containsOAuthCredentialLog(readFileSync(path, "utf8"));
}

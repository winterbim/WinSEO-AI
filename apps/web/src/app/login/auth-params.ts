export type AuthMode = "login" | "register";

export function authModeFromQuery(mode: string | null): AuthMode {
  return mode === "register" ? "register" : "login";
}

const LOCAL_URL_BASE = "https://serpvera.invalid";

function hasUnsafeLocalPath(path: string): boolean {
  let decodedPath = path;
  for (let pass = 0; pass < 4; pass += 1) {
    try {
      const decoded = decodeURIComponent(decodedPath);
      if (
        decoded.includes("\\") ||
        decoded.startsWith("//") ||
        Array.from(decoded).some((character) => {
          const code = character.charCodeAt(0);
          return code < 0x20 || code === 0x7f;
        }) ||
        decoded.split("/").some((segment) => segment === "." || segment === "..")
      ) {
        return true;
      }
      if (decoded === decodedPath) return false;
      decodedPath = decoded;
    } catch {
      return true;
    }
  }

  // Repeated encoding is not needed for a local destination. Reject it rather
  // than leave another decoder with a chance to expose a dot or slash segment.
  return decodedPath !== path;
}

export function safeNextPath(next: string | null): string {
  if (
    !next ||
    !next.startsWith("/") ||
    next.startsWith("//") ||
    next.includes("\\") ||
    Array.from(next).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return "/dashboard";
  }

  try {
    const url = new URL(next, LOCAL_URL_BASE);
    const rawPath = next.split(/[?#]/, 1)[0] ?? "";
    if (
      url.origin !== LOCAL_URL_BASE ||
      url.pathname.startsWith("//") ||
      hasUnsafeLocalPath(rawPath)
    ) {
      return "/dashboard";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/dashboard";
  }
}

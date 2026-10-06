#!/usr/bin/env python3
"""Drive the Google OAuth consent over Chrome DevTools Protocol.

Uses a headless Chrome instance launched against a COPY of the local Chrome
profile (same user, system-keyring cookie key), so an existing Google session
is the person's — this driver never enters credentials, never reads cookies,
and never prints tokens: it only clicks the account's own consent buttons.

Modes:
  probe <url>     navigate + dump a redacted page summary (session detection)
  consent <url>   navigate and complete the consent (account chooser /
                  unverified-app interstitial / Allow). Exit codes:
                    0 = redirected to the app (document text printed)
                    2 = Google demands interactive login (no session)
                    3 = timeout           4 = unexpected page
  Prints screenshots to /tmp for raw evidence (kept OUT of the repo).
"""
import base64
import json
import re
import sys
import time

import websocket  # websocket-client

CDP = "http://127.0.0.1:9444"
TOKEN_SHAPE = re.compile(r"ya29\.[A-Za-z0-9_\-]+|1//[A-Za-z0-9_\-]+")


def target_ws() -> str:
    import urllib.request
    listing = json.load(urllib.request.urlopen(f"{CDP}/json/list"))
    for t in listing:
        if t.get("type") == "page":
            return t["webSocketDebuggerUrl"]
    new = json.load(urllib.request.urlopen(
        f"{CDP}/json/new?{urllib.parse.quote('about:blank', safe='')}"))
    return new["webSocketDebuggerUrl"]


class Cdp:
    def __init__(self):
        self.ws = websocket.create_connection(target_ws(), timeout=20)
        self.seq = 0

    def send(self, method: str, params: dict | None = None) -> dict:
        self.seq += 1
        self.ws.send(json.dumps({"id": self.seq, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.seq:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def eval(self, expr: str):
        res = self.send("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": True})
        return res.get("result", {}).get("value")

    def screenshot(self, name: str) -> str:
        res = self.send("Page.captureScreenshot", {"format": "png"})
        path = f"/tmp/{name}.png"
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(res["data"]))
        return path

    def navigate(self, url: str, timeout: float = 45.0) -> None:
        self.send("Page.enable")
        self.send("Page.navigate", {"url": url})
        deadline = time.time() + timeout
        while time.time() < deadline:
            state = self.eval("document.readyState")
            href = self.eval("location.href") or ""
            if state == "complete" and href:
                return
            time.sleep(0.3)


# Runs INSIDE the page. Pure DOM: no network of its own.
STEP_JS = r"""
(() => {
  const href = location.href;
  const text = (document.body && document.body.innerText) || "";
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const clickByText = (patterns) => {
    const nodes = [...document.querySelectorAll('button, input[type=submit], a[role=button], li[role=link]')];
    for (const pat of patterns) {
      for (const el of nodes) {
        const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        if (pat.test(label) && isVisible(el)) { el.click(); return label; }
      }
    }
    return null;
  };
  if (href.includes('localhost')) return { done: true, href, body: text.slice(0, 1500) };
  if (document.querySelector('input[type=password]')) return { done: true, login: true, href };
  if (href.includes('accounts.google.com') && /v3\/signin|AddSession|challenge/i.test(href))
    return { done: true, login: true, href };
  if (/not verified|unverified|haven.t been verified/i.test(text)) {
    const clicked = clickByText([/^Go to/i, /^Advanced/i, /unsafe/i]);
    if (clicked) return { step: 'unverified->' + clicked };
  }
  if (/Choose an account|Choose another account/i.test(text)) {
    const acct = [...document.querySelectorAll('[data-email],[data-identifier],li[role=link],div[role=link]')]
      .find(isVisible);
    if (acct) { acct.click(); return { step: 'account->' + (acct.getAttribute('data-email') || 'entry') }; }
  }
  const clicked = clickByText([
    /^Allow\b/i, /^Continue\b/i, /^Approve\b/i, /^Autoriser\b/i, /^Accept\b/i,
    /^Allow access/i, /^Grant/i, /^Confirm\b/i
  ]);
  if (clicked) return { step: 'click->' + clicked };
  return { done: false, waiting: true, href,
           hint: text.slice(0, 240).replace(/\s+/g, ' ') };
})()
"""


def redact(text: str) -> str:
    text = TOKEN_SHAPE.sub("<token>", text)
    # Drop e-mail-looking strings: identity stays private.
    return re.sub(r"[\w.+-]+@[\w.-]+", "<email>", text)


def probe(url: str) -> int:
    cdp = Cdp()
    cdp.navigate(url)
    time.sleep(2.5)
    state = cdp.eval(STEP_JS) or {}
    print("probe state:", json.dumps(state, ensure_ascii=False)[:600])
    shot = cdp.screenshot("gsc-consent-probe")
    print("screenshot:", shot)
    if state.get("done") and not state.get("login") and state.get("href", "").startswith("localhost"):
        print("SESSION READY — already on the app callback")
        return 0
    if state.get("login"):
        print("NO GOOGLE SESSION in the copied profile (login page)")
        return 2
    print("PARTIAL — consent UI reachable, click needed")
    return 0


def consent(url: str) -> int:
    cdp = Cdp()
    cdp.navigate(url)
    steps: list[str] = []
    deadline = time.time() + 150
    last = {}
    while time.time() < deadline:
        state = cdp.eval(STEP_JS) or {}
        last = state
        if state.get("done"):
            if state.get("login"):
                print("LOGIN_REQUIRED — Google demands interactive sign-in")
                print("state:", redact(json.dumps(state))[:400])
                cdp.screenshot("gsc-consent-login")
                return 2
            body = redact(str(state.get("body", "")))
            print("CALLBACK BODY:", body[:800])
            cdp.screenshot("gsc-consent-done")
            ok = ('"connected"' in body) or ("status" in body and "error" not in body)
            return 0 if ok else 4
        if "step" in state:
            steps.append(str(state["step"]))
            print("step:", redact(str(state["step"]))[:160], flush=True)
            time.sleep(1.2)
            continue
        time.sleep(0.8)
    print("TIMEOUT — last state:", redact(json.dumps(last))[:500])
    cdp.screenshot("gsc-consent-timeout")
    return 3


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("probe", "consent"):
        print(__doc__)
        return 4
    mode, url = sys.argv[1], sys.argv[2]
    return probe(url) if mode == "probe" else consent(url)


if __name__ == "__main__":
    sys.exit(main())

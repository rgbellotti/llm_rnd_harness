# Web tool

Install with `uv sync --project web_tool` from the harness root, then
`uv run --project web_tool playwright install chromium`.

- `uv run --project web_tool web-tool search "query" 5` prints URL, title,
  and summary for each search result. The count defaults to 5 (range 1–20).
- `uv run --project web_tool web-tool fetch https://example.com` prints the
  source URL and readable page text. An anchor with visible text is
  written `† <link text>·( <resolved URL> )`. A space separates the
  dagger from the words, and the middle dot sits at the end of the link
  text, against the opening parenthesis. A space sits on each side of the
  resolved URL. The space and closing parenthesis end the link. An anchor
  with no visible text omits the middle dot: `†( <resolved URL> )`.

The harness requests approval before search execution and presents fetched
content for editing before submission to the model. See the root README for
that workflow and transcript/export behavior.

## Fetch policy

`fetch` refuses anything outside the public internet, and it does so for
the whole page load, not just the first request:

- HTTP(S) only; no embedded credentials and no control characters.
- No local or internal host names (`localhost`, `*.localhost`, `*.local`,
  `*.internal`, `*.home.arpa`, `*.lan`, `*.home`, `*.corp`).
- No address in loopback, private, link-local, carrier-grade NAT or other
  special-purpose space — neither as a literal nor as an address a name
  resolves to. Numeric host forms (`2130706433`) are resolved, so they
  cannot slip through. IPv4-mapped IPv6 and 6to4/NAT64 addresses that
  embed a private IPv4 target are refused too.
- **Every redirect hop.** The browser follows a `302` on its own, without
  the tool ever seeing the new target, so the chain is followed by hand
  and each hop is checked before the request is made. A scheme-changing
  redirect is refused.
- **Every subresource and popup.** Context-level routing covers pages
  opened by `window.open`. Service, shared, and dedicated workers are
  blocked, WebSocket connections are mocked off the network (they are
  invisible to Playwright request routing), and WebTransport/WebRTC are
  disabled.
- **The address the connection actually used.** The check resolves the
  name itself and the request resolves it again a moment later; a name
  that answers differently the second time (DNS rebinding) cannot get a
  response back, because the peer address of the finished connection is
  verified and the content of a private address is discarded. If the peer
  address is unavailable, the response is discarded (fail closed).
- **Sandbox.** Chromium runs with its OS sandbox by default. An operator
  can set `WEB_TOOL_NO_SANDBOX=1` only for systems where the sandbox
  cannot start; the tool prints a warning. Prefer a network namespace or
  firewall around the browser for hostile content.

The rule is the same in the harness and in the standalone command, and a
refused target exits with a one-line reason rather than a traceback.

Run CLI regression tests with:
`uv run --project web_tool python -m unittest discover -s web_tool/tests`.

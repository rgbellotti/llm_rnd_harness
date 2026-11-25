"""Web search and reviewed page retrieval.

Fetch safety lives here as well as in the harness. The browser runs with
the user's full network access, so every URL it is about to touch — the
first one, every redirect hop and every subresource — is checked against
the same policy *before* the request is made.

Playwright does not intercept redirect hops: the browser follows a 302
on its own and the route handler never sees the new target. The
redirect chain is therefore followed by hand here, so that a public URL
cannot redirect the browser into private space behind the harness's
back.
"""
import fcntl
import ipaddress
import os
import select
import socket
import sys
from urllib.parse import urljoin, urlsplit

from ddgs import DDGS
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

# Schemes the browser may load over the network.
ALLOWED_SCHEMES = frozenset({"http", "https"})
# Schemes that never leave the page (in-memory).
LOCAL_SCHEMES = frozenset({"data", "blob"})
# Host names that always mean "this machine or this network".
LOCAL_HOST_SUFFIXES = (
    ".localhost",
    ".local",
    ".internal",
    ".home.arpa",
    ".lan",
    ".home",
    ".corp",
    ".localdomain",
)
# Redirect hops allowed per request.
MAX_REDIRECTS = 10
# Status codes that carry a Location header.
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
# How long page.goto waits for DOMContentLoaded. Tests shorten this.
NAVIGATION_TIMEOUT_MS = 30_000
# The document body archived beside the extraction. Same order of
# magnitude as the PDF text cap: enough to compare an extraction
# against the bytes the server sent, bounded so a huge page cannot
# fill the preview.
RAW_BODY_CAP = 256 * 1024
RAW_BODY_PREFIX = "---HARNESS_RAW_BODY "
RAW_BODY_FOOTER = "\n---HARNESS_RAW_BODY_END---\n"
# Failures that are just the page moving on (a navigation replaced it, or
# the browser closed while a request was in flight): nothing to report.
QUIET_FAILURES = (
    "Request context disposed",
    "Target page, context or browser has been closed",
    "net::ERR_ABORTED",
    "Navigation closed",
)


class PolicyError(Exception):
    """A target the harness refuses to fetch."""


def _embedded_ipv4(ip):
    """The IPv4 address embedded in a transition prefix, if any.

    6to4 (2002::/16) carries the IPv4 address in bits 16..47; the NAT64
    well-known prefix (64:ff9b::/96) carries it in the final 32 bits.
    These must be checked against the same policy as a direct IPv4
    target, otherwise a private IPv4 address can be reached through a
    transition address.
    """
    if ip.version != 6:
        return None
    if ip in ipaddress.ip_network("2002::/16"):
        return ipaddress.IPv4Address((int(ip) >> 80) & 0xFFFFFFFF)
    if ip in ipaddress.ip_network("64:ff9b::/96"):
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return None


def _forbidden_address(address: str) -> bool:
    """True when `address` is not a globally routable address.

    Loopback, private, link-local, carrier-grade NAT (which hosts cloud
    metadata endpoints such as 100.100.100.200) and the other
    special-purpose ranges are all refused.
    """
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return True
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        else:
            embedded = _embedded_ipv4(ip)
            if embedded is not None and _forbidden_address(str(embedded)):
                return True
            # Deprecated site-local space is not globally routable.
            if ip in ipaddress.ip_network("fec0::/10"):
                return True
    return (
        ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
        or ip.is_reserved
        or ip.is_private
        or not ip.is_global
    )


def _local_hostname(host: str) -> bool:
    lowered = host.lower().rstrip(".")
    return lowered == "localhost" or lowered.endswith(LOCAL_HOST_SUFFIXES)


def _resolve(host: str, port: int) -> list[str]:
    """Every address `host` resolves to. Numeric host forms
    (`2130706433`) are resolved here too, so they cannot slip past."""
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise PolicyError(f"could not resolve {host!r}: {exc}") from exc
    return [info[4][0] for info in infos]


def check_url(url: str) -> None:
    """Raise `PolicyError` unless `url` may be fetched.

    The same rules the harness applies before it runs the tool: HTTP(S)
    only, no embedded credentials, no local/internal host names, and no
    address in loopback, private, link-local or multicast space — for
    the literal address and for every address the name resolves to.
    """
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port
    except ValueError as exc:
        raise PolicyError(f"malformed url: {exc}") from exc
    scheme = parts.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise PolicyError(f"refusing to fetch a non-HTTP(S) url: {url}")
    if any(ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in url):
        raise PolicyError(f"refusing to fetch a url containing whitespace or control characters: {url}")
    if parts.username or parts.password:
        raise PolicyError("refusing to fetch a url with embedded credentials")
    if not host:
        raise PolicyError(f"refusing to fetch a url without a host: {url}")
    if _local_hostname(host):
        raise PolicyError(f"refusing to fetch the local/internal host {host!r}")
    port = port or (443 if scheme == "https" else 80)
    for address in _resolve(host, port):
        if _forbidden_address(address):
            raise PolicyError(
                f"refusing to fetch {host!r}: it resolves to a forbidden address ({address})"
            )


def fetch_url_guard(url: str) -> None:
    """Belt-and-braces alongside the harness's URL checks: the standalone
    CLI (not just harness invocations) must not become a file:// or other
    scheme reader, nor reach into private space."""
    check_url(url)


def _peer_address(response) -> str | None:
    """The address the connection actually went to, if it is known."""
    try:
        address = response.server_addr()
    except Exception:
        return None
    if not address:
        return None
    return address.get("ipAddress")


def _check_peer(response, url: str) -> None:
    """Refuse a response that came from private space.

    The URL check resolves the name itself and the request resolves it
    again a moment later; a name that answers differently the second
    time (DNS rebinding) would otherwise slip a request into the local
    network. The peer address of the finished connection is the
    ground truth, so it is checked here: a response that landed on a
    private address is discarded instead of being returned.
    """
    peer = _peer_address(response)
    if not peer:
        # The peer address is the only ground truth after DNS resolution.
        # If it cannot be read, fail closed rather than trust the name.
        raise PolicyError(
            f"could not verify the address actually used for {url!r}; "
            "the response is discarded"
        )
    if _forbidden_address(peer):
        raise PolicyError(
            f"the request to {url!r} landed on a private address ({peer}); "
            "the response is discarded"
        )


def _scheme_change_allowed(current: str, target: str) -> bool:
    """True for a same-scheme hop, and for an http → https upgrade.

    Any other scheme change is refused. The target is still checked
    with `check_url` before it is requested.
    """
    try:
        current_scheme = urlsplit(current).scheme.lower()
        target_scheme = urlsplit(target).scheme.lower()
    except ValueError:
        return False
    if target_scheme == current_scheme:
        return True
    return current_scheme == "http" and target_scheme == "https"


def _cap_document_body(raw: bytes) -> tuple[bytes, bool]:
    """Return the archived prefix and whether it was cut at the cap."""
    if len(raw) > RAW_BODY_CAP:
        return raw[:RAW_BODY_CAP], True
    return raw, False


def _write_stderr_all(text: str) -> None:
    """Write `text` to stderr when the stream cannot accept it in one call.

    Playwright's asyncio loop leaves stderr non-blocking. A document body
    larger than the pipe buffer then raises BlockingIOError from a single
    write, and that exception becomes the fetch's exit code after the page
    text has already been printed. This writes the whole string, waiting
    while the harness reads the pipe.
    """
    stream = sys.stderr
    try:
        fd = stream.fileno()
    except (AttributeError, OSError, ValueError):
        stream.write(text)
        stream.flush()
        return
    flags = None
    try:
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        if flags & os.O_NONBLOCK:
            fcntl.fcntl(fd, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)
    except OSError:
        flags = None
    try:
        try:
            stream.flush()
        except BlockingIOError:
            pass
        view = memoryview(text.encode("utf-8"))
        while view:
            try:
                written = os.write(fd, view)
            except BlockingIOError:
                written = 0
            except InterruptedError:
                continue
            if written:
                view = view[written:]
                continue
            _, writable, _ = select.select([], [fd], [], 30)
            if not writable:
                raise OSError(
                    "could not write the archived document; the capture pipe stayed full"
                )
    finally:
        if flags is not None and flags & os.O_NONBLOCK:
            try:
                fcntl.fcntl(fd, fcntl.F_SETFL, flags)
            except OSError:
                pass


def _emit_raw_body(raw: bytes, truncated: bool) -> None:
    """Print a length-prefixed copy of the document body on stderr.

    The harness splits this block out of the captured stderr and stores
    it beside the DOM extraction. The byte count is the UTF-8 length of
    the payload, so a payload that itself contains the footer is still
    one slice. `truncated` is true when `raw` is already the capped prefix.
    """
    text = raw.decode("utf-8", errors="replace")
    if truncated:
        text += "\n…[raw body truncated at 256 KiB]"
    payload = text.encode("utf-8")
    frame = (
        f"{RAW_BODY_PREFIX}bytes={len(payload)} truncated={int(truncated)}---\n"
        + text
        + RAW_BODY_FOOTER
    )
    _write_stderr_all(frame)


def _is_main_document(request) -> bool:
    """True for the navigation that produced the page being extracted.

    Subframe documents are fetched under the same policy, and their
    bodies are not the page the reviewer is looking at.
    """
    if getattr(request, "resource_type", None) != "document":
        return False
    frame = getattr(request, "frame", None)
    if frame is None:
        return True
    return getattr(frame, "parent_frame", None) is None


def _follow(route, request, url: str, hops: int = 0):
    """Fetch `url` following redirects by hand, checking every hop.

    Playwright never routes a redirect hop, so the browser would follow
    a 302 into private space without the handler seeing it. Following
    the chain here keeps every hop inside the policy. Returns the final
    response and the URL it came from.
    """
    if hops > MAX_REDIRECTS:
        raise PolicyError(f"too many redirects while fetching {url!r}")
    check_url(url)
    response = route.fetch(url=url, max_redirects=0)
    _check_peer(response, url)
    if response.status in REDIRECT_STATUSES:
        location = response.headers.get("location")
        if not location:
            return response, url
        target = urljoin(url, location)
        if not _scheme_change_allowed(url, target):
            raise PolicyError(f"refusing a redirect that changes the scheme: {target}")
        return _follow(route, request, target, hops + 1)
    return response, url


class _RouteGuard:
    """Route handler that keeps every request inside the policy."""

    def __init__(self) -> None:
        # The URL the document actually came from (after redirects).
        self.final_url: str | None = None
        # Capped main-document body (bytes, already-truncated?) kept so
        # the extraction can be compared with what the server sent.
        self.raw_document: tuple[bytes, bool] | None = None

    def __call__(self, route, request) -> None:
        url = request.url
        try:
            scheme = urlsplit(url).scheme.lower()
        except ValueError:
            route.abort("blockedbyclient")
            return
        if scheme in LOCAL_SCHEMES:
            # In-memory only; it never touches the network.
            route.continue_()
            return
        if scheme not in ALLOWED_SCHEMES:
            route.abort("blockedbyclient")
            return
        # Images/fonts/media are never used by the text extraction below,
        # and skipping them speeds up loads and avoids stalls on heavy
        # pages.
        if request.resource_type in {"image", "font", "media"}:
            route.abort()
            return
        try:
            response, final_url = _follow(route, request, url)
        except PolicyError as exc:
            print(f"refused request: {exc}", file=sys.stderr)
            route.abort("blockedbyclient")
            return
        except Exception as exc:  # network failure, aborted, …
            if not any(quiet in str(exc) for quiet in QUIET_FAILURES):
                print(f"request failed: {exc}", file=sys.stderr)
            route.abort("failed")
            return
        if _is_main_document(request):
            self.final_url = final_url
            try:
                # Read the body before fulfill. Passing the same bytes
                # back in keeps the page working after the read.
                full = response.body()
            except Exception as exc:
                print(f"could not read response body: {exc}", file=sys.stderr)
                route.fulfill(response=response)
                return
            self.raw_document = _cap_document_body(full)
            route.fulfill(response=response, body=full)
            return
        route.fulfill(response=response)


def _block_websocket(web_socket) -> None:
    """Refuse every page-created WebSocket.

    Playwright's request routing does not see WebSocket connections, so a
    public page could otherwise open `ws://127.0.0.1:...` and bypass the
    HTTP policy entirely. Text extraction does not need WebSockets. A
    routed WebSocket does not connect to the server unless the handler
    calls `connect_to_server()`; simply returning keeps the socket mocked
    and off the network. (Calling `close()` from this handler deadlocks
    the pinned Playwright version, so it is deliberately not used.)
    """
    print(
        f"refused websocket: {getattr(web_socket, 'url', '<unknown>')}",
        file=sys.stderr,
    )


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Search the web or extract annotated page text")
    modes = parser.add_subparsers(dest="mode", required=True)
    search = modes.add_parser("search")
    search.add_argument("query")
    search.add_argument("max_results", type=int, nargs="?", default=5)
    fetch = modes.add_parser("fetch")
    fetch.add_argument("url")
    args = parser.parse_args()

    if args.mode == "search":
        if not 1 <= args.max_results <= 20:
            parser.error("max_results must be between 1 and 20")
        # A network or library failure exits as one clean line, the same
        # contract the fetch path offers, instead of a traceback. The
        # harness turns a non-zero exit into the review dialog's error
        # text either way; a readable sentence beats stack noise.
        try:
            results = DDGS().text(args.query, max_results=args.max_results)
        except Exception as exc:
            print(f"web search failed: {exc}", file=sys.stderr)
            raise SystemExit(1) from None
        for r in results:
            print("URL:", r["href"])
            print("Title:", r["title"])
            print("Summary:", r["body"], "\n")
    else:
        url = args.url
        try:
            fetch_url_guard(url)
        except PolicyError as exc:
            print(f"refusing to fetch: {exc}", file=sys.stderr)
            raise SystemExit(2) from None

        # Chromium's OS sandbox is on by default. An operator can opt out
        # only explicitly for a system where user namespaces are
        # unavailable; the warning makes that choice visible.
        sandbox = os.environ.get("WEB_TOOL_NO_SANDBOX") != "1"
        if not sandbox:
            print(
                "WARNING: WEB_TOOL_NO_SANDBOX=1 — Chromium is running without its OS sandbox",
                file=sys.stderr,
            )
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                chromium_sandbox=sandbox,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    # Never inherit a system proxy: the peer-address check
                    # assumes the connection went directly to the target.
                    "--no-proxy-server",
                    # WebTransport is outside page.route; it is not needed
                    # for text extraction. WebRTC is likewise not needed
                    # and has non-HTTP network channels.
                    "--disable-features=WebTransport",
                    "--disable-webrtc",
                ],
            )
            # context.route covers popups/new pages in the context, unlike
            # page.route. Service workers are blocked because Playwright's
            # request interception does not see their requests.
            context = browser.new_context(
                service_workers="block",
                accept_downloads=False,
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
                ),
            )
            # Belt-and-braces for channels that are easy to miss at the
            # request-routing layer (WebSocket is also routed above; workers
            # are not needed for text extraction).
            context.add_init_script(
                """
                (() => {
                  for (const name of ['Worker', 'SharedWorker', 'WebSocket',
                                      'WebTransport', 'RTCPeerConnection']) {
                    try {
                      Object.defineProperty(window, name, {
                        configurable: false,
                        writable: false,
                        value: function () {
                          throw new Error('blocked by harness fetch policy');
                        },
                      });
                    } catch (e) {}
                  }
                })();
                """
            )
            page = context.new_page()
            guard = _RouteGuard()
            context.route("**/*", guard)
            context.route_web_socket("**/*", _block_websocket)

            # `networkidle` is unreliable on modern sites (analytics beacons,
            # chat widgets, and WebSockets keep the network busy indefinitely),
            # so wait for the DOM only. If that wait times out and a body is
            # already present, keep the text and mark the load partial.
            partial = False
            try:
                page.goto(
                    url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS
                )
            except PlaywrightTimeoutError:
                partial = True
                if not page.locator("body").count():
                    raise
            except Exception as exc:
                # The policy refused something on the page (the reason was
                # printed above) or the navigation failed: report it
                # instead of a traceback.
                print(f"fetch failed: {exc}", file=sys.stderr)
                browser.close()
                raise SystemExit(1) from None

            # The document may have been redirected; link targets are
            # resolved against the URL the content actually came from.
            effective_url = guard.final_url or page.url or url

            annotated_text = page.evaluate("""(baseUrl) => {
    const blockTags = new Set([
        'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'li', 'tr', 'td', 'th', 'blockquote', 'section',
        'article', 'header', 'footer', 'nav', 'ul', 'ol',
        'table', 'pre', 'dl', 'dt', 'dd', 'figure', 'figcaption',
        'main', 'aside', 'form', 'fieldset'
    ]);

    const skipTags = new Set([
        'script', 'style', 'noscript', 'template'
    ]);

    function resolveHref(raw) {
        if (!baseUrl) return raw;
        try {
            return new URL(raw, baseUrl).href;
        } catch (e) {
            return raw;
        }
    }

    function extract(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        const tag = node.tagName.toLowerCase();

        if (skipTags.has(tag)) {
            return '';
        }

        if (tag === 'br') {
            return '\\n';
        }

        if (tag === 'a' && node.hasAttribute('href')) {
            // Relative links resolve against the effective URL, not the
            // one the browser was asked for.
            const href = resolveHref(node.getAttribute('href'));
            const desc = (node.innerText || node.textContent || '')
                .replace(/\\s+/g, ' ')
                .trim();

            // † text·( url ) when the anchor has visible text. A space
            // separates the dagger from the words, and the middle dot
            // sits against the opening parenthesis. †( url ) when the
            // anchor has no visible text. Spaces sit only around the
            // URL, which cannot contain spaces, so a parenthesis inside
            // the URL stays inside the URL. The closing " )" ends the link.
            if (desc) return `† ${desc}·( ${href} )`;
            return `†( ${href} )`;
        }

        let inner = '';
        for (const child of node.childNodes) {
            inner += extract(child);
        }

        if (blockTags.has(tag)) {
            const trimmed = inner.trim();
            return trimmed ? '\\n' + trimmed + '\\n' : '';
        }

        return inner;
    }

    return extract(document.body)
        .replace(/[ \\t]+\\n/g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
}""", effective_url)                          
            print("URL:", effective_url)
            print(
                "Source: document.body after JavaScript, captured at DOMContentLoaded. "
                "This is rendered DOM text, not the HTTP response body."
            )
            if partial:
                print(
                    "Load: partial — navigation timed out before DOMContentLoaded. "
                    "The text below is the document.body that existed at the timeout."
                )
            else:
                print("Load: DOMContentLoaded")
            print("Content:\n", annotated_text)
            if guard.raw_document is not None:
                _emit_raw_body(*guard.raw_document)
            browser.close()

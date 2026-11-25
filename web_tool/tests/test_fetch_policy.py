"""Fetch safety: the URL policy and the redirect chain.

The browser runs with the user's full network access, so the policy has
to hold for the first URL, for every redirect hop and for every
subresource. These tests cover the parts that do not need the public
internet: the literal/local targets, a redirect chain that points at a
refused address, and the ordinary page extraction path.
"""
import contextlib
import fcntl
import io
import os
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

import web_tool


class _QuietHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass


def _serve(handler):
    server = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class UrlPolicyTest(unittest.TestCase):
    def test_refuses_non_http_schemes_and_malformed_urls(self):
        for url in [
            "file:///etc/passwd",
            "ftp://example.com/x",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "http://",
            "https://exa mple.com/x",
            "https://example.com/\x1b[31m",
        ]:
            with self.assertRaises(web_tool.PolicyError, msg=url):
                web_tool.check_url(url)

    def test_refuses_embedded_credentials(self):
        with self.assertRaises(web_tool.PolicyError):
            web_tool.check_url("https://user:pass@example.com/x")

    def test_refuses_loopback_and_private_literals(self):
        for url in [
            "http://127.0.0.1/page",
            "http://127.0.0.2/page",
            "http://[::1]/page",
            "http://10.0.0.8/page",
            "http://192.168.1.4/",
            "http://172.16.5.5/",
            "http://169.254.169.254/latest/meta-data",
            "http://0.0.0.0/",
            "http://100.100.100.200/",
            "http://192.0.0.192/",
            "http://198.18.0.1/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:169.254.169.254]/",
            "http://[2002:7f00:1::]/",
            "http://[64:ff9b::7f00:1]/",
        ]:
            with self.assertRaises(web_tool.PolicyError, msg=url):
                web_tool.check_url(url)

    def test_refuses_local_host_names(self):
        for url in [
            "http://localhost/x",
            "http://intranet.localhost/x",
            "https://mesh.local/x",
            "http://service.internal/x",
            "http://box.home.arpa/x",
        ]:
            with self.assertRaises(web_tool.PolicyError, msg=url):
                web_tool.check_url(url)

    def test_refuses_a_name_that_resolves_into_private_space(self):
        # The name itself looks public; the address it resolves to does not.
        with patch.object(web_tool, "_resolve", return_value=["169.254.169.254"]):
            with self.assertRaises(web_tool.PolicyError):
                web_tool.check_url("https://public-looking.example/page")

    def test_allows_a_public_address(self):
        with patch.object(web_tool, "_resolve", return_value=["93.184.216.34"]):
            web_tool.check_url("https://public-looking.example/page")

    def test_numeric_host_forms_resolve_to_the_real_address(self):
        # Chromium and getaddrinfo read "2130706433" as 127.0.0.1.
        with patch.object(web_tool, "_resolve", wraps=web_tool._resolve) as resolve:
            with self.assertRaises(web_tool.PolicyError):
                web_tool.check_url("http://2130706433/x")
            resolve.assert_called()

    def test_websocket_route_is_mocked_and_never_connects(self):
        # A routed WebSocket only reaches a server if the handler calls
        # connect_to_server(); this handler deliberately does not.
        class Socket:
            url = "ws://127.0.0.1:11434/private"

            def close(self, **kwargs):
                raise AssertionError("the blocking handler must not call close")

        web_tool._block_websocket(Socket())


class WebSocketTest(unittest.TestCase):
    """WebSockets are invisible to Playwright request routing and must not
    become an SSRF channel."""

    def test_a_page_websocket_never_reaches_the_target(self):
        hits = []

        class Target(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(404)
                self.end_headers()

            def log_message(self, *args):
                pass

        target_server = _serve(Target)
        try:
            target_port = target_server.server_address[1]

            class Page(BaseHTTPRequestHandler):
                def do_GET(self):
                    body = (
                        "<html><body><p>hi</p><script>"
                        f"new WebSocket('ws://127.0.0.1:{target_port}/secret');"
                        "</script></body></html>"
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, *args):
                    pass

            page_server = _serve(Page)
            try:
                page_port = page_server.server_address[1]

                def fake_check(url):
                    if f":{page_port}" in url:
                        return
                    raise web_tool.PolicyError(f"refusing {url}")

                output = io.StringIO()
                errors = io.StringIO()
                url = f"http://127.0.0.1:{page_port}/page"
                with patch.object(web_tool, "check_url", fake_check), \
                     patch.object(web_tool, "fetch_url_guard", lambda u: None), \
                     patch.object(web_tool, "_check_peer", lambda response, u: None), \
                     patch('sys.argv', ['web-tool', 'fetch', url]):
                    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                        with contextlib.suppress(BaseException):
                            web_tool.main()
                self.assertEqual(hits, [], "the page WebSocket reached the target")
            finally:
                page_server.shutdown()
        finally:
            target_server.shutdown()


class RedirectChainTest(unittest.TestCase):
    """A public URL must not be able to redirect the browser into
    private space behind the harness's back."""

    def test_a_refused_redirect_target_is_never_requested(self):
        hits = []

        class Redirect(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{self.server.target_port}/secret")
                self.end_headers()

            def log_message(self, *args):
                pass

        class Target(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                body = b"<html><body>secret</body></html>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        redirect_server = _serve(Redirect)
        target_server = _serve(Target)
        redirect_server.target_port = target_server.server_address[1]
        try:
            # The first hop is allowed, the redirect target is not.
            def fake_check(url):
                if f":{redirect_server.server_address[1]}" in url:
                    return
                raise web_tool.PolicyError(f"refusing {url}")

            output = io.StringIO()
            errors = io.StringIO()
            with patch.object(web_tool, "check_url", fake_check), \
                 patch.object(web_tool, "fetch_url_guard", lambda url: None), \
                 patch.object(web_tool, "_check_peer", lambda response, url: None), \
                 patch('sys.argv', ['web-tool', 'fetch', f'http://127.0.0.1:{redirect_server.server_address[1]}/start']):
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    with contextlib.suppress(BaseException):
                        web_tool.main()
            # The private target was never requested.
            self.assertEqual(hits, [])
            self.assertIn("refused request", errors.getvalue())
        finally:
            redirect_server.shutdown()
            target_server.shutdown()


class SubresourceTest(unittest.TestCase):
    """A page must not be able to reach into private space from its own
    scripts either."""

    def test_a_script_cannot_reach_a_refused_address(self):
        hits = []

        class Target(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                body = b"secret"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        target_server = _serve(Target)
        target_port = target_server.server_address[1]

        class Page(BaseHTTPRequestHandler):
            def do_GET(self):
                body = (
                    "<html><body><p>hi</p><script>"
                    f"fetch('http://127.0.0.1:{target_port}/secret').catch(() => {{}});"
                    "</script></body></html>"
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        page_server = _serve(Page)
        try:
            page_port = page_server.server_address[1]

            def fake_check(url):
                if f":{page_port}" in url:
                    return
                raise web_tool.PolicyError(f"refusing {url}")

            output = io.StringIO()
            errors = io.StringIO()
            url = f"http://127.0.0.1:{page_port}/page"
            with patch.object(web_tool, "check_url", fake_check), \
                 patch.object(web_tool, "fetch_url_guard", lambda url: None), \
                 patch.object(web_tool, "_check_peer", lambda response, url: None), \
                 patch('sys.argv', ['web-tool', 'fetch', url]):
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    with contextlib.suppress(BaseException):
                        web_tool.main()
            # The script's request to the internal address never landed.
            self.assertEqual(hits, [])
            self.assertIn("refused request", errors.getvalue())
        finally:
            page_server.shutdown()
            target_server.shutdown()


class RebindingTest(unittest.TestCase):
    """The URL check resolves the name itself; the request resolves it
    again a moment later. A name that answers differently the second
    time must not get a response back."""

    def test_a_response_from_a_private_address_is_discarded(self):
        class Page(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b"<html><body><p>internal secret</p></body></html>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = _serve(Page)
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/page"
            output = io.StringIO()
            errors = io.StringIO()
            # The pre-flight check is defeated (as it would be by a name
            # that resolves differently for the request): the connection
            # itself is the ground truth. The peer check is NOT patched
            # here — it is what has to catch this.
            with patch.object(web_tool, "check_url", lambda url: None), \
                 patch.object(web_tool, "fetch_url_guard", lambda url: None), \
                 patch('sys.argv', ['web-tool', 'fetch', url]):
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    with contextlib.suppress(BaseException):
                        web_tool.main()
            # The content of the private address never came back.
            self.assertNotIn("internal secret", output.getvalue())
            self.assertIn("private address", errors.getvalue())
        finally:
            server.shutdown()


class ExtractionTest(unittest.TestCase):
    """The ordinary path still works: the page is rendered, the text is
    extracted and links are annotated."""

    def test_page_text_and_links_are_extracted(self):
        class Page(BaseHTTPRequestHandler):
            def do_GET(self):
                body = (
                    b"<html><body><h1>Title</h1><p>Hello world</p>"
                    b"<script>secret-script-token</script>"
                    b"<a href='/relative'>link text</a>"
                    b"<a href='/a(b)'>paren</a>"
                    b"<a href='/bare'></a></body></html>"
                )
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = _serve(Page)
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/page"
            output = io.StringIO()
            errors = io.StringIO()
            with patch.object(web_tool, "check_url", lambda url: None), \
                 patch.object(web_tool, "fetch_url_guard", lambda url: None), \
                 patch.object(web_tool, "_check_peer", lambda response, url: None), \
                 patch('sys.argv', ['web-tool', 'fetch', url]):
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    web_tool.main()
            text = output.getvalue()
            archive = errors.getvalue()
            self.assertIn("Hello world", text)
            self.assertIn("Title", text)
            base = url.rsplit("/", 1)[0]
            self.assertIn(f"† link text·( {base}/relative )", text)
            self.assertIn(f"† paren·( {base}/a(b) )", text)
            self.assertIn(f"†( {base}/bare )", text)
            self.assertNotIn("‡", text)
            self.assertNotIn("(no link text)", text)
            self.assertNotIn("[link]", text)
            self.assertIn(url, text)
            self.assertIn("Source: document.body after JavaScript", text)
            self.assertIn("rendered DOM text, not the HTTP response body", text)
            self.assertIn("Load: DOMContentLoaded", text)
            self.assertNotIn("secret-script-token", text)
            self.assertIn("secret-script-token", archive)
            self.assertIn("---HARNESS_RAW_BODY ", archive)
            self.assertIn("---HARNESS_RAW_BODY_END---", archive)
            framed = archive[archive.find("---HARNESS_RAW_BODY "):]
            header, rest = framed.split("\n", 1)
            nbytes = int(header.split("bytes=")[1].split()[0])
            self.assertIn("secret-script-token", rest[:nbytes])
            self.assertTrue(rest[nbytes:].startswith("\n---HARNESS_RAW_BODY_END---"))
        finally:
            server.shutdown()


class _RedirectResponse:
    def __init__(self, status, location=None):
        self.status = status
        self.headers = {}
        if location is not None:
            self.headers["location"] = location


class _RedirectRoute:
    def __init__(self, responses):
        self._responses = list(responses)
        self.fetched = []

    def fetch(self, url, max_redirects=0):
        self.fetched.append(url)
        if not self._responses:
            raise AssertionError(f"unexpected fetch of {url}")
        return self._responses.pop(0)


class SchemeRedirectTest(unittest.TestCase):
    """Same-scheme hops and http → https are followed. Downgrades and
    other scheme changes are refused before the target is requested."""

    def test_scheme_helper_allows_upgrades_only(self):
        self.assertTrue(web_tool._scheme_change_allowed(
            "http://example.com/a", "https://example.com/b"))
        self.assertTrue(web_tool._scheme_change_allowed(
            "https://example.com/a", "https://cdn.example/b"))
        self.assertTrue(web_tool._scheme_change_allowed(
            "http://example.com/a", "http://example.com/b"))
        self.assertFalse(web_tool._scheme_change_allowed(
            "https://example.com/a", "http://example.com/b"))
        self.assertFalse(web_tool._scheme_change_allowed(
            "http://example.com/a", "file:///etc/passwd"))

    def test_http_to_https_is_requested(self):
        route = _RedirectRoute([
            _RedirectResponse(301, "https://example.com/page"),
            _RedirectResponse(200),
        ])
        with patch.object(web_tool, "check_url", lambda url: None), \
             patch.object(web_tool, "_check_peer", lambda response, url: None):
            response, final = web_tool._follow(route, None, "http://example.com/start")
        self.assertEqual(response.status, 200)
        self.assertEqual(final, "https://example.com/page")
        self.assertEqual(
            route.fetched,
            ["http://example.com/start", "https://example.com/page"],
        )

    def test_https_to_http_is_refused_before_the_target_is_fetched(self):
        route = _RedirectRoute([
            _RedirectResponse(301, "http://example.com/page"),
            _RedirectResponse(200),
        ])
        with patch.object(web_tool, "check_url", lambda url: None), \
             patch.object(web_tool, "_check_peer", lambda response, url: None):
            with self.assertRaises(web_tool.PolicyError) as caught:
                web_tool._follow(route, None, "https://example.com/start")
        self.assertIn("changes the scheme", str(caught.exception))
        self.assertEqual(route.fetched, ["https://example.com/start"])

    def test_http_to_file_is_refused_before_the_target_is_fetched(self):
        route = _RedirectRoute([_RedirectResponse(302, "file:///etc/passwd")])
        with patch.object(web_tool, "check_url", lambda url: None), \
             patch.object(web_tool, "_check_peer", lambda response, url: None):
            with self.assertRaises(web_tool.PolicyError) as caught:
                web_tool._follow(route, None, "http://example.com/start")
        self.assertIn("changes the scheme", str(caught.exception))
        self.assertEqual(route.fetched, ["http://example.com/start"])

    def test_an_upgrade_into_a_private_host_is_still_refused(self):
        route = _RedirectRoute([_RedirectResponse(301, "https://127.0.0.1/secret")])
        with patch.object(web_tool, "_check_peer", lambda response, url: None):
            with self.assertRaises(web_tool.PolicyError):
                web_tool._follow(route, None, "http://93.184.216.34/start")
        self.assertEqual(route.fetched, ["http://93.184.216.34/start"])


class ArchiveFramingTest(unittest.TestCase):
    def test_byte_count_keeps_a_payload_that_contains_the_footer(self):
        raw = b"hello\n---HARNESS_RAW_BODY_END---\nstill"
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            web_tool._emit_raw_body(raw, False)
        framed = buf.getvalue()
        header, rest = framed.split("\n", 1)
        self.assertIn("truncated=0", header)
        nbytes = int(header.split("bytes=")[1].split()[0])
        self.assertEqual(rest[:nbytes], raw.decode())
        self.assertTrue(rest[nbytes:].startswith("\n---HARNESS_RAW_BODY_END---"))

    def test_cap_marks_a_body_past_256_kib(self):
        raw = b"x" * (web_tool.RAW_BODY_CAP + 50)
        capped, truncated = web_tool._cap_document_body(raw)
        self.assertTrue(truncated)
        self.assertEqual(len(capped), web_tool.RAW_BODY_CAP)
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            web_tool._emit_raw_body(capped, truncated)
        framed = buf.getvalue()
        self.assertIn("truncated=1", framed)
        self.assertIn("raw body truncated at 256 KiB", framed)
        self.assertNotIn("x" * (web_tool.RAW_BODY_CAP + 1), framed)

    def test_a_nonblocking_stderr_still_frames_a_body_larger_than_the_pipe(self):
        read_fd, write_fd = os.pipe()
        stream = None
        thread = None
        collected = bytearray()
        try:
            try:
                fcntl.fcntl(read_fd, fcntl.F_SETPIPE_SZ, 4096)
            except OSError:
                pass
            flags = fcntl.fcntl(write_fd, fcntl.F_GETFL)
            fcntl.fcntl(write_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

            def drain():
                while True:
                    chunk = os.read(read_fd, 65536)
                    if not chunk:
                        return
                    collected.extend(chunk)

            thread = threading.Thread(target=drain, daemon=True)
            thread.start()
            stream = os.fdopen(write_fd, "w", encoding="utf-8", closefd=True)
            write_fd = -1
            payload = b"z" * (64 * 1024)
            with contextlib.redirect_stderr(stream):
                web_tool._emit_raw_body(payload, False)
                after = fcntl.fcntl(stream.fileno(), fcntl.F_GETFL)
            self.assertTrue(after & os.O_NONBLOCK)
        finally:
            if stream is not None:
                stream.close()
            elif write_fd >= 0:
                os.close(write_fd)
            if thread is not None:
                thread.join(timeout=5)
            os.close(read_fd)
        self.assertIsNotNone(thread)
        self.assertFalse(thread.is_alive())
        text = collected.decode()
        self.assertIn("truncated=0", text)
        self.assertEqual(text.count("z"), 64 * 1024)
        self.assertTrue(text.rstrip().endswith("---HARNESS_RAW_BODY_END---"))


class PartialLoadTest(unittest.TestCase):
    """A parser-blocking script that never finishes leaves a body on the
    page. The reviewer-facing text has to say the load is partial."""

    def test_a_timed_out_navigation_is_marked_partial(self):
        class Page(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.startswith("/slow.js"):
                    time.sleep(2)
                    try:
                        body = b""
                        self.send_response(200)
                        self.send_header("Content-Type", "application/javascript")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        self.wfile.write(body)
                    except Exception:
                        pass
                    return
                body = (
                    b"<html><body><p>partial hello</p>"
                    b"<!-- raw-marker-token -->"
                    b"<script src='/slow.js'></script></body></html>"
                )
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = _serve(Page)
        original_timeout = web_tool.NAVIGATION_TIMEOUT_MS
        web_tool.NAVIGATION_TIMEOUT_MS = 400
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/page"
            output = io.StringIO()
            errors = io.StringIO()
            with patch.object(web_tool, "check_url", lambda url: None), \
                 patch.object(web_tool, "fetch_url_guard", lambda url: None), \
                 patch.object(web_tool, "_check_peer", lambda response, url: None), \
                 patch("sys.argv", ["web-tool", "fetch", url]):
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    web_tool.main()
            text = output.getvalue()
            self.assertIn("partial hello", text)
            self.assertIn(
                "Load: partial — navigation timed out before DOMContentLoaded.",
                text,
            )
            self.assertIn("raw-marker-token", errors.getvalue())
            self.assertNotIn("raw-marker-token", text)
        finally:
            web_tool.NAVIGATION_TIMEOUT_MS = original_timeout
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()

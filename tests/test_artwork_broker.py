#!/usr/bin/env python3
"""Contract tests for the artwork broker (marketplace issue #2567).

Run with the project interpreter (Arch ``python-pillow`` installed):

    /usr/bin/python3 -I -B tests/test_artwork_broker.py
    /usr/bin/python3 -I -B -m unittest discover -s tests -p 'test_artwork_broker.py'

No external network is ever touched: DNS is faked with ``FakeResolver``,
HTTPS with ``FakeConnector``/``FakeConnection``/``FakeResponse``, and the
spool lives in per-test temporary directories.  Pillow is used only to
build image fixtures and to inspect broker output.

The tests pin the broker contract:
  * one-shot stdio protocol, strict request schema, bounded output that
    never echoes the requested URL;
  * URL normalization (https-only, no userinfo/fragment/zone-ID, port 443,
    byte-length bounds);
  * global-only destination vetting — private, loopback, link-local,
    CGNAT, multicast, unspecified, reserved, documentation, IPv4-mapped
    IPv6, and NAT64 64:ff9b::/96 addresses are all rejected, and a single
    non-global answer poisons the whole DNS answer set (DNS rebinding);
  * connections dial a vetted numeric IP while the hostname is kept for
    SNI, the Host header, and certificate validation — redirects are
    never auto-followed;
  * every redirect hop is re-resolved and re-vetted; loops, over-limit
    chains, downgrades and non-443 redirects are rejected;
  * 200 + identity encoding + image/png|image/jpeg only, the sniffed
    Pillow format must match the served content type, body capped at
    2 MiB with exact MAX+1 detection, 10 s total deadline and 3 s
    per-op slice;
  * Pillow decode rejects animation, malformed data and oversized images,
    EXIF-transposes, thumbnails to <=512, and emits a deterministic,
    metadata-free canonical PNG;
  * the spool is symlink-resistant (root and every ancestor), 0700/0600,
    content-addressed with verified cache reuse, atomic (no partial files
    survive a failed publish), and evicts oldest-first under the
    16-file / 16-MiB caps.
"""

import hashlib
import io
import json
import os
import pathlib
import shutil
import socket
import ssl
import stat
import struct
import sys
import tempfile
import unittest
from unittest import mock

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import artwork_broker as ab  # noqa: E402  (needs repo root on sys.path)

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
PUBLIC_IP = "93.184.216.34"
PUBLIC_IP_2 = "93.184.216.35"
PUBLIC_IP_3 = "93.184.216.36"
PUBLIC_V6 = "2606:4700::1111"
SECRET_TOKEN = "secret-token-123"


# ---------------------------------------------------------------------------
# error-assertion helper
# ---------------------------------------------------------------------------

def expect_error(test, codes, fn, *args, **kwargs):
    """Call ``fn``; require BrokerError with one of ``codes``; return it."""
    if isinstance(codes, str):
        codes = {codes}
    else:
        codes = set(codes)
    try:
        result = fn(*args, **kwargs)
    except ab.BrokerError as exc:
        test.assertIn(
            exc.code,
            codes,
            "BrokerError code %r (%r), expected one of %s"
            % (exc.code, exc.message, sorted(codes)),
        )
        return exc
    except Exception as exc:  # noqa: BLE001 - surfaced as test failure
        test.fail(
            "expected BrokerError in %s, got %s: %r"
            % (sorted(codes), type(exc).__name__, exc)
        )
    test.fail(
        "expected BrokerError in %s, but the call succeeded: %r"
        % (sorted(codes), result)
    )

def _flaky_link(raise_times=1):
    """``os.link`` stand-in that raises FileExistsError the first N times,
    then delegates to the real ``os.link`` — simulating a lost create race
    against another publisher."""
    real = os.link
    state = {"raised": 0}

    def link(src, dst, *args, **kwargs):
        if state["raised"] < raise_times:
            state["raised"] += 1
            raise FileExistsError(src, dst)
        return real(src, dst, *args, **kwargs)

    return link



# ---------------------------------------------------------------------------
# fakes: clock, DNS, HTTPS transport
# ---------------------------------------------------------------------------

class FakeClock:
    """Injectable monotonic clock."""

    def __init__(self, start=0.0):
        self.now = float(start)

    def __call__(self):
        return self.now

    def advance(self, dt):
        self.now += float(dt)


class FakeResolver:
    """DNS fake: canned answers per host, records lookup order."""

    def __init__(self, answers):
        self.answers = {h: list(a) for h, a in answers.items()}
        self.calls = []

    def __call__(self, host):
        self.calls.append(host)
        if host not in self.answers:
            raise AssertionError("unexpected DNS lookup for host %r" % host)
        return list(self.answers[host])


class RaisingResolver:
    def __init__(self, exc):
        self.exc = exc
        self.calls = []

    def __call__(self, host):
        self.calls.append(host)
        raise self.exc


class CIMap(dict):
    """Case-insensitive header map."""

    def __init__(self, items=()):
        if hasattr(items, "items"):
            items = items.items()
        super().__init__((str(k).lower(), v) for k, v in items)

    def get(self, key, default=None):
        return super().get(str(key).lower(), default)

    def __getitem__(self, key):
        return super().__getitem__(str(key).lower())

    def __contains__(self, key):
        return super().__contains__(str(key).lower())


class FakeResponse:
    """http.client.HTTPResponse stand-in.

    ``delay_per_read`` advances the shared fake clock on every read call
    and ``getresponse_delay`` when the response arrives, so deadline and
    slice logic can be exercised without sleeping.  Deliberately has no
    ``.sock`` attribute: the broker must tolerate responses without one.
    """

    def __init__(self, status, headers=(), body=b"", clock=None,
                 delay_per_read=0.0, getresponse_delay=0.0):
        self.status = status
        self.code = status
        self.reason = ""
        self.headers = CIMap(headers)
        self._body = bytes(body)
        self._clock = clock
        self.delay_per_read = float(delay_per_read)
        self.getresponse_delay = float(getresponse_delay)
        self.closed = False

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read(self, n=-1):
        if self._clock is not None and self.delay_per_read > 0:
            self._clock.advance(self.delay_per_read)
        if n is None or n < 0:
            data, self._body = self._body, b""
        else:
            data, self._body = self._body[:n], self._body[n:]
        return data

    def close(self):
        self.closed = True


class FakeConnection:
    """Connection returned by FakeConnector: request/getresponse/close."""

    def __init__(self, connector, host, ip, port, timeout, responses, clock):
        self.connector = connector
        self.host = host
        self.ip = ip
        self.port = port
        self.timeout = timeout
        self.responses = list(responses)
        self.clock = clock
        self.requests = []
        self.closed = False

    def connect(self):  # dialing is already simulated by the connector fake
        pass

    def request(self, method, url, *args, **kwargs):
        self.requests.append((method, url, args, kwargs))

    def getresponse(self):
        if not self.responses:
            raise AssertionError(
                "unexpected extra request to host %r" % self.host
            )
        resp = self.responses.pop(0)
        if self.clock is not None and resp.getresponse_delay > 0:
            self.clock.advance(resp.getresponse_delay)
        return resp

    def close(self):
        self.closed = True


class FakeConnector:
    """HTTPS fake: canned responses per host; records pinned dials."""

    def __init__(self, responses, answers=None, clock=None):
        self.responses = {h: list(r) for h, r in responses.items()}
        self.answers = {h: list(a) for h, a in (answers or {}).items()}
        self.clock = clock
        self.calls = []
        self.connections = []

    def __call__(self, host, ip, port, timeout):
        self.calls.append(
            {"host": host, "ip": ip, "port": port, "timeout": timeout}
        )
        if self.answers and host in self.answers:
            allowed = [str(a) for a in self.answers[host]]
            if str(ip) not in allowed:
                raise AssertionError(
                    "connector dialed unvetted address %r for host %r "
                    "(resolver answers: %r)" % (ip, host, allowed)
                )
        if host not in self.responses:
            raise AssertionError("unexpected connection to host %r" % host)
        conn = FakeConnection(
            self, host, ip, port, timeout, self.responses[host], self.clock
        )
        self.connections.append(conn)
        return conn

    def hosts(self):
        return [c["host"] for c in self.calls]

    def all_closed(self):
        return all(c.closed for c in self.connections)


# ---------------------------------------------------------------------------
# image fixture helpers (Pillow only builds fixtures / inspects output)
# ---------------------------------------------------------------------------

def image_bytes(fmt, size=(64, 48), color=(255, 0, 0), mode="RGB", **save):
    from PIL import Image

    img = Image.new(mode, size, color)
    buf = io.BytesIO()
    img.save(buf, fmt, **save)
    return buf.getvalue()


def png_bytes(size=(64, 48), color=(255, 0, 0), mode="RGB", **save):
    return image_bytes("PNG", size, color, mode, **save)


def jpeg_bytes(size=(640, 480), color=(18, 52, 86), **save):
    return image_bytes("JPEG", size, color, "RGB", **save)


def oriented_jpeg(size=(120, 80), color=(30, 144, 255), orientation=6):
    from PIL import Image

    img = Image.new("RGB", size, color)
    exif = Image.Exif()
    exif[0x0112] = orientation
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif)
    return buf.getvalue()


def animated_gif_bytes():
    from PIL import Image

    a = Image.new("RGB", (16, 16), (255, 0, 0))
    b = Image.new("RGB", (16, 16), (0, 255, 0))
    buf = io.BytesIO()
    a.save(buf, "GIF", save_all=True, append_images=[b], duration=100)
    return buf.getvalue()


def animated_png_bytes():
    from PIL import Image

    a = Image.new("RGB", (16, 16), (255, 0, 0))
    b = Image.new("RGB", (16, 16), (0, 255, 0))
    buf = io.BytesIO()
    a.save(buf, "PNG", save_all=True, append_images=[b], duration=100)
    return buf.getvalue()


def metadata_png_bytes():
    from PIL import Image, PngImagePlugin

    img = Image.new("RGB", (64, 48), (9, 8, 7))
    info = PngImagePlugin.PngInfo()
    info.add_text("Comment", "leaky metadata")
    buf = io.BytesIO()
    img.save(buf, "PNG", pnginfo=info, icc_profile=b"\x00\x02\x00\x00fake")
    return buf.getvalue()


def png_chunk_types(data):
    assert data[:8] == PNG_MAGIC, "not a PNG"
    types = []
    offset = 8
    while offset + 8 <= len(data):
        (length,) = struct.unpack(">I", data[offset:offset + 4])
        types.append(data[offset + 4:offset + 8])
        offset += 12 + length
    return types


def open_image(data):
    from PIL import Image

    return Image.open(io.BytesIO(data))


# ---------------------------------------------------------------------------
# constants and error type
# ---------------------------------------------------------------------------

class TestConstants(unittest.TestCase):
    def test_version_and_bounds_match_the_contract(self):
        self.assertEqual(ab.BROKER_VERSION, "1.5.0")
        self.assertEqual(ab.MAX_REQUEST_BYTES, 4096)
        self.assertEqual(ab.MAX_URL_BYTES, 2048)
        self.assertEqual(ab.MAX_BODY_BYTES, 2 * 1024 * 1024)
        self.assertEqual(ab.MAX_TOTAL_SECONDS, 10.0)
        self.assertEqual(ab.SLICE_SECONDS, 3.0)
        self.assertEqual(ab.MAX_REDIRECTS, 3)
        self.assertEqual(ab.MAX_IMAGE_SIDE, 2048)
        self.assertEqual(ab.MAX_IMAGE_PIXELS, 4 * 1024 * 1024)
        self.assertEqual(ab.THUMBNAIL_LIMIT, 512)
        self.assertEqual(ab.SPOOL_MAX_FILES, 16)
        self.assertEqual(ab.SPOOL_MAX_BYTES, 16 * 1024 * 1024)

    def test_broker_error_carries_code_and_message(self):
        err = ab.BrokerError("bad_url", "nope")
        self.assertEqual(err.code, "bad_url")
        self.assertEqual(err.message, "nope")
        self.assertIn("nope", str(err))


# ---------------------------------------------------------------------------
# request parsing
# ---------------------------------------------------------------------------

class TestParseRequest(unittest.TestCase):
    LINE = json.dumps({"id": "req-1", "url": "https://cdn.example/a.png"})

    def test_valid_line_round_trips(self):
        parsed = ab.parse_request(self.LINE)
        self.assertEqual(
            parsed, {"id": "req-1", "url": "https://cdn.example/a.png"}
        )
        self.assertEqual(set(parsed), {"id", "url"})

    def test_accepts_bytes_input(self):
        parsed = ab.parse_request(self.LINE.encode())
        self.assertEqual(parsed["id"], "req-1")

    def test_rejects_non_json(self):
        for line in ("", "   ", "not json", "null", "123", '"string"',
                     "[1,2]", "{bad", b"\xff\xfe garbage"):
            with self.subTest(line=line):
                expect_error(self, "bad_request", ab.parse_request, line)

    def test_rejects_wrong_shape(self):
        url = "https://cdn.example/a.png"
        bad = [
            {},
            {"id": "req-1"},
            {"url": url},
            {"id": "req-1", "url": url, "extra": 1},
            {"id": "req-1", "url": 123},
            {"id": "req-1", "url": None},
            {"id": "req-1", "url": ["https://cdn.example/a.png"]},
        ]
        for obj in bad:
            with self.subTest(obj=obj):
                expect_error(
                    self, "bad_request", ab.parse_request, json.dumps(obj)
                )

    def test_rejects_oversized_line(self):
        line = self.LINE + " " * (ab.MAX_REQUEST_BYTES + 1 - len(self.LINE))
        self.assertGreater(len(line.encode()), ab.MAX_REQUEST_BYTES)
        expect_error(self, "request_too_long", ab.parse_request, line)

    def test_accepts_line_at_exact_bound(self):
        line = self.LINE + " " * (ab.MAX_REQUEST_BYTES - len(self.LINE))
        self.assertEqual(len(line.encode()), ab.MAX_REQUEST_BYTES)
        parsed = ab.parse_request(line)
        self.assertEqual(parsed["id"], "req-1")


# ---------------------------------------------------------------------------
# URL normalization
# ---------------------------------------------------------------------------

class TestNormalizeURL(unittest.TestCase):
    def test_valid_https_url_fields(self):
        parsed = ab.normalize_url("https://example.com/art.png")
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.host, "example.com")
        self.assertEqual(parsed.port, 443)
        self.assertEqual(parsed.path, "/art.png")
        self.assertFalse(parsed.query)
        self.assertEqual(parsed.url(), "https://example.com/art.png")

    def test_host_and_scheme_are_lowercased(self):
        parsed = ab.normalize_url("HTTPS://EXAMPLE.COM/Art.PNG")
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.host, "example.com")

    def test_query_is_preserved(self):
        parsed = ab.normalize_url("https://example.com/a.png?s=64&t=x")
        self.assertEqual(parsed.query, "?s=64&t=x")
        self.assertEqual(parsed.url(), "https://example.com/a.png?s=64&t=x")

    def test_explicit_default_port_443_is_accepted(self):
        parsed = ab.normalize_url("https://example.com:443/a.png")
        self.assertEqual(parsed.port, 443)
        self.assertEqual(parsed.host, "example.com")

    def test_rejects_non_https_schemes(self):
        for url in (
            "http://example.com/a.png",
            "ftp://example.com/a",
            "file:///etc/passwd",
            "data:image/png;base64,AAAA",
            "gopher://example.com/",
            "HTTPS+TLS://example.com/a",
        ):
            with self.subTest(url=url):
                expect_error(self, "bad_url", ab.normalize_url, url)

    def test_rejects_relative_and_schemeless(self):
        for url in (
            "example.com/a.png",
            "//example.com/a.png",
            "/just/a/path",
            "",
            "https:///a.png",
        ):
            with self.subTest(url=url):
                expect_error(self, "bad_url", ab.normalize_url, url)

    def test_rejects_userinfo(self):
        for url in (
            "https://user@example.com/a.png",
            "https://user:secret@example.com/a.png",
            "https://@example.com/a.png",
        ):
            with self.subTest(url=url):
                expect_error(self, "bad_url", ab.normalize_url, url)

    def test_rejects_fragment(self):
        expect_error(
            self, "bad_url", ab.normalize_url, "https://example.com/a.png#f"
        )
        expect_error(
            self, "bad_url", ab.normalize_url, "https://example.com/#"
        )

    def test_rejects_zone_ids(self):
        for url in (
            "https://[fe80::1%25eth0]/a.png",
            "https://[fe80::1%eth0]/a.png",
        ):
            with self.subTest(url=url):
                expect_error(self, "bad_url", ab.normalize_url, url)

    def test_rejects_non_443_ports(self):
        for url in (
            "https://example.com:8443/a.png",
            "https://example.com:80/a.png",
            "https://example.com:0/a.png",
            "https://example.com:65536/a.png",
            "https://example.com:44300/a.png",
        ):
            with self.subTest(url=url):
                expect_error(self, "bad_url", ab.normalize_url, url)

    def test_rejects_malformed_hosts_and_whitespace(self):
        for url in (
            "https://exa mple.com/a.png",
            " https://example.com/a.png",
            "https://example.com/a.png ",
            "https://ex\tample.com/a.png",
        ):
            with self.subTest(url=url):
                expect_error(self, "bad_url", ab.normalize_url, url)

    def test_rejects_oversized_url(self):
        pad = "a" * (ab.MAX_URL_BYTES + 1 - len("https://example.com/"))
        url = "https://example.com/" + pad
        self.assertGreater(len(url.encode()), ab.MAX_URL_BYTES)
        expect_error(self, "url_too_long", ab.normalize_url, url)

    def test_accepts_url_at_exact_byte_bound(self):
        prefix = "https://example.com/"
        url = prefix + "a" * (ab.MAX_URL_BYTES - len(prefix))
        self.assertEqual(len(url.encode()), ab.MAX_URL_BYTES)
        parsed = ab.normalize_url(url)
        self.assertEqual(parsed.host, "example.com")

    def test_origin_key_includes_host_path_and_query(self):
        # Redirect-loop identity is per resource: same URL -> same key,
        # any difference in host, path, or query -> different key.
        same_a = ab.normalize_url("https://a.test/one.png")
        same_b = ab.normalize_url("https://a.test/one.png")
        other_path = ab.normalize_url("https://a.test/two.png")
        other_query = ab.normalize_url("https://a.test/one.png?q=1")
        other_host = ab.normalize_url("https://b.test/one.png")
        key = same_a.origin_key()
        self.assertEqual(key, same_b.origin_key())
        self.assertNotEqual(key, other_path.origin_key())
        self.assertNotEqual(key, other_query.origin_key())
        self.assertNotEqual(key, other_host.origin_key())


# ---------------------------------------------------------------------------
# address vetting
# ---------------------------------------------------------------------------

REJECT_V4 = [
    "0.0.0.0", "0.1.2.3",
    "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.254",
    "192.168.0.1", "192.168.255.255",
    "127.0.0.1", "127.255.255.255",
    "169.254.0.1", "169.254.169.254",
    "100.64.0.1", "100.127.255.254",
    "192.0.0.1", "192.0.2.1", "198.51.100.7", "203.0.113.9",
    "198.18.0.1", "198.19.255.254",
    "224.0.0.1", "239.255.255.250",
    "240.0.0.1", "255.255.255.255",
]

REJECT_V6 = [
    "::", "::1",
    "fe80::1", "fe80::2", "FE80::1",
    "fc00::1", "fd00::1", "fd12:3456:789a::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:8.8.8.8",          # global v4 embedded in an IPv4-mapped IPv6
    "::ffff:10.0.0.1", "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:1.1.1.1",  # mapped, long form
    "64:ff9b::8.8.8.8",        # NAT64 with a global embedded v4
    "64:ff9b::192.0.2.1",      # NAT64 with a documentation v4
]

ACCEPT_ADDRS = [
    ("8.8.8.8", 4), ("1.1.1.1", 4), ("9.9.9.9", 4),
    ("93.184.216.34", 4),
    ("100.63.255.255", 4),   # just below CGNAT 100.64.0.0/10
    ("100.128.0.0", 4),      # just above CGNAT 100.127.255.255
    ("172.15.255.255", 4),   # just below 172.16.0.0/12
    ("172.32.0.0", 4),       # just above 172.31.255.255
    ("2606:4700::1111", 6),
    ("2001:4860:4860::8888", 6),
    ("2620:fe::fe", 6),
]

MALFORMED_ADDRS = [
    "example.com", "999.999.999.999", "10.0.0.256", "10.0.0",
    "", " 8.8.8.8", "8.8.8.8 ", "8.8.8.8:443", "fe80::%eth0",
]


class TestVetAddress(unittest.TestCase):
    def test_rejects_non_global_ipv4(self):
        for addr in REJECT_V4:
            with self.subTest(addr=addr):
                expect_error(self, "bad_address", ab.vet_address, addr)

    def test_rejects_non_global_ipv6(self):
        for addr in REJECT_V6:
            with self.subTest(addr=addr):
                expect_error(self, "bad_address", ab.vet_address, addr)

    def test_rejects_malformed_addresses(self):
        for addr in MALFORMED_ADDRS:
            with self.subTest(addr=addr):
                expect_error(self, "bad_address", ab.vet_address, addr)

    def test_accepts_global_addresses(self):
        for addr, version in ACCEPT_ADDRS:
            with self.subTest(addr=addr):
                vetted = ab.vet_address(addr)
                self.assertEqual(str(vetted), addr.lower())
                self.assertEqual(vetted.version, version)


class TestValidateAnswerSet(unittest.TestCase):
    def test_all_global_answers_are_vetted(self):
        addrs = ["8.8.8.8", PUBLIC_IP]
        out = ab.validate_answer_set(addrs)
        self.assertEqual(sorted(map(str, out)), sorted(addrs))

    def test_mixed_answers_reject_whole_set(self):
        # DNS rebinding: one non-global answer poisons the entire set.
        for addrs in (
            [PUBLIC_IP, "10.0.0.5"],
            ["10.0.0.5", PUBLIC_IP],
            [PUBLIC_IP, "127.0.0.1"],
            [PUBLIC_V6, "169.254.169.254"],
            [PUBLIC_IP, "100.64.0.9"],
            [PUBLIC_IP, "::ffff:10.0.0.1"],
            [PUBLIC_IP, "64:ff9b::8.8.8.8"],
            [PUBLIC_IP, "fd00::1"],
            [PUBLIC_IP, "224.0.0.1"],
        ):
            with self.subTest(addrs=addrs):
                expect_error(
                    self, "bad_address", ab.validate_answer_set, addrs
                )

    def test_duplicates_of_global_addresses_are_fine(self):
        out = ab.validate_answer_set(["8.8.8.8", "8.8.8.8", PUBLIC_IP])
        self.assertEqual(set(map(str, out)), {"8.8.8.8", PUBLIC_IP})

    def test_empty_answer_set_is_rejected(self):
        expect_error(
            self, {"dns_failure", "bad_address"}, ab.validate_answer_set, []
        )


# ---------------------------------------------------------------------------
# TLS context and pinned connections
# ---------------------------------------------------------------------------

class TestTLSBasics(unittest.TestCase):
    def test_default_context_is_verifying(self):
        ctx = ab.default_ssl_context()
        self.assertIsInstance(ctx, ssl.SSLContext)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)
        self.assertGreaterEqual(ctx.minimum_version, ssl.TLSVersion.TLSv1_2)

    def test_pinned_connection_dials_numeric_ip_and_keeps_hostname(self):
        raw_sock = mock.MagicMock(name="raw_socket")
        wrapped = mock.MagicMock(name="tls_socket")
        with mock.patch(
            "socket.socket", return_value=raw_sock
        ) as sock_ctor, mock.patch.object(
            ssl.SSLContext, "wrap_socket", return_value=wrapped
        ) as wrap:
            conn = ab.PinnedHTTPSConnection(
                "example.com",
                443,
                pinned_ip="192.0.2.1",  # vetted elsewhere; never dialed here
                timeout=0.05,
                context=ab.default_ssl_context(),
            )
            try:
                conn.connect()
            except Exception as exc:  # noqa: BLE001
                self.fail(
                    "connect() did not go through socket.socket "
                    "(a real dial was attempted and failed: %r)" % exc
                )
            self.assertGreaterEqual(sock_ctor.call_count, 1)
            self.assertEqual(raw_sock.connect.call_count, 1)
            connect_repr = repr(raw_sock.connect.call_args)
            self.assertIn("192.0.2.1", connect_repr)
            self.assertNotIn("example.com", connect_repr)
            self.assertEqual(wrap.call_count, 1)
            wrap_repr = repr(wrap.call_args) + repr(wrap.call_args.kwargs)
            self.assertIn("server_hostname", wrap_repr)
            self.assertIn("example.com", wrap_repr)
            self.assertIs(conn.sock, wrapped)

            # The Host header must still carry the hostname, not the IP.
            conn.request("GET", "/art.png")
            sent = b"".join(
                c.args[0] for c in wrapped.sendall.call_args_list
            )
            self.assertIn(b"GET /art.png", sent)
            self.assertIn(b"Host: example.com", sent)
            self.assertNotIn(b"Host: 192.0.2.1", sent)


# ---------------------------------------------------------------------------
# read_bounded
# ---------------------------------------------------------------------------

class TestReadBounded(unittest.TestCase):
    def test_returns_body_smaller_than_max(self):
        resp = FakeResponse(200, body=b"A" * 100)
        self.assertEqual(ab.read_bounded(resp, 128), b"A" * 100)

    def test_returns_body_of_exactly_max_bytes(self):
        resp = FakeResponse(200, body=b"B" * 128)
        self.assertEqual(ab.read_bounded(resp, 128), b"B" * 128)

    def test_rejects_body_of_max_plus_one_bytes(self):
        # MAX+1 must actually be read so an oversized body is always caught.
        resp = FakeResponse(200, body=b"C" * 129)
        expect_error(self, "too_large", ab.read_bounded, resp, 128)

    def test_slice_timeout_raises_timeout(self):
        clock = FakeClock()
        resp = FakeResponse(
            200, body=b"D" * 64, clock=clock, delay_per_read=4.0
        )
        expect_error(
            self, "timeout", ab.read_bounded, resp, 128,
            clock=clock, slice_timeout=3.0,
        )

    def test_fast_reads_stay_within_slice(self):
        clock = FakeClock()
        resp = FakeResponse(
            200, body=b"E" * 64, clock=clock, delay_per_read=0.5
        )
        body = ab.read_bounded(resp, 128, clock=clock, slice_timeout=3.0)
        self.assertEqual(body, b"E" * 64)


# ---------------------------------------------------------------------------
# fetch_artwork
# ---------------------------------------------------------------------------

class FetchTestCase(unittest.TestCase):
    def make_transport(self, responses, answers, clock=None):
        resolver = FakeResolver(answers)
        connector = FakeConnector(responses, answers, clock=clock)
        return resolver, connector

    def parsed(self, url="https://cdn.example/art.png"):
        return ab.normalize_url(url)


class TestFetchArtwork(FetchTestCase):
    def test_single_hop_success(self):
        body = b"\x89PNG" + b"payload-bytes"
        responses = {
            "cdn.example": [
                FakeResponse(200, {"Content-Type": "image/png"}, body)
            ]
        }
        answers = {"cdn.example": [PUBLIC_IP, PUBLIC_IP_2]}
        resolver, connector = self.make_transport(responses, answers)
        out_body, ctype = ab.fetch_artwork(
            self.parsed(), resolver=resolver, connector=connector
        )
        self.assertEqual(out_body, body)
        self.assertEqual(ctype, "image/png")
        self.assertEqual(resolver.calls, ["cdn.example"])
        self.assertEqual(len(connector.calls), 1)
        call = connector.calls[0]
        self.assertEqual(call["host"], "cdn.example")
        self.assertIn(call["ip"], [PUBLIC_IP, PUBLIC_IP_2])
        self.assertNotEqual(call["ip"], "cdn.example")  # numeric pin only
        self.assertEqual(call["port"], 443)
        self.assertTrue(connector.all_closed())

    def test_request_targets_origin_form_path(self):
        responses = {
            "cdn.example": [
                FakeResponse(200, {"Content-Type": "image/png"}, b"x")
            ]
        }
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP]}
        )
        ab.fetch_artwork(
            self.parsed("https://cdn.example/art.png?q=1"),
            resolver=resolver,
            connector=connector,
        )
        sent = connector.connections[0].requests
        self.assertTrue(sent)
        self.assertTrue(
            any("/art.png" in str(url) for (_m, url, _a, _kw) in sent),
            "expected origin-form path in request, got %r" % (sent,),
        )

    def test_connector_timeouts_are_sliced(self):
        responses = {
            "cdn.example": [
                FakeResponse(200, {"Content-Type": "image/png"}, b"x")
            ]
        }
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP]}
        )
        ab.fetch_artwork(
            self.parsed(), resolver=resolver, connector=connector
        )
        for call in connector.calls:
            self.assertGreater(call["timeout"], 0)
            self.assertLessEqual(call["timeout"], ab.SLICE_SECONDS)

    # --- destination vetting through fetch -------------------------------

    def test_mixed_dns_answers_are_rejected_before_connecting(self):
        responses = {"cdn.example": [FakeResponse(200, {}, b"x")]}
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP, "10.0.0.5"]}
        )
        expect_error(
            self, "bad_address", ab.fetch_artwork, self.parsed(),
            resolver=resolver, connector=connector,
        )
        self.assertEqual(resolver.calls, ["cdn.example"])
        self.assertEqual(connector.calls, [])  # never dialed

    def test_dns_failure_maps_to_dns_failure_code(self):
        resolver = RaisingResolver(socket.gaierror("no such host"))
        connector = FakeConnector({}, {})
        expect_error(
            self, "dns_failure", ab.fetch_artwork, self.parsed(),
            resolver=resolver, connector=connector,
        )
        self.assertEqual(connector.calls, [])

    def test_empty_answer_set_is_rejected(self):
        responses = {"cdn.example": [FakeResponse(200, {}, b"x")]}
        resolver, connector = self.make_transport(
            responses, {"cdn.example": []}
        )
        expect_error(
            self, {"dns_failure", "bad_address"}, ab.fetch_artwork,
            self.parsed(), resolver=resolver, connector=connector,
        )
        self.assertEqual(connector.calls, [])

    # --- redirects ---------------------------------------------------------

    def test_three_redirects_succeed_with_every_hop_revalidated(self):
        hosts = ["hop0.test", "hop1.test", "hop2.test", "hop3.test"]
        responses = {}
        for i, host in enumerate(hosts[:-1]):
            responses[host] = [
                FakeResponse(
                    302,
                    {
                        "Location": "https://%s/art.png" % hosts[i + 1],
                        "Content-Type": "text/html",
                    },
                    b"redirect",
                )
            ]
        responses[hosts[-1]] = [
            FakeResponse(200, {"Content-Type": "image/png"}, b"final-png")
        ]
        answers = {
            host: ["93.184.216.%d" % (i + 2)]
            for i, host in enumerate(hosts)
        }
        resolver, connector = self.make_transport(responses, answers)
        body, ctype = ab.fetch_artwork(
            self.parsed("https://hop0.test/art.png"),
            resolver=resolver,
            connector=connector,
        )
        self.assertEqual(body, b"final-png")
        self.assertEqual(ctype, "image/png")
        # Every hop was resolved and vetted separately — no auto-follow.
        self.assertEqual(resolver.calls, hosts)
        self.assertEqual(connector.hosts(), hosts)
        for call in connector.calls:
            self.assertEqual(
                call["ip"],
                answers[call["host"]][0],
                "connector must dial the address vetted for %r"
                % call["host"],
            )
        self.assertTrue(connector.all_closed())

    def test_redirect_to_private_destination_is_rejected(self):
        responses = {
            "public.test": [
                FakeResponse(
                    302, {"Location": "https://internal.test/art.png"}
                )
            ],
            "internal.test": [FakeResponse(200, {}, b"x")],
        }
        answers = {
            "public.test": [PUBLIC_IP],
            "internal.test": ["10.0.0.9"],
        }
        resolver, connector = self.make_transport(responses, answers)
        expect_error(
            self, "bad_address", ab.fetch_artwork,
            self.parsed("https://public.test/art.png"),
            resolver=resolver, connector=connector,
        )
        self.assertEqual(resolver.calls, ["public.test", "internal.test"])
        self.assertEqual(
            connector.hosts(), ["public.test"]
        )  # never dialed the private host

    def test_redirect_loop_is_rejected(self):
        responses = {
            "loop-a.test": [
                FakeResponse(302, {"Location": "https://loop-b.test/a"}),
                FakeResponse(302, {"Location": "https://loop-b.test/a"}),
            ],
            "loop-b.test": [
                FakeResponse(302, {"Location": "https://loop-a.test/a"}),
                FakeResponse(302, {"Location": "https://loop-a.test/a"}),
            ],
        }
        answers = {
            "loop-a.test": [PUBLIC_IP],
            "loop-b.test": [PUBLIC_IP_2],
        }
        resolver, connector = self.make_transport(responses, answers)
        expect_error(
            self, "redirect_loop", ab.fetch_artwork,
            self.parsed("https://loop-a.test/a"),
            resolver=resolver, connector=connector,
        )
        self.assertLessEqual(len(connector.calls), 3)

    def test_more_than_three_redirects_is_rejected(self):
        hosts = ["r0.test", "r1.test", "r2.test", "r3.test", "final.test"]
        responses = {}
        for i, host in enumerate(hosts[:-1]):
            responses[host] = [
                FakeResponse(
                    302, {"Location": "https://%s/a" % hosts[i + 1]}
                )
            ]
        responses["final.test"] = [FakeResponse(200, {}, b"x")]
        answers = {
            host: ["93.184.216.%d" % (i + 2)]
            for i, host in enumerate(hosts)
        }
        resolver, connector = self.make_transport(responses, answers)
        expect_error(
            self, "redirect_limit", ab.fetch_artwork,
            self.parsed("https://r0.test/a"),
            resolver=resolver, connector=connector,
        )

    def test_redirect_downgrade_to_http_is_rejected(self):
        responses = {
            "cdn.example": [
                FakeResponse(302, {"Location": "http://cdn.example/a.png"})
            ]
        }
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP]}
        )
        expect_error(
            self, "redirect_invalid", ab.fetch_artwork, self.parsed(),
            resolver=resolver, connector=connector,
        )

    def test_redirect_to_non_443_port_is_rejected(self):
        responses = {
            "cdn.example": [
                FakeResponse(
                    302, {"Location": "https://cdn.example:8443/art.png"}
                )
            ]
        }
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP]}
        )
        expect_error(
            self, {"redirect_invalid", "bad_url"}, ab.fetch_artwork,
            self.parsed(), resolver=resolver, connector=connector,
        )

    # --- response validation ------------------------------------------------

    def test_non_200_status_is_rejected(self):
        for status in (204, 400, 403, 404, 500, 503):
            with self.subTest(status=status):
                responses = {
                    "cdn.example": [
                        FakeResponse(
                            status, {"Content-Type": "image/png"}, b"x"
                        )
                    ]
                }
                resolver, connector = self.make_transport(
                    responses, {"cdn.example": [PUBLIC_IP]}
                )
                expect_error(
                    self, "http_status", ab.fetch_artwork, self.parsed(),
                    resolver=resolver, connector=connector,
                )

    def test_redirect_without_location_is_rejected(self):
        responses = {
            "cdn.example": [
                FakeResponse(302, {"Content-Type": "text/html"}, b"")
            ]
        }
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP]}
        )
        expect_error(
            self, {"redirect_invalid", "http_status"}, ab.fetch_artwork,
            self.parsed(), resolver=resolver, connector=connector,
        )

    def test_permissive_content_types_are_rejected(self):
        for ctype in (
            None,
            "",
            "text/html",
            "application/octet-stream",
            "image/webp",
            "image/gif",
            "application/json",
            "image/svg+xml",
        ):
            with self.subTest(ctype=ctype):
                headers = {} if ctype is None else {"Content-Type": ctype}
                responses = {
                    "cdn.example": [FakeResponse(200, headers, b"x")]
                }
                resolver, connector = self.make_transport(
                    responses, {"cdn.example": [PUBLIC_IP]}
                )
                expect_error(
                    self, "content_type", ab.fetch_artwork, self.parsed(),
                    resolver=resolver, connector=connector,
                )

    def test_content_encoding_other_than_identity_is_rejected(self):
        for enc in ("gzip", "deflate", "br", "compress", "chunked, gzip"):
            with self.subTest(enc=enc):
                responses = {
                    "cdn.example": [
                        FakeResponse(
                            200,
                            {
                                "Content-Type": "image/png",
                                "Content-Encoding": enc,
                            },
                            b"x",
                        )
                    ]
                }
                resolver, connector = self.make_transport(
                    responses, {"cdn.example": [PUBLIC_IP]}
                )
                expect_error(
                    self, "content_encoding", ab.fetch_artwork,
                    self.parsed(), resolver=resolver, connector=connector,
                )

    def test_identity_encoding_is_accepted(self):
        responses = {
            "cdn.example": [
                FakeResponse(
                    200,
                    {
                        "Content-Type": "image/jpeg",
                        "Content-Encoding": "identity",
                    },
                    b"jpeg-ish",
                )
            ]
        }
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP]}
        )
        body, ctype = ab.fetch_artwork(
            self.parsed(), resolver=resolver, connector=connector
        )
        self.assertEqual(body, b"jpeg-ish")
        self.assertEqual(ctype, "image/jpeg")

    # --- length and deadlines -------------------------------------------------

    def test_body_of_exactly_max_bytes_is_returned(self):
        body = b"\x89PNG" + b"z" * (ab.MAX_BODY_BYTES - 4)
        self.assertEqual(len(body), ab.MAX_BODY_BYTES)
        responses = {
            "cdn.example": [
                FakeResponse(200, {"Content-Type": "image/png"}, body)
            ]
        }
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP]}
        )
        out, _ = ab.fetch_artwork(
            self.parsed(), resolver=resolver, connector=connector
        )
        self.assertEqual(len(out), ab.MAX_BODY_BYTES)

    def test_declared_content_length_over_limit_is_rejected_before_read(self):
        responses = {
            "cdn.example": [
                FakeResponse(
                    200,
                    {
                        "Content-Type": "image/png",
                        "Content-Length": str(ab.MAX_BODY_BYTES + 1),
                    },
                    b"x",
                )
            ]
        }
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP]}
        )
        expect_error(
            self, "too_large", ab.fetch_artwork, self.parsed(),
            resolver=resolver, connector=connector,
        )

    def test_malformed_content_length_is_rejected(self):
        responses = {
            "cdn.example": [
                FakeResponse(
                    200,
                    {"Content-Type": "image/png", "Content-Length": "nope"},
                    b"x",
                )
            ]
        }
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP]}
        )
        expect_error(
            self, "too_large", ab.fetch_artwork, self.parsed(),
            resolver=resolver, connector=connector,
        )

    def test_body_over_max_bytes_is_rejected(self):
        body = b"\x89PNG" + b"z" * (ab.MAX_BODY_BYTES - 3)
        self.assertEqual(len(body), ab.MAX_BODY_BYTES + 1)
        responses = {
            "cdn.example": [
                FakeResponse(200, {"Content-Type": "image/png"}, body)
            ]
        }
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP]}
        )
        expect_error(
            self, "too_large", ab.fetch_artwork, self.parsed(),
            resolver=resolver, connector=connector,
        )

    def test_slow_reads_hit_the_slice_timeout(self):
        clock = FakeClock()
        responses = {
            "cdn.example": [
                FakeResponse(
                    200,
                    {"Content-Type": "image/png"},
                    b"p" * 64,
                    clock=clock,
                    delay_per_read=4.0,  # > 3 s slice
                )
            ]
        }
        resolver, connector = self.make_transport(
            responses, {"cdn.example": [PUBLIC_IP]}, clock=clock
        )
        expect_error(
            self, "timeout", ab.fetch_artwork, self.parsed(),
            resolver=resolver, connector=connector, clock=clock,
        )

    def test_slow_hops_hit_the_total_deadline(self):
        clock = FakeClock()
        responses = {
            "slow0.test": [
                FakeResponse(
                    302,
                    {"Location": "https://slow1.test/art.png"},
                    getresponse_delay=6.0,
                )
            ],
            "slow1.test": [
                FakeResponse(
                    302,
                    {"Location": "https://slow2.test/art.png"},
                    getresponse_delay=6.0,
                )
            ],
            "slow2.test": [
                FakeResponse(200, {"Content-Type": "image/png"}, b"x")
            ],
        }
        answers = {
            "slow0.test": [PUBLIC_IP],
            "slow1.test": [PUBLIC_IP_2],
            "slow2.test": [PUBLIC_IP_3],
        }
        resolver, connector = self.make_transport(responses, answers, clock=clock)
        expect_error(
            self, "timeout", ab.fetch_artwork,
            self.parsed("https://slow0.test/art.png"),
            resolver=resolver, connector=connector, clock=clock,
        )
        # The transport took at least 12 s of fake time; the 10 s total
        # deadline must fire no matter where it is checked, and the fetch
        # must never return success.
        self.assertGreaterEqual(clock(), 12.0)
        self.assertLessEqual(len(connector.calls), 2)


# ---------------------------------------------------------------------------
# decode_to_png
# ---------------------------------------------------------------------------

class TestDecodeToPNG(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.png_small = png_bytes((64, 48), (255, 0, 0))
        cls.png_wide = png_bytes((800, 600), (0, 128, 255))
        cls.jpeg_med = jpeg_bytes((640, 480), (18, 52, 86))
        cls.jpeg_ori = oriented_jpeg((120, 80), (30, 144, 255), 6)
        cls.rgba_transparent = png_bytes((64, 64), (255, 0, 0, 0), "RGBA")
        cls.palette_png = png_bytes((64, 48), (0, 200, 100), "P")
        cls.metadata_png = metadata_png_bytes()
        cls.animated_gif = animated_gif_bytes()
        cls.animated_png = animated_png_bytes()
        cls.png_2048 = png_bytes((2048, 2048), (1, 2, 3))
        cls.png_too_wide = png_bytes((2049, 8), (4, 5, 6))
        cls.png_too_tall = png_bytes((8, 2049), (4, 5, 6))
        cls.png_3000_wide = png_bytes((3000, 64), (7, 8, 9))
        cls.truncated = cls.png_small[: len(cls.png_small) // 2]

    def decode(self, data, expected=None):
        return ab.decode_to_png(data, expected)

    def check_png_output(self, png, width, height):
        self.assertTrue(png.startswith(PNG_MAGIC), "output is not a PNG")
        self.assertLessEqual(width, ab.THUMBNAIL_LIMIT)
        self.assertLessEqual(height, ab.THUMBNAIL_LIMIT)
        img = open_image(png)
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.size, (width, height))
        self.assertIn(img.mode, ("RGB", "RGBA"))
        return img

    def test_valid_png_is_canonicalized_and_thumbnailed(self):
        png, width, height = self.decode(self.png_wide)
        self.assertEqual((width, height), (512, 384))
        img = self.check_png_output(png, width, height)
        # Center pixel of a solid-blue source stays blue after resampling.
        pixel = img.convert("RGB").getpixel((width // 2, height // 2))
        self.assertLess(pixel[0], 48)
        self.assertGreater(pixel[2], 200)

    def test_small_png_is_never_upscaled(self):
        png, width, height = self.decode(self.png_small)
        self.assertEqual((width, height), (64, 48))
        self.check_png_output(png, width, height)

    def test_valid_jpeg_is_reencoded_as_png(self):
        png, width, height = self.decode(self.jpeg_med)
        self.assertEqual((width, height), (512, 384))
        img = self.check_png_output(png, width, height)
        self.assertEqual(img.format, "PNG")

    def test_exif_orientation_is_transposed(self):
        png, width, height = self.decode(self.jpeg_ori)
        # Orientation 6 rotates 90 degrees: 120x80 becomes 80x120.
        self.assertEqual((width, height), (80, 120))
        self.check_png_output(png, width, height)

    def test_transparency_survives_canonicalization(self):
        png, width, height = self.decode(self.rgba_transparent)
        img = self.check_png_output(png, width, height)
        self.assertEqual(img.mode, "RGBA")
        self.assertEqual(img.getpixel((width // 2, height // 2))[3], 0)

    def test_palette_png_decodes(self):
        png, width, height = self.decode(self.palette_png)
        img = self.check_png_output(png, width, height)
        self.assertIn(img.mode, ("RGB", "RGBA"))

    def test_max_boundary_image_is_accepted(self):
        # 2048x2048 == 4,194,304 pixels is exactly at both limits.
        png, width, height = self.decode(self.png_2048)
        self.assertEqual((width, height), (512, 512))
        self.check_png_output(png, width, height)

    def test_oversized_sides_are_rejected(self):
        for label, data in (
            ("2049-wide", self.png_too_wide),
            ("2049-tall", self.png_too_tall),
            ("3000-wide", self.png_3000_wide),
        ):
            with self.subTest(label=label):
                expect_error(self, "image_too_large", ab.decode_to_png, data)

    def test_animation_is_rejected(self):
        expect_error(
            self, "animated_image", ab.decode_to_png, self.animated_png
        )

    def test_animated_gif_is_rejected(self):
        # GIF is not an accepted type; the bytes must never decode into a
        # published artwork.  Which code fires is the broker's choice.
        expect_error(
            self,
            {"animated_image", "decode_failed", "content_type"},
            ab.decode_to_png,
            self.animated_gif,
        )

    def test_malformed_data_is_rejected(self):
        for label, data in (
            ("empty", b""),
            ("garbage", b"not an image at all"),
            ("header-only", PNG_MAGIC + b"junkjunkjunk"),
            ("truncated-png", self.truncated),
            ("truncated-jpeg", self.jpeg_med[:64]),
        ):
            with self.subTest(label=label):
                expect_error(self, "decode_failed", ab.decode_to_png, data)

    def test_expected_content_type_must_match_sniffed_format(self):
        # Matching declarations succeed.
        ab.decode_to_png(self.png_small, "image/png")
        ab.decode_to_png(jpeg_bytes((64, 48)), "image/jpeg")
        # Magic-byte mismatch with the served type is rejected.
        expect_error(
            self, "content_type", ab.decode_to_png,
            jpeg_bytes((64, 48)), "image/png",
        )
        expect_error(
            self, "content_type", ab.decode_to_png,
            self.png_small, "image/jpeg",
        )
        # Nonsense declared types are rejected too.
        expect_error(
            self, "content_type", ab.decode_to_png,
            self.png_small, "text/html",
        )

    def test_output_is_metadata_free(self):
        forbidden = {"tEXt", "zTXt", "iTXt", "iCCP", "eXIf", "time"}
        for label, data in (
            ("png-with-text-and-icc", self.metadata_png),
            ("jpeg-with-exif", self.jpeg_ori),
        ):
            with self.subTest(label=label):
                png, _w, _h = self.decode(data)
                types = {
                    t.decode("latin-1") for t in png_chunk_types(png)
                }
                self.assertEqual(
                    types & forbidden,
                    set(),
                    "canonical PNG carries metadata chunks: %r"
                    % sorted(types & forbidden),
                )
                img = open_image(png)
                self.assertIsNone(img.info.get("exif"))
                self.assertIsNone(img.info.get("icc_profile"))

    def test_output_is_deterministic(self):
        first = self.decode(self.png_small)[0]
        second = self.decode(self.png_small)[0]
        self.assertEqual(first, second)
        # Same pixels encoded twice must canonicalize identically.
        again = png_bytes((64, 48), (255, 0, 0))
        self.assertEqual(first, self.decode(again)[0])
        # Different pixels must not collide.
        other = self.decode(png_bytes((64, 48), (0, 0, 255)))[0]
        self.assertNotEqual(first, other)


# ---------------------------------------------------------------------------
# ArtworkSpool
# ---------------------------------------------------------------------------

class SpoolTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(
            tempfile.mkdtemp(prefix="artwork-broker-test-")
        )
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def root(self, name="art"):
        return self.tmp / name


class TestArtworkSpool(SpoolTestCase):
    def test_ensure_root_creates_private_directory(self):
        spool = ab.ArtworkSpool(self.root())
        created = spool.ensure_root()
        self.assertTrue(created.is_dir())
        self.assertEqual(
            stat.S_IMODE(os.stat(created).st_mode), 0o700
        )
        again = spool.ensure_root()  # idempotent
        self.assertTrue(again.is_dir())

    def test_publish_writes_private_regular_file(self):
        spool = ab.ArtworkSpool(self.root())
        payload = b"canonical-png-bytes"
        entry = spool.publish(payload)
        self.assertTrue(entry.path.is_absolute())
        self.assertTrue(entry.path.is_file())
        self.assertFalse(os.path.islink(entry.path))
        self.assertEqual(
            stat.S_IMODE(os.stat(entry.path).st_mode), 0o600
        )
        self.assertEqual(entry.path.read_bytes(), payload)
        self.assertEqual(entry.sha256, hashlib.sha256(payload).hexdigest())
        self.assertEqual(entry.size, len(payload))
        self.assertEqual(str(entry.file_url), "file://%s" % entry.path)

    def test_publish_is_content_addressed_and_cache_hits(self):
        spool = ab.ArtworkSpool(self.root())
        first = spool.publish(b"payload-A")
        second = spool.publish(b"payload-A")
        self.assertEqual(first.path, second.path)
        self.assertEqual(first.sha256, second.sha256)
        self.assertEqual(len(spool.entries()), 1)
        third = spool.publish(b"payload-B")
        self.assertNotEqual(third.path, first.path)
        self.assertEqual(len(spool.entries()), 2)

    def test_cache_reuse_repairs_mode_drift(self):
        spool = ab.ArtworkSpool(self.root())
        payload = b"mode-drift-payload"
        entry = spool.publish(payload)
        os.chmod(entry.path, 0o644)
        again = spool.publish(payload)
        self.assertEqual(again.path, entry.path)
        self.assertEqual(
            stat.S_IMODE(os.stat(again.path).st_mode), 0o600
        )
        self.assertEqual(again.path.read_bytes(), payload)
        self.assertEqual(len(spool.entries()), 1)

    def test_corrupt_cached_file_is_republished(self):
        spool = ab.ArtworkSpool(self.root())
        payload = b"real-payload-bytes!"
        entry = spool.publish(payload)
        # Corrupt the cached file in place: same name, same size, wrong
        # content — the digest no longer matches the content-addressed name.
        corrupt = b"evil-payload-bytes!"
        self.assertEqual(len(corrupt), len(payload))
        entry.path.write_bytes(corrupt)
        again = spool.publish(payload)
        self.assertEqual(again.path, entry.path)
        self.assertEqual(again.path.read_bytes(), payload)
        self.assertEqual(len(spool.entries()), 1)

    def test_root_symlink_is_rejected(self):
        real = self.tmp / "real"
        real.mkdir()
        link = self.tmp / "link"
        os.symlink(real, link)
        spool = ab.ArtworkSpool(link)
        expect_error(self, "spool_error", spool.ensure_root)
        expect_error(self, "spool_error", spool.publish, b"x")

    def test_intermediate_symlink_is_rejected(self):
        real_parent = self.tmp / "real-parent"
        (real_parent / "sub").mkdir(parents=True)
        link_parent = self.tmp / "link-parent"
        os.symlink(real_parent, link_parent)
        spool = ab.ArtworkSpool(link_parent / "sub" / "art")
        expect_error(self, "spool_error", spool.ensure_root)

    def test_root_that_is_a_regular_file_is_rejected(self):
        victim = self.tmp / "not-a-dir"
        victim.write_text("nope")
        spool = ab.ArtworkSpool(victim)
        expect_error(self, "spool_error", spool.ensure_root)

    def test_publish_never_writes_through_a_planted_symlink(self):
        payload = b"planted-symlink-payload"
        probe = ab.ArtworkSpool(self.root("probe"))
        name = probe.publish(payload).path.name

        victim = self.tmp / "victim.png"
        victim.write_bytes(b"victim-bytes")
        spool = ab.ArtworkSpool(self.root())
        planted = spool.ensure_root() / name
        os.symlink(victim, planted)

        try:
            entry = spool.publish(payload)
        except ab.BrokerError as exc:
            # Rejecting is also acceptable; the victim must stay intact.
            self.assertEqual(exc.code, "spool_error")
            self.assertEqual(victim.read_bytes(), b"victim-bytes")
            return
        self.assertFalse(
            os.path.islink(entry.path), "published artwork is a symlink"
        )
        self.assertEqual(entry.path.read_bytes(), payload)
        self.assertEqual(victim.read_bytes(), b"victim-bytes")

    def test_failed_publish_leaves_no_partial_files(self):
        spool = ab.ArtworkSpool(self.root())
        spool.publish(b"already-here")
        before = set(os.listdir(spool.ensure_root()))
        with mock.patch.object(
            os, "link", side_effect=OSError("boom")
        ), mock.patch.object(
            os, "replace", side_effect=OSError("boom")
        ), mock.patch.object(
            os, "rename", side_effect=OSError("boom")
        ):
            expect_error(self, "spool_error", spool.publish, b"broken")
        self.assertEqual(set(os.listdir(spool.ensure_root())), before)

    def test_link_race_with_valid_winner_reuses_target(self):
        spool = ab.ArtworkSpool(self.root())
        payload = b"race-winner-payload"
        entry = spool.publish(payload)
        # Every link attempt loses the race to an identical winner.
        with mock.patch.object(os, "link", side_effect=FileExistsError):
            again = spool.publish(payload)
        self.assertEqual(again.path, entry.path)
        self.assertEqual(again.path.read_bytes(), payload)
        self.assertEqual(
            os.listdir(spool.ensure_root()), [entry.path.name]
        )  # no .pending- leftovers

    def test_link_race_with_corrupt_winner_replaces_it(self):
        spool = ab.ArtworkSpool(self.root())
        payload = b"race-replace-payload"
        entry = spool.publish(payload)
        entry.path.write_bytes(b"race-replace-payloaX")  # same size, wrong
        with mock.patch.object(os, "link", side_effect=_flaky_link(1)):
            again = spool.publish(payload)
        self.assertEqual(again.path, entry.path)
        self.assertEqual(again.path.read_bytes(), payload)
        self.assertEqual(os.listdir(spool.ensure_root()), [entry.path.name])

    def test_link_race_with_ghost_winner_still_publishes(self):
        spool = ab.ArtworkSpool(self.root())
        # Nothing exists at the target, yet the first link claim collides;
        # the vanished "winner" must not abort publication.
        with mock.patch.object(os, "link", side_effect=_flaky_link(1)):
            entry = spool.publish(b"ghost-winner-payload")
        self.assertTrue(entry.path.is_file())
        self.assertEqual(entry.path.read_bytes(), b"ghost-winner-payload")
        self.assertEqual(os.listdir(spool.ensure_root()), [entry.path.name])

    def test_fifo_at_target_name_is_replaced_without_blocking(self):
        spool = ab.ArtworkSpool(self.root())
        payload = b"fifo-payload-bytes"
        probe = ab.ArtworkSpool(self.root("probe"))
        name = probe.publish(payload).path.name
        target = spool.ensure_root() / name
        os.mkfifo(target)
        entry = spool.publish(payload)
        self.assertEqual(entry.path, target)
        self.assertTrue(stat.S_ISREG(os.stat(entry.path).st_mode))
        self.assertFalse(os.path.islink(entry.path))
        self.assertEqual(entry.path.read_bytes(), payload)

    def test_entries_lists_only_regular_files(self):
        spool = ab.ArtworkSpool(self.root())
        entry = spool.publish(b"only-real-file")
        rogue = spool.ensure_root() / "rogue.png"
        victim = self.tmp / "rogue-victim"
        victim.write_text("x")
        os.symlink(victim, rogue)
        listed = {e.path for e in spool.entries()}
        self.assertEqual(listed, {entry.path})
        for e in spool.entries():
            self.assertFalse(os.path.islink(e.path))

    def test_file_cap_evicts_oldest_first(self):
        spool = ab.ArtworkSpool(self.root())
        published = []
        for i in range(ab.SPOOL_MAX_FILES + 1):
            entry = spool.publish(b"payload-%02d" % i)
            # Deterministic ordering independent of filesystem timestamps.
            os.utime(entry.path, (1000 + i, 1000 + i))
            published.append(entry.path)
        remaining = {e.path for e in spool.entries()}
        self.assertEqual(len(remaining), ab.SPOOL_MAX_FILES)
        self.assertNotIn(published[0], remaining)  # oldest evicted
        for path in published[1:]:
            self.assertIn(path, remaining)

    def test_byte_cap_evicts_oldest_first(self):
        cap = 3 * 1024 + 512
        spool = ab.ArtworkSpool(self.root(), max_bytes=cap)
        first = spool.publish(b"x" * 1024)
        os.utime(first.path, (100, 100))
        second = spool.publish(b"x" * 1024 + b"2")
        os.utime(second.path, (101, 101))
        third = spool.publish(b"x" * 1024 + b"3")
        os.utime(third.path, (102, 102))
        fourth = spool.publish(b"x" * 1024 + b"4")  # pushes over the cap
        os.utime(fourth.path, (103, 103))
        remaining = {e.path for e in spool.entries()}
        self.assertNotIn(first.path, remaining)
        for path in (second.path, third.path, fourth.path):
            self.assertIn(path, remaining)

    def test_enforce_limits_protects_the_named_file(self):
        root = self.root()
        spool = ab.ArtworkSpool(root, max_bytes=2048)
        keep_entry = spool.publish(b"y" * 512)
        os.utime(keep_entry.path, (100, 100))
        other = spool.publish(b"z" * 600)
        os.utime(other.path, (101, 101))
        # Re-open the same spool with a tighter byte cap: eviction must
        # skip the explicitly kept (oldest) file and take the next one.
        tighter = ab.ArtworkSpool(root, max_bytes=1024)
        tighter.enforce_limits(keep=keep_entry.path)
        self.assertTrue(keep_entry.path.exists())
        self.assertFalse(other.path.exists())

    def test_default_spool_root_honors_xdg_runtime_dir(self):
        with mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": str(self.tmp)}):
            self.assertEqual(
                ab.default_spool_root(),
                self.tmp / "omarchy-audio-visualizer" / "artwork",
            )


# ---------------------------------------------------------------------------
# handle_request (protocol-level integration)
# ---------------------------------------------------------------------------

class TestHandleRequest(SpoolTestCase):
    URL = "https://cdn.example/albums/%s/cover.png" % SECRET_TOKEN

    @classmethod
    def setUpClass(cls):
        cls.cover = png_bytes((64, 48), (255, 0, 0))

    def setUp(self):
        super().setUp()
        self.spool = ab.ArtworkSpool(self.root())
        self.resolver = FakeResolver({"cdn.example": [PUBLIC_IP]})
        self.connector = FakeConnector(
            {
                "cdn.example": [
                    FakeResponse(
                        200, {"Content-Type": "image/png"}, self.cover
                    )
                ]
            },
            {"cdn.example": [PUBLIC_IP]},
        )

    def line(self, url=URL, req_id="req-42"):
        return json.dumps({"id": req_id, "url": url})

    def transport_for(self, ctype, body):
        resolver = FakeResolver({"cdn.example": [PUBLIC_IP]})
        connector = FakeConnector(
            {
                "cdn.example": [
                    FakeResponse(200, {"Content-Type": ctype}, body)
                ]
            },
            {"cdn.example": [PUBLIC_IP]},
        )
        return resolver, connector

    def test_success_result_shape_and_publication(self):
        result = ab.handle_request(
            self.line(),
            spool=self.spool,
            resolver=self.resolver,
            connector=self.connector,
        )
        self.assertIs(result["ok"], True)
        self.assertEqual(result["id"], "req-42")
        self.assertEqual(
            set(result),
            {"ok", "id", "path", "sha256", "bytes", "width", "height"},
        )
        canonical, width, height = ab.decode_to_png(self.cover, "image/png")
        self.assertEqual(
            result["sha256"], hashlib.sha256(canonical).hexdigest()
        )
        self.assertEqual(result["bytes"], len(canonical))
        self.assertEqual(
            (result["width"], result["height"]), (width, height)
        )
        path = pathlib.Path(result["path"])
        self.assertTrue(path.is_file())
        self.assertEqual(path.read_bytes(), canonical)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(len(self.spool.entries()), 1)

    def test_success_never_echoes_the_url(self):
        result = ab.handle_request(
            self.line(),
            spool=self.spool,
            resolver=self.resolver,
            connector=self.connector,
        )
        blob = json.dumps(result)
        self.assertNotIn("cdn.example", blob)
        self.assertNotIn(SECRET_TOKEN, blob)
        self.assertNotIn(self.URL, blob)

    def test_failure_result_shape_without_url(self):
        resolver = FakeResolver({"cdn.example": ["127.0.0.1"]})
        connector = FakeConnector({}, {})
        result = ab.handle_request(
            self.line(),
            spool=self.spool,
            resolver=resolver,
            connector=connector,
        )
        self.assertIs(result["ok"], False)
        self.assertEqual(result["id"], "req-42")
        self.assertEqual(set(result), {"ok", "id", "error"})
        self.assertEqual(set(result["error"]), {"code", "message"})
        self.assertEqual(result["error"]["code"], "bad_address")
        self.assertIsInstance(result["error"]["message"], str)
        self.assertTrue(result["error"]["message"])
        blob = json.dumps(result)
        self.assertNotIn("cdn.example", blob)
        self.assertNotIn(SECRET_TOKEN, blob)
        self.assertNotIn("127.0.0.1", blob)
        self.assertEqual(self.spool.entries(), [])

    def test_bad_request_line_maps_to_error(self):
        result = ab.handle_request(
            "not-json",
            spool=self.spool,
            resolver=self.resolver,
            connector=self.connector,
        )
        self.assertIs(result["ok"], False)
        self.assertEqual(result["error"]["code"], "bad_request")

    def test_mime_magic_mismatch_is_rejected(self):
        for declared, body in (
            ("image/png", jpeg_bytes((64, 48))),
            ("image/jpeg", png_bytes((64, 48))),
        ):
            with self.subTest(declared=declared):
                resolver, connector = self.transport_for(declared, body)
                result = ab.handle_request(
                    self.line(),
                    spool=self.spool,
                    resolver=resolver,
                    connector=connector,
                )
                self.assertIs(result["ok"], False)
                self.assertEqual(result["error"]["code"], "content_type")
                self.assertEqual(self.spool.entries(), [])

    def test_oversized_body_maps_to_error_and_publishes_nothing(self):
        body = b"\x89PNG" + b"z" * (ab.MAX_BODY_BYTES - 3)
        resolver, connector = self.transport_for("image/png", body)
        result = ab.handle_request(
            self.line(),
            spool=self.spool,
            resolver=resolver,
            connector=connector,
        )
        self.assertIs(result["ok"], False)
        self.assertEqual(result["error"]["code"], "too_large")
        self.assertEqual(self.spool.entries(), [])

    def test_oversized_image_maps_to_error_and_publishes_nothing(self):
        huge = png_bytes((3000, 64), (1, 2, 3))
        resolver, connector = self.transport_for("image/png", huge)
        result = ab.handle_request(
            self.line(),
            spool=self.spool,
            resolver=resolver,
            connector=connector,
        )
        self.assertIs(result["ok"], False)
        self.assertEqual(result["error"]["code"], "image_too_large")
        self.assertEqual(self.spool.entries(), [])


# ---------------------------------------------------------------------------
# main (one-shot stdio protocol)
# ---------------------------------------------------------------------------

class TestMain(SpoolTestCase):
    URL = "https://cdn.example/albums/%s/cover.png" % SECRET_TOKEN

    @classmethod
    def setUpClass(cls):
        cls.cover = png_bytes((96, 64), (0, 90, 160))

    def setUp(self):
        super().setUp()
        self.spool = ab.ArtworkSpool(self.root())
        self.resolver = FakeResolver({"cdn.example": [PUBLIC_IP]})
        self.connector = FakeConnector(
            {
                "cdn.example": [
                    FakeResponse(
                        200, {"Content-Type": "image/png"}, self.cover
                    )
                ]
            },
            {"cdn.example": [PUBLIC_IP]},
        )

    def request(self, url=URL, req_id="main-1"):
        return json.dumps({"id": req_id, "url": url}) + "\n"

    def run_main(self, stdin_text):
        stdin = io.StringIO(stdin_text)
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(sys, "stderr", stderr):
            rc = ab.main(
                stdin=stdin,
                stdout=stdout,
                resolver=self.resolver,
                connector=self.connector,
                spool=self.spool,
            )
        return rc, stdout.getvalue(), stderr.getvalue()

    def test_success_writes_exactly_one_bounded_json_line(self):
        rc, out, err = self.run_main(self.request())
        self.assertEqual(rc, 0)
        lines = out.splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(out.endswith("\n"))
        self.assertLessEqual(len(out.encode()), 4096)
        result = json.loads(lines[0])
        self.assertIs(result["ok"], True)
        self.assertEqual(result["id"], "main-1")
        self.assertEqual(
            set(result),
            {"ok", "id", "path", "sha256", "bytes", "width", "height"},
        )
        self.assertTrue(pathlib.Path(result["path"]).is_file())
        self.assertNotIn("cdn.example", out)
        self.assertNotIn(SECRET_TOKEN, out)
        self.assertEqual(err, "")

    def test_only_the_first_line_is_processed(self):
        stdin = self.request(req_id="first") + self.request(req_id="second")
        rc, out, _ = self.run_main(stdin)
        self.assertEqual(rc, 0)
        result = json.loads(out.strip())
        self.assertEqual(result["id"], "first")

    def test_handled_error_returns_nonzero_without_stderr_noise(self):
        self.resolver = FakeResolver({"cdn.example": ["10.0.0.7"]})
        self.connector = FakeConnector({}, {})
        rc, out, err = self.run_main(self.request())
        self.assertEqual(rc, 1)
        lines = out.splitlines()
        self.assertEqual(len(lines), 1)
        result = json.loads(lines[0])
        self.assertIs(result["ok"], False)
        self.assertEqual(result["id"], "main-1")
        self.assertEqual(result["error"]["code"], "bad_address")
        self.assertNotIn("cdn.example", out)
        self.assertNotIn(SECRET_TOKEN, out)
        self.assertNotIn("10.0.0.7", out)
        self.assertEqual(err, "")

    def test_oversized_request_line(self):
        line = (
            json.dumps({"id": "big", "url": "https://cdn.example/a.png"})
            + " " * 5000
            + "\n"
        )
        rc, out, _ = self.run_main(line)
        self.assertEqual(rc, 1)
        result = json.loads(out.strip())
        self.assertIs(result["ok"], False)
        self.assertEqual(result["error"]["code"], "request_too_long")

    def test_garbage_request_line(self):
        rc, out, _ = self.run_main("this is not json\n")
        self.assertEqual(rc, 1)
        result = json.loads(out.strip())
        self.assertIs(result["ok"], False)
        self.assertEqual(result["error"]["code"], "bad_request")

    def test_empty_stdin_is_a_handled_error(self):
        rc, out, err = self.run_main("")
        self.assertEqual(rc, 1)
        result = json.loads(out.strip())
        self.assertIs(result["ok"], False)
        self.assertEqual(result["error"]["code"], "bad_request")
        self.assertEqual(err, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)

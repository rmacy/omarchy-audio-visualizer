#!/usr/bin/env python3
"""Short-lived artwork broker for the omarchy Audio Visualizer plugin.

One-shot stdio protocol (version 1.5.0): a single JSON line
``{"id": <str|int>, "url": <https-url>}`` (<= 4096 bytes) is read from
stdin and a single bounded JSON result line is written to stdout.  The
request URL is never echoed in results, messages, or stderr.

The broker fetches MPRIS artwork from an HTTPS origin while pinning every
connection to a pre-vetted global numeric address (SSRF hardening), decodes
the image with Pillow into a metadata-free canonical PNG (<= 512 px), and
publishes it content-addressed into a private runtime spool
(``$XDG_RUNTIME_DIR/omarchy-audio-visualizer/artwork``) that is capped at
16 regular files / 16 MiB.

Runtime: ``/usr/bin/python3 -I -B artwork_broker.py`` with the Arch
``python-pillow`` package.  Only the standard library plus Pillow is used.
``urllib.parse`` is imported solely for URL parsing/joining helpers —
``urllib.request`` is never used, so there is no auto-redirect following,
no proxy-environment handling, no shell, and no external network binary.
"""

from __future__ import annotations

import hashlib
import http.client
import io
import ipaddress
import json
import os
import pathlib
import re
import socket
import ssl
import stat
import sys
import tempfile
import time
import warnings
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence
from urllib.parse import urljoin, urlsplit

from PIL import Image, ImageOps

# --------------------------------------------------------------------------
# Review-visible contract constants
# --------------------------------------------------------------------------

BROKER_VERSION = "1.5.0"

#: Maximum size of the request line read from stdin (bytes).
MAX_REQUEST_BYTES = 4096
#: Maximum UTF-8 encoded length of the request URL (bytes).
MAX_URL_BYTES = 2048
#: Maximum accepted artwork body size (bytes); the reader always asks for
#: one extra byte so a body of exactly MAX_BODY_BYTES + 1 is detected.
MAX_BODY_BYTES = 2 * 1024 * 1024
#: Total wall-clock budget for one request across every hop (seconds).
MAX_TOTAL_SECONDS = 10.0
#: Per-operation (connect/read slice) timeout (seconds).
SLICE_SECONDS = 3.0
#: Maximum number of revalidated redirect hops.
MAX_REDIRECTS = 3
#: Maximum decoded image dimension on either side (pixels).
MAX_IMAGE_SIDE = 2048
#: Maximum decoded image area (pixels).
MAX_IMAGE_PIXELS = 4_194_304
#: Longest edge of the reencoded canonical thumbnail (pixels).
THUMBNAIL_LIMIT = 512
#: Spool directory mode (owner-only).
SPOOL_DIR_MODE = 0o700
#: Spool file mode (owner-only).
SPOOL_FILE_MODE = 0o600
#: Spool capacity: maximum number of regular files kept.
SPOOL_MAX_FILES = 16
#: Spool capacity: maximum total bytes kept.
SPOOL_MAX_BYTES = 16 * 1024 * 1024

_READ_CHUNK = 64 * 1024
_SPOOL_NAME_RE = re.compile(r"[0-9a-f]{64}\.png\Z")
_LABEL_RE = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?\Z")
_BAD_ESCAPE_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")

# Network ranges that are never acceptable fetch targets regardless of what
# the platform `ipaddress` flags say (covers versions whose `is_global`
# disagreed about CGNAT/NAT64).  Any address outside these lists must still
# report `is_global` to be accepted.
_REJECT_V4 = tuple(ipaddress.ip_network(n) for n in (
    "0.0.0.0/8",        # "this network" / unspecified
    "10.0.0.0/8",       # private
    "100.64.0.0/10",    # CGNAT
    "127.0.0.0/8",      # loopback
    "169.254.0.0/16",   # link-local
    "172.16.0.0/12",    # private
    "192.0.0.0/24",     # IETF protocol assignments
    "192.0.2.0/24",     # documentation (TEST-NET-1)
    "192.88.99.0/24",   # 6to4 relay anycast (reserved)
    "192.168.0.0/16",   # private
    "198.18.0.0/15",    # benchmarking
    "198.51.100.0/24",  # documentation (TEST-NET-2)
    "203.0.113.0/24",   # documentation (TEST-NET-3)
    "224.0.0.0/4",      # multicast
    "240.0.0.0/4",      # reserved (incl. 255.255.255.255)
))
_REJECT_V6 = tuple(ipaddress.ip_network(n) for n in (
    "::/128",           # unspecified
    "::1/128",          # loopback
    "::ffff:0:0/96",    # IPv4-mapped (always rejected)
    "64:ff9b::/96",     # NAT64 (well-known prefix)
    "64:ff9b:1::/48",   # NAT64 (local-use prefix, reserved)
    "100::/64",         # discard-only
    "2001:db8::/32",    # documentation
    "fc00::/7",         # unique-local
    "fe80::/10",        # link-local
    "ff00::/8",         # multicast
))

# Pillow's own decompression-bomb guard is aligned with the broker limit so
# oversized headers never allocate; its warning (which would hit stderr) is
# silenced and its error is mapped to a stable broker code instead.
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
warnings.simplefilter("ignore", Image.DecompressionBombWarning)


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


class BrokerError(Exception):
    """Broker failure with a stable machine-readable code.

    The message is safe to emit: it never contains the request URL.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


# --------------------------------------------------------------------------
# Request parsing and URL normalization
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ParsedURL:
    """Normalized absolute HTTPS URL with an effective port of 443."""

    scheme: str
    host: str
    port: int
    path: str
    query: str

    def display_host(self) -> str:
        """Host as it appears in a URL or Host header (bracketed IPv6)."""
        return f"[{self.host}]" if ":" in self.host else self.host

    def url(self) -> str:
        return f"https://{self.display_host()}{self.path}{self.query}"

    def origin_key(self) -> str:
        """Redirect-loop identity: scheme, host, port, path, query."""
        return f"{self.scheme}|{self.host}|{self.port}|{self.path}|{self.query}"


def parse_request(line: "str | bytes") -> dict:
    """Parse and schema-check the single stdin request line.

    Accepts exactly one JSON object ``{"id": <non-empty str or int>,
    "url": <str>}``.  Raises ``BrokerError`` on any deviation.
    """
    if isinstance(line, bytes):
        raw = line
    else:
        try:
            raw = line.encode("utf-8", "strict")
        except UnicodeEncodeError:
            raise BrokerError("bad_request", "request is not valid UTF-8")
    if len(raw) > MAX_REQUEST_BYTES:
        raise BrokerError("request_too_long",
                          "request line exceeds 4096 bytes")
    try:
        obj = json.loads(raw.decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BrokerError("bad_request", "request is not valid JSON")
    if not isinstance(obj, dict) or set(obj) != {"id", "url"}:
        raise BrokerError("bad_request",
                          'request must be an object with keys "id" and "url"')
    rid, url = obj["id"], obj["url"]
    if isinstance(rid, bool) or not isinstance(rid, (str, int)):
        raise BrokerError("bad_request", "id must be a string or an integer")
    if isinstance(rid, str) and not rid:
        raise BrokerError("bad_request", "id must not be empty")
    if not isinstance(url, str):
        raise BrokerError("bad_request", "url must be a string")
    return {"id": rid, "url": url}


def _validate_port(port_text: str) -> None:
    if not port_text.isdigit():
        raise BrokerError("bad_url", "malformed port in URL authority")
    port = int(port_text)
    if not 1 <= port <= 65535:
        raise BrokerError("bad_url", "port out of range in URL authority")
    if port != 443:
        raise BrokerError("bad_url", "only port 443 is accepted")


def _normalize_hostname(host_raw: str) -> str:
    """Validate and normalize a URL hostname (lowercase, IDNA ascii)."""
    if not host_raw:
        raise BrokerError("bad_url", "URL has no host")
    host = host_raw.lower()
    if host.endswith("."):
        host = host[:-1]
        if not host:
            raise BrokerError("bad_url", "URL has no host")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        # IP-literal host (zone IDs were rejected during authority parsing);
        # return the canonical compressed form.
        return str(literal)
    if "%" in host:
        raise BrokerError("bad_url", "invalid characters in URL host")
    if not host.isascii():
        try:
            host = host.encode("idna").decode("ascii").lower()
        except (UnicodeError, ValueError):
            raise BrokerError("bad_url", "URL host is not a valid IDNA name")
    if len(host) > 253:
        raise BrokerError("bad_url", "URL host is too long")
    for label in host.split("."):
        if not label or len(label) > 63 or not _LABEL_RE.match(label):
            raise BrokerError("bad_url", "URL host contains an invalid label")
    return host


def normalize_url(url: str) -> ParsedURL:
    """Validate a URL and return its normalized HTTPS form.

    Enforces: absolute https, effective port 443 (explicit ``:443`` allowed),
    no userinfo, no fragment, no IPv6 zone IDs, well-formed host labels
    (IDNA for non-ASCII), ASCII path/query with valid percent-escapes.
    """
    try:
        encoded_len = len(url.encode("utf-8", "strict"))
    except UnicodeEncodeError:
        raise BrokerError("bad_url", "URL is not encodable as UTF-8")
    if encoded_len > MAX_URL_BYTES:
        raise BrokerError("url_too_long", "URL exceeds 2048 bytes")
    if any(ord(ch) <= 0x20 or ord(ch) == 0x7F for ch in url):
        raise BrokerError("bad_url", "URL contains whitespace or control characters")

    parts = urlsplit(url)
    if parts.scheme.lower() != "https" or not parts.netloc:
        raise BrokerError("bad_url", "only absolute https URLs are accepted")
    if "#" in url:
        raise BrokerError("bad_url", "URL fragments are not accepted")

    netloc = parts.netloc
    if "@" in netloc:
        raise BrokerError("bad_url", "userinfo is not accepted in URLs")
    if netloc.startswith("["):
        end = netloc.find("]")
        if end == -1:
            raise BrokerError("bad_url", "malformed IPv6 literal in URL authority")
        host_raw = netloc[1:end]
        rest = netloc[end + 1:]
        if rest:
            if not rest.startswith(":") or len(rest) == 1:
                raise BrokerError("bad_url", "malformed port in URL authority")
            _validate_port(rest[1:])
        if "%" in host_raw:
            raise BrokerError("bad_url", "IPv6 zone IDs are not accepted")
    else:
        if netloc.count(":") > 1:
            raise BrokerError("bad_url", "malformed authority in URL")
        if ":" in netloc:
            host_raw, _, port_text = netloc.rpartition(":")
            if not port_text:
                raise BrokerError("bad_url", "malformed port in URL authority")
            _validate_port(port_text)
        else:
            host_raw = netloc

    host = _normalize_hostname(host_raw)

    path = parts.path or "/"
    if not path.startswith("/"):
        raise BrokerError("bad_url", "URL path must be absolute")
    query = f"?{parts.query}" if parts.query else ""
    request_target = path + query
    if not request_target.isascii():
        raise BrokerError("bad_url", "URL path and query must be ASCII")
    if _BAD_ESCAPE_RE.search(request_target):
        raise BrokerError("bad_url", "URL contains a malformed percent-escape")

    return ParsedURL(scheme="https", host=host, port=443, path=path, query=query)


# --------------------------------------------------------------------------
# Address vetting and resolution
# --------------------------------------------------------------------------


def vet_address(addr: str):
    """Return the parsed address if it is a global unicast IP, else raise.

    Every address in a DNS answer set must pass this check: one bad answer
    rejects the whole set (defeats mixed-answer DNS rebinding).
    """
    try:
        ip = ipaddress.ip_address(addr)
    except (ValueError, TypeError):
        raise BrokerError("bad_address", "resolver returned a malformed address")
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            raise BrokerError("bad_address",
                              "IPv4-mapped IPv6 addresses are not accepted")
        rejected = any(ip in net for net in _REJECT_V6)
    else:
        rejected = any(ip in net for net in _REJECT_V4)
    if rejected or not ip.is_global or ip.is_private or ip.is_loopback \
            or ip.is_link_local or ip.is_multicast or ip.is_reserved \
            or ip.is_unspecified:
        raise BrokerError("bad_address", "resolver returned a non-global address")
    return ip


def validate_answer_set(addrs: Iterable[str]) -> list:
    """Vet every address in a DNS answer set; all-or-nothing."""
    vetted: list = []
    seen = set()
    for addr in addrs:
        ip = vet_address(addr)  # raises on the first non-global answer
        if ip not in seen:
            seen.add(ip)
            vetted.append(ip)
    if not vetted:
        raise BrokerError("dns_failure", "host resolved to no addresses")
    return vetted


def default_resolver(host: str) -> list:
    """Resolve a hostname once via getaddrinfo and return its addresses."""
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, OSError):
        raise BrokerError("dns_failure", "host resolution failed")
    return [info[4][0] for info in infos]


def default_ssl_context() -> ssl.SSLContext:
    """Certificate-verifying client context (no proxy, no relaxation)."""
    return ssl.create_default_context()


# --------------------------------------------------------------------------
# Pinned HTTPS transport
# --------------------------------------------------------------------------


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection whose socket dials a vetted numeric IP while TLS
    SNI and certificate/Host identity keep using the normalized hostname."""

    def __init__(self, host: str, port: int = 443, *, pinned_ip: str,
                 timeout: float = SLICE_SECONDS,
                 context: "ssl.SSLContext | None" = None) -> None:
        super().__init__(host, port=port, timeout=timeout,
                         context=context or default_ssl_context())
        self._pinned_ip = pinned_ip

    def connect(self) -> None:
        family = socket.AF_INET6 if ":" in self._pinned_ip else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect((self._pinned_ip, self.port))
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            # server_hostname drives SNI and peer-certificate verification.
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except Exception:
            sock.close()
            self.sock = None
            raise


def default_connector(host: str, ip: str, port: int, timeout: float):
    """Default transport factory: pinned HTTPS to one vetted address."""
    return PinnedHTTPSConnection(host, port=port, pinned_ip=ip, timeout=timeout)


def read_bounded(resp: http.client.HTTPResponse, max_bytes: int, *,
                 sock: "socket.socket | None" = None,
                 clock: "Callable[[], float] | None" = None,
                 deadline: "float | None" = None,
                 slice_timeout: float = SLICE_SECONDS) -> bytes:
    """Stream a response body, always reading up to max_bytes + 1 so an
    overflowing body is detected, under the deadline and read slice.

    The response socket is taken from ``sock`` when given (http.client
    responses do not reliably expose one) and each read slice re-arms its
    timeout.
    """
    clock = clock or time.monotonic
    cap = max_bytes + 1
    chunks: list = []
    total = 0
    while total < cap:
        if deadline is not None:
            remaining = deadline - clock()
            if remaining <= 0:
                raise BrokerError("timeout", "artwork fetch exceeded its deadline")
            sock_timeout = min(slice_timeout, remaining)
        else:
            sock_timeout = slice_timeout
        target = sock if sock is not None else getattr(resp, "sock", None)
        if target is not None:
            target.settimeout(sock_timeout)
        read_started = clock()
        try:
            chunk = resp.read(min(_READ_CHUNK, cap - total))
        except (socket.timeout, TimeoutError):
            raise BrokerError("timeout", "artwork body read timed out")
        except OSError:
            raise BrokerError("connect_failed",
                              "connection error while reading body")
        if clock() - read_started > sock_timeout:
            raise BrokerError("timeout", "artwork body read timed out")
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if deadline is not None and deadline - clock() <= 0:
            raise BrokerError("timeout", "artwork fetch exceeded its deadline")
    body = b"".join(chunks)
    if len(body) > max_bytes:
        raise BrokerError("too_large", "artwork exceeds the 2 MiB size limit")
    return body


@dataclass(frozen=True)
class Limits:
    """Tunable fetch limits (injectable for tests)."""

    max_body_bytes: int = MAX_BODY_BYTES
    total_deadline: float = MAX_TOTAL_SECONDS
    slice_timeout: float = SLICE_SECONDS
    max_redirects: int = MAX_REDIRECTS


_REDIRECT_STATUSES = frozenset((301, 302, 303, 307, 308))


def fetch_artwork(parsed: ParsedURL, *,
                  resolver: "Callable[[str], list] | None" = None,
                  connector=None,
                  clock: "Callable[[], float] | None" = None,
                  limits: "Limits | None" = None) -> tuple:
    """Fetch the artwork body over pinned HTTPS.

    Each hop is resolved exactly once and every answer must be global.
    Redirects are followed manually (never by urllib) and revalidated.
    Returns ``(body, content_type)``.
    """
    resolver = resolver or default_resolver
    connector = connector or default_connector
    clock = clock or time.monotonic
    limits = limits or Limits()
    deadline = clock() + limits.total_deadline

    current = parsed
    seen = {current.origin_key()}
    redirects = 0
    while True:
        remaining = deadline - clock()
        if remaining <= 0:
            raise BrokerError("timeout", "artwork fetch exceeded its deadline")
        try:
            addresses = validate_answer_set(resolver(current.host))
        except BrokerError:
            raise
        except (socket.gaierror, OSError, UnicodeError):
            raise BrokerError("dns_failure", "host resolution failed")

        conn = None
        last_errno: "int | None" = None
        for ip in addresses:
            remaining = deadline - clock()
            if remaining <= 0:
                raise BrokerError("timeout", "artwork fetch exceeded its deadline")
            slice_timeout = min(limits.slice_timeout, remaining)
            candidate = None
            try:
                candidate = connector(current.host, str(ip), current.port,
                                      slice_timeout)
                candidate.request(
                    "GET",
                    current.path + current.query,
                    headers={
                        "Host": current.display_host(),
                        "User-Agent":
                            f"omarchy-audio-visualizer-artwork-broker/{BROKER_VERSION}",
                        "Accept": "image/png, image/jpeg",
                        "Accept-Encoding": "identity",
                        "Connection": "close",
                    },
                )
                conn = candidate
                break
            except BrokerError:
                raise
            except (socket.timeout, TimeoutError):
                raise BrokerError("timeout", "artwork connection timed out")
            except ssl.SSLError:
                raise BrokerError("tls_failed",
                                  "TLS handshake or verification failed")
            except OSError as exc:
                last_errno = exc.errno
                if candidate is not None:
                    try:
                        candidate.close()
                    except OSError:
                        pass
                if deadline - clock() <= 0:
                    raise BrokerError("timeout",
                                      "artwork fetch exceeded its deadline")
                continue
        if conn is None:
            detail = f" (errno {last_errno})" if last_errno is not None else ""
            raise BrokerError("connect_failed",
                              f"could not connect to origin{detail}")

        try:
            resp = conn.getresponse()
        except (socket.timeout, TimeoutError):
            raise BrokerError("timeout", "artwork response timed out")
        except ssl.SSLError:
            raise BrokerError("tls_failed", "TLS failure while reading response")
        except OSError as exc:
            raise BrokerError(
                "connect_failed",
                f"connection error while awaiting response (errno {exc.errno})")
        if deadline - clock() <= 0:
            raise BrokerError("timeout", "artwork fetch exceeded its deadline")

        status = resp.status
        if status == 200:
            content_type = (resp.getheader("Content-Type") or "").split(";")[0]
            content_type = content_type.strip().lower()
            if content_type not in ("image/png", "image/jpeg"):
                raise BrokerError("content_type",
                                  "origin did not serve image/png or image/jpeg")
            encoding = (resp.getheader("Content-Encoding") or "").strip().lower()
            if encoding not in ("", "identity"):
                raise BrokerError("content_encoding",
                                  "only identity content encoding is accepted")
            declared_length = resp.getheader("Content-Length")
            if declared_length is not None:
                value = declared_length.strip()
                if not value.isdigit() or int(value) > limits.max_body_bytes:
                    raise BrokerError("too_large",
                                      "artwork content length exceeds its limit")
            body = read_bounded(resp, limits.max_body_bytes,
                                sock=getattr(conn, "sock", None),
                                clock=clock, deadline=deadline,
                                slice_timeout=limits.slice_timeout)
            conn.close()
            return body, content_type

        if status in _REDIRECT_STATUSES:
            redirects += 1
            if redirects > limits.max_redirects:
                raise BrokerError("redirect_limit",
                                  "more than 3 redirect hops for one artwork")
            location = resp.getheader("Location")
            conn.close()
            if not location:
                raise BrokerError("redirect_invalid",
                                  "redirect without a Location header")
            try:
                target = normalize_url(urljoin(current.url(), location))
            except BrokerError as exc:
                raise BrokerError("redirect_invalid", exc.message)
            key = target.origin_key()
            if key in seen:
                raise BrokerError("redirect_loop",
                                  "redirect chain revisited a URL")
            seen.add(key)
            current = target
            continue

        raise BrokerError("http_status", f"origin returned HTTP {status}")


# --------------------------------------------------------------------------
# Pillow decode and canonical PNG reencode
# --------------------------------------------------------------------------
_FORMAT_BY_CONTENT_TYPE = {"image/png": "PNG", "image/jpeg": "JPEG"}

def decode_to_png(data: bytes,
                  expected_content_type: "str | None" = None) -> tuple:
    """Decode raw artwork bytes into a canonical metadata-free PNG.

    Rejects animations, malformed images, and images larger than 2048 px on
    a side or 4,194,304 px in area.  When ``expected_content_type`` is the
    media type served by the origin (``image/png`` or ``image/jpeg``), the
    sniffed container format must match it exactly.  The decoded image is
    EXIF-transposed, converted to RGB/RGBA, thumbnailed to at most 512 px
    on a side, and reencoded as PNG without any metadata.  Returns
    ``(png_bytes, width, height)``.
    """
    try:
        with Image.open(io.BytesIO(data)) as probe:
            if getattr(probe, "is_animated", False) or getattr(probe, "n_frames", 1) > 1:
                raise BrokerError("animated_image",
                                  "animated artwork is not accepted")
            width, height = probe.size
            if (width > MAX_IMAGE_SIDE or height > MAX_IMAGE_SIDE
                    or width * height > MAX_IMAGE_PIXELS):
                raise BrokerError("image_too_large",
                                  f"artwork decode limit exceeded ({width}x{height})")
            if probe.format not in ("PNG", "JPEG"):
                raise BrokerError("decode_failed", "artwork is not PNG or JPEG data")
            if (expected_content_type is not None
                    and probe.format != _FORMAT_BY_CONTENT_TYPE.get(
                        expected_content_type)):
                raise BrokerError(
                    "content_type",
                    "origin content type does not match the artwork data")
            probe.verify()
    except BrokerError:
        raise
    except Image.DecompressionBombError:
        raise BrokerError("image_too_large", "artwork decode limit exceeded")
    except Exception:
        raise BrokerError("decode_failed", "artwork data is malformed")

    # verify() invalidates the handle: reopen for the actual decode.
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            image = ImageOps.exif_transpose(image)
            has_alpha = image.mode in ("RGBA", "LA", "PA") or (
                image.mode == "P" and "transparency" in image.info)
            canvas = image.convert("RGBA" if has_alpha else "RGB")
            canvas.thumbnail((THUMBNAIL_LIMIT, THUMBNAIL_LIMIT),
                             Image.Resampling.LANCZOS)
            canvas.info = {}  # drop ICC/EXIF/text chunks: canonical reencode only
            buffer = io.BytesIO()
            canvas.save(buffer, format="PNG")
            png = buffer.getvalue()
            out_w, out_h = canvas.width, canvas.height
    except BrokerError:
        raise
    except Image.DecompressionBombError:
        raise BrokerError("image_too_large", "artwork decode limit exceeded")
    except Exception:
        raise BrokerError("decode_failed", "artwork decode failed")
    return png, out_w, out_h


# --------------------------------------------------------------------------
# Spool: content-addressed publication with capacity eviction
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class SpoolEntry:
    """One published spool file (content-addressed by PNG digest)."""

    path: pathlib.Path
    sha256: str
    size: int

    @property
    def file_url(self) -> str:
        return self.path.as_uri()


class ArtworkSpool:
    """Owner-only artwork cache rooted at a 0700 runtime directory.

    Files are published atomically via ``mkstemp`` + hard link so a symlink
    planted at a target name can never be followed, and capacity
    (16 regular files / 16 MiB) is enforced by evicting oldest first.
    """

    def __init__(self, root: "os.PathLike[str] | str", *,
                 max_files: int = SPOOL_MAX_FILES,
                 max_bytes: int = SPOOL_MAX_BYTES) -> None:
        self.root = pathlib.Path(root)
        self.max_files = max_files
        self.max_bytes = max_bytes

    def _verify_ancestors(self) -> None:
        """Every existing component above the spool must be a real
        directory (lstat: no symlinks anywhere in the path chain)."""
        for ancestor in reversed(self.root.parents):
            try:
                info = ancestor.lstat()
            except FileNotFoundError:
                continue  # created (and hardened) by ensure_root below
            except OSError as exc:
                raise BrokerError(
                    "spool_error",
                    f"spool path component unavailable (errno {exc.errno})")
            if not stat.S_ISDIR(info.st_mode):
                raise BrokerError(
                    "spool_error",
                    "spool path traverses a symlink or non-directory")

    def _harden_directory(self, path: pathlib.Path) -> None:
        """Open without following symlinks, assert ownership, force 0700."""
        try:
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError as exc:
            raise BrokerError("spool_error",
                              f"spool directory unavailable (errno {exc.errno})")
        try:
            info = os.fstat(fd)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
                raise BrokerError("spool_error",
                                  "spool directory is not a user-owned directory")
            os.fchmod(fd, SPOOL_DIR_MODE)
        finally:
            os.close(fd)

    def ensure_root(self) -> pathlib.Path:
        """Create/verify the spool directory chain (0700, real dirs, ours).

        Existing ancestors are checked to be non-symlink directories;
        missing components are created one level at a time, each opened
        with O_NOFOLLOW, ownership-verified, and forced to 0700 — so a
        symlink planted at an intermediate level is never traversed.
        """
        self._verify_ancestors()
        missing = []
        probe = self.root
        while True:
            try:
                probe.lstat()
                break
            except FileNotFoundError:
                missing.append(probe)
            except OSError as exc:
                raise BrokerError(
                    "spool_error",
                    f"spool directory unavailable (errno {exc.errno})")
            parent = probe.parent
            if parent == probe:
                break
            probe = parent
        for path in reversed(missing):
            try:
                os.mkdir(path, SPOOL_DIR_MODE)
            except FileExistsError:
                pass
            except OSError as exc:
                raise BrokerError(
                    "spool_error",
                    f"spool directory unavailable (errno {exc.errno})")
            self._harden_directory(path)
        self._harden_directory(self.root)
        return self.root

    def _cached_file_ok(self, final: pathlib.Path, png: bytes,
                        digest: str) -> bool:
        """A cached file is reusable only after an ``O_NOFOLLOW`` open and
        an ``fstat`` of the opened descriptor prove a regular file we own;
        mode 0600 is forced on the descriptor itself and the content must
        still hash to its name.

        The leading ``lstat`` is an untrusted pre-filter only — it keeps a
        planted FIFO from blocking ``open()`` — never the basis of the
        decision.
        """
        try:
            info = final.lstat()
        except OSError:
            return False
        if not stat.S_ISREG(info.st_mode):
            return False
        try:
            fd = os.open(final, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            return False
        data = bytearray()
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.geteuid():
                return False
            os.fchmod(fd, SPOOL_FILE_MODE)
            while True:
                chunk = os.read(fd, _READ_CHUNK)
                if not chunk:
                    break
                data += chunk
        except OSError:
            return False
        finally:
            os.close(fd)
        return (len(data) == len(png)
                and hashlib.sha256(bytes(data)).hexdigest() == digest)

    def publish(self, png: bytes) -> SpoolEntry:
        """Atomically publish a canonical PNG, deduped by content hash."""
        self.ensure_root()
        digest = hashlib.sha256(png).hexdigest()
        final = self.root / f"{digest}.png"

        if not self._cached_file_ok(final, png, digest):
            try:
                # clear whatever sits at the target name (corrupt file,
                # stale symlink, socket, ...); unlink never follows a
                # symlink.
                try:
                    os.unlink(final)
                except FileNotFoundError:
                    pass
                fd, temp_name = tempfile.mkstemp(dir=self.root,
                                                 prefix=".pending-",
                                                 suffix=".tmp")
                try:
                    with os.fdopen(fd, "wb") as handle:
                        handle.write(png)
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.chmod(temp_name, SPOOL_FILE_MODE)
                    try:
                        os.link(temp_name, final)  # atomic; never follows
                    except FileExistsError:
                        # Another publisher won the name.  Reuse its file
                        # only if it verifies; otherwise replace it and
                        # link once more.  An unverified collision target
                        # is never returned.
                        if not self._cached_file_ok(final, png, digest):
                            try:
                                os.unlink(final)  # may already be gone
                            except FileNotFoundError:
                                pass
                            os.link(temp_name, final)
                finally:
                    try:
                        os.unlink(temp_name)
                    except FileNotFoundError:
                        pass
            except FileExistsError:
                # the retry link lost yet another race
                raise BrokerError("spool_error",
                                  "spool publication lost a link race")
            except OSError as exc:
                raise BrokerError(
                    "spool_error",
                    f"spool publication failed (errno {exc.errno})")

        entry = SpoolEntry(final, digest, len(png))
        self.enforce_limits(keep=final)
        return entry

    def _inventory(self) -> list:
        """(mtime_ns, name, size, path) for regular files in the spool."""
        items = []
        try:
            names = os.listdir(self.root)
        except FileNotFoundError:
            return []
        for name in names:
            path = self.root / name
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISREG(info.st_mode):
                items.append((info.st_mtime_ns, name, info.st_size, path))
            elif name.startswith(".pending-"):
                try:
                    os.unlink(path)  # stale temp from an interrupted publish
                except FileNotFoundError:
                    pass
        return items

    def enforce_limits(self, keep: "pathlib.Path | None" = None) -> None:
        """Evict oldest entries until the file-count and byte caps hold."""
        items = self._inventory()
        count = len(items)
        total = sum(item[2] for item in items)
        if count <= self.max_files and total <= self.max_bytes:
            return
        items.sort(key=lambda item: (item[0], item[1]))
        for _, _, size, path in items:
            if count <= self.max_files and total <= self.max_bytes:
                break
            if keep is not None and path == pathlib.Path(keep):
                continue
            try:
                os.unlink(path)
                count -= 1
                total -= size
            except FileNotFoundError:
                pass

    def entries(self) -> list:
        """Published entries, oldest first (eviction order)."""
        found = []
        for mtime_ns, name, size, path in self._inventory():
            if _SPOOL_NAME_RE.match(name):
                found.append((mtime_ns, SpoolEntry(path, name[:-4], size)))
        found.sort(key=lambda pair: (pair[0], pair[1].path.name))
        return [entry for _, entry in found]


def default_spool_root() -> pathlib.Path:
    """Spool location under the user's runtime directory."""
    base = os.environ.get("XDG_RUNTIME_DIR", "")
    if not base or not os.path.isabs(base):
        raise BrokerError("spool_error",
                          "XDG_RUNTIME_DIR must be set to an absolute path")
    return pathlib.Path(base) / "omarchy-audio-visualizer" / "artwork"


# --------------------------------------------------------------------------
# One-shot request handling and entry point
# --------------------------------------------------------------------------


def handle_request(line: "str | bytes", *, spool: ArtworkSpool,
                   resolver: "Callable[[str], list] | None" = None,
                   connector=None,
                   clock: "Callable[[], float] | None" = None,
                   limits: "Limits | None" = None) -> dict:
    """Run one request end-to-end and return the JSON-serializable result."""
    try:
        request = parse_request(line)
    except BrokerError as exc:
        return {"ok": False, "id": None,
                "error": {"code": exc.code, "message": exc.message}}
    rid = request["id"]
    try:
        parsed = normalize_url(request["url"])
        body, content_type = fetch_artwork(parsed, resolver=resolver,
                                           connector=connector, clock=clock,
                                           limits=limits)
        png, width, height = decode_to_png(body, content_type)
        entry = spool.publish(png)
    except BrokerError as exc:
        return {"ok": False, "id": rid,
                "error": {"code": exc.code, "message": exc.message}}
    except Exception as exc:  # never leak URL material in messages
        return {"ok": False, "id": rid,
                "error": {"code": "internal_error",
                          "message": f"unexpected broker failure "
                                     f"({type(exc).__name__})"}}
    return {"ok": True, "id": rid, "path": str(entry.path),
            "sha256": entry.sha256, "bytes": entry.size,
            "width": width, "height": height}


def main(argv: "Sequence[str] | None" = None, *,
         stdin=None, stdout=None,
         clock: "Callable[[], float] | None" = None,
         resolver: "Callable[[str], list] | None" = None,
         connector=None,
         spool: "ArtworkSpool | None" = None) -> int:
    """One-shot stdio entry point.  Returns 0 on success, 1 on a handled
    error result."""
    del argv  # no options: the protocol is a single request line

    source = stdin if stdin is not None else sys.stdin
    binary_in = getattr(source, "buffer", source)
    raw = binary_in.readline(MAX_REQUEST_BYTES + 1)
    if isinstance(raw, str):
        raw = raw.encode("utf-8", "strict")
    line = raw.rstrip(b"\r\n")

    target = stdout if stdout is not None else sys.stdout
    binary_out = getattr(target, "buffer", target)

    def emit(result: dict) -> int:
        payload = json.dumps(result, ensure_ascii=True,
                             separators=(",", ":")) + "\n"
        try:
            binary_out.write(payload.encode("utf-8"))
        except (TypeError, ValueError):
            binary_out.write(payload)  # text-only stream (tests)
        binary_out.flush()
        return 0 if result.get("ok") else 1

    try:
        spool_obj = spool or ArtworkSpool(default_spool_root())
    except BrokerError as exc:
        return emit({"ok": False, "id": None,
                     "error": {"code": exc.code, "message": exc.message}})

    return emit(handle_request(line, spool=spool_obj, resolver=resolver,
                               connector=connector, clock=clock))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

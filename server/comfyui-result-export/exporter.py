import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import socket
import stat
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlsplit


MAX_BODY_BYTES = 64 * 1024
CHUNK_BYTES = 1024 * 1024
TIMEOUT_SECONDS = 600
DESCRIBE_TIMEOUT_SECONDS = 60
OUTPUT_KEYS = {"filename", "subfolder", "type", "nodeId"}
REQUIRED_HEADERS = {"content-type", "content-md5", "x-tos-meta-sha256", "x-tos-acl"}
TOS_HOST = re.compile(
    r"(?=.{1,253}\Z)[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])"
    r"\.tos-[a-z0-9]+(?:-[a-z0-9]+)*\.volces\.com\Z"
)
IDENTIFIER = re.compile(r"[A-Za-z0-9_.:-]{1,256}\Z")


class ExportError(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code = code
        self.status = status


def now_ms():
    return int(time.time() * 1000)


def validate_expiry(payload, current_ms=None):
    current_ms = now_ms() if current_ms is None else current_ms
    expires = payload.get("expiresAt")
    if type(expires) is not int or not current_ms < expires <= current_ms + 120_000:
        raise ExportError("INVALID_EXPIRY")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ExportError("INVALID_JSON")
        result[key] = value
    return result


def invalid_constant(_value):
    raise ExportError("INVALID_JSON")


def authenticate(raw, signature, secret, current_ms=None):
    if not isinstance(secret, bytes) or len(secret) < 32:
        raise ExportError("NOT_CONFIGURED", 503)
    if len(raw) > MAX_BODY_BYTES:
        raise ExportError("BODY_TOO_LARGE", 413)
    if not isinstance(signature, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", signature):
        raise ExportError("UNAUTHORIZED", 401)
    expected = hmac.new(secret, raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature.lower()):
        raise ExportError("UNAUTHORIZED", 401)
    try:
        payload = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                             parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise ExportError("INVALID_JSON") from None
    if not isinstance(payload, dict):
        raise ExportError("INVALID_REQUEST")
    validate_expiry(payload, current_ms)
    return payload


def path_parts(output):
    if not isinstance(output, dict) or set(output) - OUTPUT_KEYS:
        raise ExportError("INVALID_OUTPUT")
    if not {"filename", "subfolder", "type"} <= set(output) or output["type"] != "output":
        raise ExportError("INVALID_OUTPUT")
    filename, subfolder = output["filename"], output["subfolder"]
    if not isinstance(filename, str) or not isinstance(subfolder, str):
        raise ExportError("INVALID_OUTPUT")
    if len(filename) > 255 or len(subfolder) > 4096 or not filename.lower().endswith(".mp4"):
        raise ExportError("INVALID_OUTPUT")
    if "/" in filename or "\\" in filename or "\\" in subfolder:
        raise ExportError("INVALID_PATH")
    parts = ([] if subfolder == "" else subfolder.split("/")) + [filename]
    if any(not part or part in (".", "..") or ":" in part
           or any(ord(char) < 32 or ord(char) == 127 for char in part) for part in parts):
        raise ExportError("INVALID_PATH")
    if "nodeId" in output and (not isinstance(output["nodeId"], str)
                               or not IDENTIFIER.fullmatch(output["nodeId"])):
        raise ExportError("INVALID_OUTPUT")
    return parts


def validate_request(payload, uploading):
    fields = {"expiresAt", "jobId", "promptId", "output"}
    if uploading:
        fields |= {"file", "target"}
    if set(payload) != fields:
        raise ExportError("INVALID_REQUEST")
    for key in ("jobId", "promptId"):
        if not isinstance(payload[key], str) or not IDENTIFIER.fullmatch(payload[key]):
            raise ExportError("INVALID_REQUEST")
    path_parts(payload["output"])
    if uploading:
        validate_file(payload["file"])


def validate_history(payload, history):
    output = payload["output"]
    path_parts(output)
    entry = history.get(payload["promptId"]) if isinstance(history, dict) else None
    if not isinstance(entry, dict):
        raise ExportError("HISTORY_MISMATCH", 403)
    prompt, status = entry.get("prompt"), entry.get("status")
    if (not isinstance(prompt, (list, tuple)) or len(prompt) < 4
            or prompt[1] != payload["promptId"] or not isinstance(prompt[3], dict)
            or prompt[3].get("hailuoAttemptId") != payload["jobId"]):
        raise ExportError("HISTORY_MISMATCH", 403)
    if (not isinstance(status, dict) or status.get("completed") is not True
            or status.get("status_str") != "success"):
        raise ExportError("HISTORY_NOT_SUCCEEDED", 409)
    outputs = entry.get("outputs")
    if not isinstance(outputs, dict):
        raise ExportError("HISTORY_MISMATCH", 403)
    matches = 0
    descriptor = {key: output[key] for key in ("filename", "subfolder", "type")}
    for node_id, node in outputs.items():
        if "nodeId" in output and node_id != output["nodeId"]:
            continue
        if not isinstance(node, dict):
            continue
        for kind in ("videos", "gifs", "images", "audio"):
            values = node.get(kind, [])
            if not isinstance(values, list):
                continue
            for value in values:
                if isinstance(value, dict) and all(value.get(key) == item for key, item in descriptor.items()):
                    matches += 1
    if matches != 1:
        raise ExportError("HISTORY_MISMATCH", 403)


def fingerprint(file_stat):
    return (file_stat.st_dev, file_stat.st_ino, file_stat.st_size,
            file_stat.st_mtime_ns, file_stat.st_ctime_ns)


@contextmanager
def open_output(root, output):
    parts = path_parts(output)
    if os.name != "posix" or os.open not in os.supports_dir_fd or not hasattr(os, "O_NOFOLLOW"):
        raise ExportError("UNSUPPORTED_FILESYSTEM", 503)
    root = os.fspath(root)
    if not isinstance(root, str) or not root.startswith("/") or "\x00" in root:
        raise ExportError("INVALID_OUTPUT_ROOT", 503)
    root_parts = root.split("/")[1:]
    if any(part in (".", "..") for part in root_parts):
        raise ExportError("INVALID_OUTPUT_ROOT", 503)
    directory = None
    file_fd = None
    try:
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        directory = os.open("/", directory_flags)
        for part in [part for part in root_parts if part] + parts[:-1]:
            next_directory = os.open(part, directory_flags, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                          dir_fd=directory)
        file_stat = os.fstat(file_fd)
        if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_nlink != 1:
            raise ExportError("UNSAFE_FILE", 403)
        with os.fdopen(file_fd, "rb") as stream:
            file_fd = None
            yield stream, fingerprint(file_stat)
    except OSError:
        raise ExportError("FILE_UNAVAILABLE", 403) from None
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if directory is not None:
            os.close(directory)


def ensure_unchanged(stream, original):
    if fingerprint(os.fstat(stream.fileno())) != original:
        raise ExportError("FILE_CHANGED", 409)


def digest_result(size, sha256, md5):
    return {"size": size, "sha256": sha256.hexdigest(),
            "md5": base64.b64encode(md5.digest()).decode("ascii")}


async def hash_file(stream, original):
    ensure_unchanged(stream, original)
    stream.seek(0)
    sha256, md5 = hashlib.sha256(), hashlib.md5()
    size = 0
    while True:
        chunk = stream.read(CHUNK_BYTES)
        if not chunk:
            break
        size += len(chunk)
        sha256.update(chunk)
        md5.update(chunk)
        await asyncio.sleep(0)
    ensure_unchanged(stream, original)
    if size != original[2] or size == 0:
        raise ExportError("FILE_CHANGED", 409)
    stream.seek(0)
    return digest_result(size, sha256, md5)


def validate_file(file):
    if not isinstance(file, dict) or set(file) != {"size", "sha256", "md5"}:
        raise ExportError("INVALID_FILE")
    if type(file["size"]) is not int or not 0 < file["size"] <= 5 * 1024 ** 3:
        raise ExportError("INVALID_FILE")
    if not isinstance(file["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", file["sha256"]):
        raise ExportError("INVALID_FILE")
    try:
        digest = base64.b64decode(file["md5"], validate=True)
        if len(digest) != 16 or base64.b64encode(digest).decode("ascii") != file["md5"]:
            raise ValueError()
    except (ValueError, TypeError):
        raise ExportError("INVALID_FILE") from None


def validate_target(target, file, current_ms=None):
    validate_file(file)
    if not isinstance(target, dict) or set(target) != {"url", "headers"}:
        raise ExportError("INVALID_TARGET")
    url = target["url"]
    if (not isinstance(url, str) or len(url) > 16_384
            or any(ord(char) <= 32 or ord(char) >= 127 for char in url) or "\\" in url):
        raise ExportError("INVALID_TARGET")
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not TOS_HOST.fullmatch(parsed.netloc)
                or parsed.fragment or not parsed.path.startswith("/") or parsed.path == "/"):
            raise ValueError()
        pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
        query = unique_object(pairs)
        required = {"X-Tos-Algorithm", "X-Tos-Credential", "X-Tos-Date", "X-Tos-Expires",
                    "X-Tos-SignedHeaders", "X-Tos-Signature"}
        if (not required <= set(query) or set(query) - required - {"X-Tos-Security-Token", "X-Tos-Content-Sha256"}
                or query["X-Tos-Algorithm"] != "TOS4-HMAC-SHA256"
                or not re.fullmatch(r"[a-f0-9]{64}", query["X-Tos-Signature"])):
            raise ValueError()
        if query.get("X-Tos-Content-Sha256", "UNSIGNED-PAYLOAD") not in ("UNSIGNED-PAYLOAD", file["sha256"]):
            raise ValueError()
        scope = query["X-Tos-Credential"].split("/")
        region = parsed.netloc.split(".tos-", 1)[1].removesuffix(".volces.com")
        if (len(scope) != 5 or not scope[0] or scope[2] not in (region, "tos-" + region + ".volces.com")
                or scope[3:] != ["tos", "request"]
                or scope[1] != query["X-Tos-Date"][:8]):
            raise ValueError()
        signed_at = datetime.strptime(query["X-Tos-Date"], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp()
        if not re.fullmatch(r"[0-9]{1,6}", query["X-Tos-Expires"]):
            raise ValueError()
        expiry = int(query["X-Tos-Expires"])
        current = (now_ms() if current_ms is None else current_ms) / 1000
        if not 1 <= expiry <= 604800 or signed_at > current + 120 or signed_at + expiry <= current:
            raise ValueError()
        signed_headers = query["X-Tos-SignedHeaders"].split(";")
        if (signed_headers != sorted(set(signed_headers)) or "host" not in signed_headers
                or set(signed_headers) - REQUIRED_HEADERS - {"host", "content-length"}):
            raise ValueError()
    except (ValueError, ExportError):
        raise ExportError("INVALID_TARGET") from None
    supplied = target["headers"]
    if not isinstance(supplied, dict):
        raise ExportError("INVALID_TARGET")
    headers = {"content-type": "video/mp4", "content-md5": file["md5"],
               "x-tos-meta-sha256": file["sha256"], "x-tos-acl": "public-read",
               "content-length": str(file["size"])}
    seen = set()
    for name, value in supplied.items():
        lower = name.lower()
        if lower in seen or lower not in headers or value != headers[lower]:
            raise ExportError("INVALID_TARGET")
        seen.add(lower)
    if not REQUIRED_HEADERS <= seen:
        raise ExportError("INVALID_TARGET")
    return url, headers


def public_address(address):
    try:
        parsed = ipaddress.ip_address(address)
        mapped = getattr(parsed, "ipv4_mapped", None)
        return (parsed.is_global and not parsed.is_multicast and not parsed.is_reserved
                and getattr(parsed, "sixtofour", None) is None
                and getattr(parsed, "teredo", None) is None
                and (mapped is None or (mapped.is_global and not mapped.is_multicast)))
    except ValueError:
        return False


async def upload_file(stream, original, file, target, payload):
    import aiohttp
    from yarl import URL

    url, headers = validate_target(target, file)
    ensure_unchanged(stream, original)
    stream.seek(0)
    sent = None

    class PublicResolver(aiohttp.abc.AbstractResolver):
        def __init__(self):
            self.resolver = aiohttp.resolver.DefaultResolver()

        async def resolve(self, host, port=0, family=socket.AF_INET):
            if not TOS_HOST.fullmatch(host):
                raise ExportError("INVALID_TARGET")
            records = await self.resolver.resolve(host, port, family)
            if not records or any(not public_address(record["host"]) for record in records):
                raise ExportError("INVALID_TARGET")
            return records

        async def close(self):
            await self.resolver.close()

    async def chunks():
        nonlocal sent
        sha256, md5 = hashlib.sha256(), hashlib.md5()
        size = 0
        while True:
            chunk = stream.read(CHUNK_BYTES)
            if not chunk:
                break
            size += len(chunk)
            if size > file["size"]:
                raise ExportError("FILE_CHANGED", 409)
            sha256.update(chunk)
            md5.update(chunk)
            if size == file["size"]:
                if stream.read(1):
                    raise ExportError("FILE_CHANGED", 409)
                ensure_unchanged(stream, original)
                sent = digest_result(size, sha256, md5)
                if sent != file:
                    raise ExportError("FILE_CHANGED", 409)
            yield chunk
            await asyncio.sleep(0)
        ensure_unchanged(stream, original)
        sent = digest_result(size, sha256, md5)
        if sent != file:
            raise ExportError("FILE_CHANGED", 409)

    resolver = PublicResolver()
    try:
        connector = aiohttp.TCPConnector(resolver=resolver, limit=1, use_dns_cache=False)
        timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECONDS, connect=30, sock_read=60)
        async with aiohttp.ClientSession(connector=connector, timeout=timeout, trust_env=False,
                                         cookie_jar=aiohttp.DummyCookieJar()) as session:
            async with session.put(URL(url, encoded=True), headers=headers, data=chunks(),
                                   allow_redirects=False) as response:
                if response.status != 200 or sent != file:
                    raise ExportError("UPLOAD_FAILED", 502)
        ensure_unchanged(stream, original)
    finally:
        await resolver.close()
    return file


class ExportService:
    def __init__(self, output_root, get_history, uploader=upload_file):
        self.output_root = output_root
        self.get_history = get_history
        self.uploader = uploader
        self.lock = asyncio.Lock()

    async def execute(self, payload, uploading):
        validate_expiry(payload)
        validate_request(payload, uploading)
        if uploading:
            validate_target(payload["target"], payload["file"])
        if self.lock.locked():
            raise ExportError("BUSY", 409)
        async with self.lock:
            timeout = TIMEOUT_SECONDS if uploading else DESCRIBE_TIMEOUT_SECONDS
            return await asyncio.wait_for(self._execute(payload, uploading), timeout)

    async def _execute(self, payload, uploading):
        validate_history(payload, self.get_history(payload["promptId"]))
        with open_output(self.output_root(), payload["output"]) as (stream, original):
            file = await hash_file(stream, original)
            validate_file(file)
            if not uploading:
                return file
            if file != payload["file"]:
                raise ExportError("FILE_CHANGED", 409)
            validate_history(payload, self.get_history(payload["promptId"]))
            return await self.uploader(stream, original, file, payload["target"], payload)


async def read_body(request):
    if request.headers.get("Content-Encoding", "identity") != "identity":
        raise ExportError("INVALID_REQUEST")
    if request.content_length is not None and request.content_length > MAX_BODY_BYTES:
        raise ExportError("BODY_TOO_LARGE", 413)
    raw = bytearray()
    while True:
        chunk = await request.content.read(min(8192, MAX_BODY_BYTES + 1 - len(raw)))
        if not chunk:
            return bytes(raw)
        raw.extend(chunk)
        if len(raw) > MAX_BODY_BYTES:
            raise ExportError("BODY_TOO_LARGE", 413)


def register_routes(routes, output_root, get_history):
    from aiohttp import web

    service = ExportService(output_root, get_history)

    async def handle(request, uploading):
        try:
            async def operation():
                raw = await asyncio.wait_for(read_body(request), 10)
                signatures = request.headers.getall("X-Hailuo-Export-Signature", [])
                signature = signatures[0] if len(signatures) == 1 else None
                secret = os.environ.get("HAILUO_RESULT_EXPORT_SECRET", "").encode("utf-8")
                payload = authenticate(raw, signature, secret)
                return await service.execute(payload, uploading)

            timeout = TIMEOUT_SECONDS if uploading else DESCRIBE_TIMEOUT_SECONDS
            result = await asyncio.wait_for(operation(), timeout)
            return web.json_response(result, headers={"Cache-Control": "no-store"})
        except ExportError as error:
            return web.json_response({"error": error.code}, status=error.status,
                                     headers={"Cache-Control": "no-store"})
        except asyncio.TimeoutError:
            return web.json_response({"error": "TIMEOUT"}, status=504)
        except Exception:
            return web.json_response({"error": "EXPORT_FAILED"}, status=502)

    @routes.post("/hailuo/result-export/describe")
    async def describe(request):
        return await handle(request, False)

    @routes.post("/hailuo/result-export/upload")
    async def upload(request):
        return await handle(request, True)

    return service

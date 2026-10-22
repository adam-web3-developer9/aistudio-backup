import asyncio
import base64
import copy
import hashlib
import hmac
import io
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import types
import unittest
from contextlib import contextmanager
from unittest.mock import patch
from urllib.parse import urlencode

import exporter


CURRENT_MS = 1_790_000_000_000
SECRET = b"export-only-independent-secret-32bytes"
DATA = b"test-mp4-payload"


def file_info(data=DATA):
    return {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "md5": base64.b64encode(hashlib.md5(data).digest()).decode("ascii")}


def payload():
    return {"expiresAt": CURRENT_MS + 60_000, "jobId": "job-example", "promptId": "prompt-example",
            "output": {"filename": "result.mp4", "subfolder": "job-example", "type": "output", "nodeId": "12"}}


def history(request=None):
    request = payload() if request is None else request
    return {request["promptId"]: {
        "prompt": [0, request["promptId"], {}, {"hailuoAttemptId": request["jobId"]}],
        "status": {"completed": True, "status_str": "success"},
        "outputs": {"12": {"gifs": [{key: value for key, value in request["output"].items() if key != "nodeId"}]}}
    }}


def target(file=None):
    file = file_info() if file is None else file
    date = exporter.datetime.fromtimestamp(CURRENT_MS / 1000, exporter.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    query = {"X-Tos-Algorithm": "TOS4-HMAC-SHA256",
             "X-Tos-Credential": "EXAMPLE/" + date[:8] + "/cn-beijing/tos/request",
             "X-Tos-Date": date, "X-Tos-Expires": "600",
             "X-Tos-SignedHeaders": "content-md5;content-type;host;x-tos-acl;x-tos-meta-sha256",
             "X-Tos-Signature": "a" * 64}
    return {"url": "https://example-bucket.tos-cn-beijing.volces.com/jobs/result.mp4?" + urlencode(query),
            "headers": {"Content-MD5": file["md5"], "Content-Type": "video/mp4",
                        "x-tos-meta-sha256": file["sha256"], "x-tos-acl": "public-read"}}


def signed(raw):
    return hmac.new(SECRET, raw, hashlib.sha256).hexdigest()


class AuthenticationTests(unittest.TestCase):
    def test_raw_utf8_signature(self):
        raw = json.dumps(payload(), ensure_ascii=False, indent=2).encode("utf-8")
        self.assertEqual(exporter.authenticate(raw, signed(raw), SECRET, CURRENT_MS), payload())
        compact = json.dumps(payload(), separators=(",", ":")).encode()
        with self.assertRaisesRegex(exporter.ExportError, "UNAUTHORIZED"):
            exporter.authenticate(compact, signed(raw), SECRET, CURRENT_MS)

    def test_secret_and_signature_validation(self):
        raw = json.dumps(payload()).encode()
        for secret, signature, code in [(b"short", signed(raw), "NOT_CONFIGURED"),
                                        (SECRET, None, "UNAUTHORIZED"),
                                        (SECRET, "f" * 64, "UNAUTHORIZED"),
                                        (SECRET, "g" * 64, "UNAUTHORIZED")]:
            with self.subTest(code=code), self.assertRaisesRegex(exporter.ExportError, code):
                exporter.authenticate(raw, signature, secret, CURRENT_MS)

    def test_public_read_upload_headers_are_bound_by_hmac(self):
        request = dict(payload(), file=file_info(), target=target())
        raw = json.dumps(request).encode()
        signature = signed(raw)
        authenticated = exporter.authenticate(raw, signature, SECRET, CURRENT_MS)
        exporter.validate_target(authenticated["target"], authenticated["file"], CURRENT_MS)
        request["target"]["headers"]["x-tos-acl"] = "private"
        with self.assertRaisesRegex(exporter.ExportError, "UNAUTHORIZED"):
            exporter.authenticate(json.dumps(request).encode(), signature, SECRET, CURRENT_MS)

    def test_expiry_boundaries(self):
        for expires in [CURRENT_MS, CURRENT_MS - 1, CURRENT_MS + 120001, True, "123", None]:
            with self.subTest(expires=expires), self.assertRaisesRegex(exporter.ExportError, "INVALID_EXPIRY"):
                exporter.validate_expiry({"expiresAt": expires}, CURRENT_MS)
        exporter.validate_expiry({"expiresAt": CURRENT_MS + 120000}, CURRENT_MS)

    def test_duplicate_keys_invalid_utf8_constants_and_shapes(self):
        for raw in [b'{"expiresAt":1,"expiresAt":2}', b'\xff', b'{"expiresAt":NaN}', b'[]', b'null', b'{']:
            with self.subTest(raw=raw), self.assertRaises(exporter.ExportError):
                exporter.authenticate(raw, signed(raw), SECRET, CURRENT_MS)

    def test_body_limit(self):
        raw = b" " * (exporter.MAX_BODY_BYTES + 1)
        with self.assertRaisesRegex(exporter.ExportError, "BODY_TOO_LARGE"):
            exporter.authenticate(raw, signed(raw), SECRET, CURRENT_MS)


class RequestAndHistoryTests(unittest.TestCase):
    def test_valid_history_and_optional_node(self):
        request = payload()
        exporter.validate_request(request, False)
        exporter.validate_history(request, history())
        del request["output"]["nodeId"]
        exporter.validate_history(request, history())

    def test_paths_rejected(self):
        for field, value in [("filename", "../result.mp4"), ("filename", "C:result.mp4"),
                             ("filename", "result.mp4\x00"), ("filename", "result.txt"),
                             ("filename", "dir\\result.mp4"), ("filename", "/result.mp4"),
                             ("subfolder", "../secret"), ("subfolder", "/tmp"),
                             ("subfolder", "a//b"), ("subfolder", "a/./b"),
                             ("subfolder", "a/../b"), ("subfolder", "C:\\tmp"),
                             ("subfolder", "a\nb"), ("type", "input"), ("nodeId", 12)]:
            output = dict(payload()["output"], **{field: value})
            with self.subTest(field=field, value=value), self.assertRaises(exporter.ExportError):
                exporter.path_parts(output)

    def test_exact_descriptor(self):
        for field, value in [("filename", "other.mp4"), ("subfolder", "other"), ("type", "temp")]:
            recorded = history()
            recorded["prompt-example"]["outputs"]["12"]["gifs"][0][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(exporter.ExportError, "HISTORY_MISMATCH"):
                exporter.validate_history(payload(), recorded)

    def test_job_prompt_success_and_node_binding(self):
        original = history()
        variants = []
        changed = copy.deepcopy(original)
        changed["prompt-example"]["prompt"][1] = "another-prompt"
        variants.append(changed)
        changed = copy.deepcopy(original)
        changed["prompt-example"]["prompt"][3]["hailuoAttemptId"] = "another-job"
        variants.append(changed)
        for status in [{"completed": False, "status_str": "success"},
                       {"completed": True, "status_str": "error"},
                       {"completed": 1, "status_str": "success"}]:
            changed = copy.deepcopy(original)
            changed["prompt-example"]["status"] = status
            variants.append(changed)
        changed = copy.deepcopy(original)
        changed["prompt-example"]["outputs"]["13"] = changed["prompt-example"]["outputs"].pop("12")
        variants.extend([changed, {}, {"other-prompt": original["prompt-example"]}])
        for recorded in variants:
            with self.subTest(recorded=recorded), self.assertRaises(exporter.ExportError):
                exporter.validate_history(payload(), recorded)

    def test_ambiguous_node_rejected(self):
        request, recorded = payload(), history()
        del request["output"]["nodeId"]
        recorded["prompt-example"]["outputs"]["13"] = copy.deepcopy(recorded["prompt-example"]["outputs"]["12"])
        with self.assertRaisesRegex(exporter.ExportError, "HISTORY_MISMATCH"):
            exporter.validate_history(request, recorded)

    def test_unknown_request_fields(self):
        request = dict(payload(), command="not-allowed")
        with self.assertRaisesRegex(exporter.ExportError, "INVALID_REQUEST"):
            exporter.validate_request(request, False)


class TargetTests(unittest.TestCase):
    def test_valid_presigned_target_and_required_headers(self):
        destination = target()
        url, headers = exporter.validate_target(destination, file_info(), CURRENT_MS)
        self.assertEqual(url, destination["url"])
        self.assertEqual(headers["content-md5"], file_info()["md5"])
        self.assertEqual(headers["content-length"], str(len(DATA)))
        self.assertEqual(headers["x-tos-acl"], "public-read")
        destination["headers"] = {key.upper(): value for key, value in destination["headers"].items()}
        self.assertEqual(exporter.validate_target(destination, file_info(), CURRENT_MS)[1], headers)

    def test_all_four_headers_required_and_acl_public_read(self):
        for missing in list(target()["headers"]):
            destination = target()
            del destination["headers"][missing]
            with self.subTest(missing=missing), self.assertRaisesRegex(exporter.ExportError, "INVALID_TARGET"):
                exporter.validate_target(destination, file_info(), CURRENT_MS)
        for acl in ["private", "public-read-write", "", "PUBLIC-READ", "public-read\r\nHost: evil"]:
            destination = target()
            destination["headers"]["x-tos-acl"] = acl
            with self.subTest(acl=acl), self.assertRaisesRegex(exporter.ExportError, "INVALID_TARGET"):
                exporter.validate_target(destination, file_info(), CURRENT_MS)

    def test_bad_authorities_and_schemes(self):
        original = target()
        suffix = original["url"].split("volces.com", 1)[1]
        for origin in ["http://example-bucket.tos-cn-beijing.volces.com",
                       "https://127.0.0.1", "https://169.254.169.254", "https://[::1]",
                       "https://example-bucket.tos-cn-beijing.volces.com:443",
                       "https://user:pass@example-bucket.tos-cn-beijing.volces.com",
                       "https://example-bucket.tos-cn-beijing.volces.com.evil.test",
                       "https://evil.test/example-bucket.tos-cn-beijing.volces.com",
                       "https://example-bucket.tos-cn-beijing.volces.com.",
                       "https://example-bucket.tos-cn-beijing.ivolces.com",
                       "https://example-bucket.tos-cn-beijing.volces.com@evil.test",
                       "https://example-bucket%2Etos-cn-beijing.volces.com"]:
            destination = dict(original, url=origin + suffix)
            with self.subTest(origin=origin), self.assertRaisesRegex(exporter.ExportError, "INVALID_TARGET"):
                exporter.validate_target(destination, file_info(), CURRENT_MS)

    def test_invalid_signing_query(self):
        original = target()
        for url in [original["url"] + "#fragment", original["url"] + "&X-Tos-Expires=600",
                    original["url"] + "&unexpected=value",
                    original["url"].replace("TOS4-HMAC-SHA256", "AWS4-HMAC-SHA256"),
                    original["url"].replace("X-Tos-Expires=600", "X-Tos-Expires=0"),
                    original["url"].replace("X-Tos-Expires=600", "X-Tos-Expires=604801"),
                    original["url"].replace("cn-beijing%2Ftos", "cn-shanghai%2Ftos"),
                    original["url"].replace("host%3B", "authorization%3B"),
                    original["url"].split("?", 1)[0], original["url"] + "\n"]:
            with self.subTest(url=url), self.assertRaisesRegex(exporter.ExportError, "INVALID_TARGET"):
                exporter.validate_target(dict(original, url=url), file_info(), CURRENT_MS)
        with self.assertRaises(exporter.ExportError):
            exporter.validate_target(original, file_info(), CURRENT_MS + 600000)

    def test_untrusted_or_conflicting_headers(self):
        for headers in [{"Host": "evil.test"}, {"Authorization": "not-allowed"},
                        {"Content-Type": "text/plain"}, {"content-md5": "wrong"},
                        {"x-tos-meta-sha256": "wrong"}, {"Content-Length": "999"},
                        {"Cookie": "not-allowed"}, {"Transfer-Encoding": "chunked"},
                        {"content-type": "video/mp4", "Content-Type": "video/mp4"}]:
            with self.subTest(headers=headers), self.assertRaisesRegex(exporter.ExportError, "INVALID_TARGET"):
                exporter.validate_target(dict(target(), headers=headers), file_info(), CURRENT_MS)

    def test_file_contract(self):
        for field, value in [("size", True), ("size", 0), ("size", 5 * 1024 ** 3 + 1),
                             ("sha256", "A" * 64), ("sha256", "wrong"),
                             ("md5", "!!!!"), ("md5", base64.b64encode(b"short").decode()),
                             ("md5", None)]:
            with self.subTest(field=field), self.assertRaisesRegex(exporter.ExportError, "INVALID_FILE"):
                exporter.validate_file(dict(file_info(), **{field: value}))

    def test_public_addresses_only(self):
        for address in ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254",
                        "100.64.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1",
                        "224.0.0.1", "ff02::1", "0.0.0.0", "2002:7f00:1::", "invalid"]:
            with self.subTest(address=address):
                self.assertFalse(exporter.public_address(address))
        self.assertTrue(exporter.public_address("8.8.8.8"))


class FileHashTests(unittest.IsolatedAsyncioTestCase):
    async def test_streaming_hashes_and_rewind(self):
        data = b"a" * (exporter.CHUNK_BYTES * 2 + 37)
        with tempfile.TemporaryFile("w+b") as stream:
            stream.write(data)
            stream.flush()
            original = exporter.fingerprint(os.fstat(stream.fileno()))
            result = await exporter.hash_file(stream, original)
            self.assertEqual(result, file_info(data))
            self.assertEqual(stream.tell(), 0)

    async def test_changed_and_empty_files_fail(self):
        with tempfile.TemporaryFile("w+b") as stream:
            original = exporter.fingerprint(os.fstat(stream.fileno()))
            with self.assertRaisesRegex(exporter.ExportError, "FILE_CHANGED"):
                await exporter.hash_file(stream, original)
            stream.write(DATA)
            stream.flush()
            with self.assertRaisesRegex(exporter.ExportError, "FILE_CHANGED"):
                await exporter.hash_file(stream, original)


@unittest.skipUnless(os.name == "posix" and os.open in os.supports_dir_fd, "Requires Linux/POSIX openat")
class SecureOpenTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name).resolve()
        (self.root / "job-example").mkdir()
        self.file = self.root / "job-example" / "result.mp4"
        self.file.write_bytes(DATA)

    def test_regular_file_read_only(self):
        with exporter.open_output(self.root, payload()["output"]) as (stream, original):
            self.assertEqual(stream.read(), DATA)
            self.assertEqual(original[2], len(DATA))
            with self.assertRaises(io.UnsupportedOperation):
                stream.write(b"no")
        self.assertEqual(self.file.read_bytes(), DATA)

    def test_file_symlink_and_hardlink_blocked(self):
        self.file.rename(self.file.with_name("original.mp4"))
        self.file.symlink_to(self.file.with_name("original.mp4"))
        with self.assertRaises(exporter.ExportError), exporter.open_output(self.root, payload()["output"]):
            self.fail("Symlink opened")
        self.file.unlink()
        os.link(self.file.with_name("original.mp4"), self.file)
        with self.assertRaises(exporter.ExportError), exporter.open_output(self.root, payload()["output"]):
            self.fail("Hardlink opened")

    def test_parent_and_root_symlinks_blocked(self):
        (self.root / "alias").symlink_to(self.root / "job-example", target_is_directory=True)
        output = dict(payload()["output"], subfolder="alias")
        with self.assertRaises(exporter.ExportError), exporter.open_output(self.root, output):
            self.fail("Parent symlink opened")
        with self.assertRaises(exporter.ExportError), exporter.open_output(self.root / "alias", dict(output, subfolder="")):
            self.fail("Root symlink opened")

    def test_directory_and_fifo_blocked(self):
        self.file.unlink()
        self.file.mkdir()
        with self.assertRaises(exporter.ExportError), exporter.open_output(self.root, payload()["output"]):
            self.fail("Directory opened")
        self.file.rmdir()
        os.mkfifo(self.file)
        with self.assertRaises(exporter.ExportError), exporter.open_output(self.root, payload()["output"]):
            self.fail("FIFO opened")


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clock = patch.object(exporter, "now_ms", return_value=CURRENT_MS)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.stream = tempfile.TemporaryFile("w+b")
        self.addCleanup(self.stream.close)
        self.stream.write(DATA)
        self.stream.flush()

        @contextmanager
        def opened(_root, _output):
            yield self.stream, exporter.fingerprint(os.fstat(self.stream.fileno()))

        self.opener = patch.object(exporter, "open_output", opened)
        self.opener.start()
        self.addCleanup(self.opener.stop)

    def upload_payload(self):
        return dict(payload(), file=file_info(), target=target())

    async def test_describe_and_upload(self):
        calls = []

        async def uploader(stream, original, file, destination, request):
            calls.append((stream.read(), file))
            self.assertEqual(destination, target())
            return file

        service = exporter.ExportService(lambda: "/output", lambda _prompt: history(), uploader)
        self.assertEqual(await service.execute(payload(), False), file_info())
        self.assertEqual(await service.execute(self.upload_payload(), True), file_info())
        self.assertEqual(calls, [(DATA, file_info())])

    async def test_changed_hash_prevents_network(self):
        async def uploader(*_args):
            self.fail("Network must not be called")

        service = exporter.ExportService(lambda: "/output", lambda _prompt: history(), uploader)
        request = self.upload_payload()
        request["file"] = file_info(b"different")
        request["target"] = target(request["file"])
        with self.assertRaisesRegex(exporter.ExportError, "FILE_CHANGED"):
            await service.execute(request, True)

    async def test_hash_may_outlast_admitted_hmac_window(self):
        current = [CURRENT_MS]
        original_hash = exporter.hash_file
        calls = []

        async def slow_hash(stream, original):
            result = await original_hash(stream, original)
            current[0] += 121_000
            return result

        async def uploader(_stream, _original, file, destination, request):
            self.assertGreater(exporter.now_ms(), request["expiresAt"])
            exporter.validate_target(destination, file)
            calls.append(file)
            return file

        request = self.upload_payload()
        raw = json.dumps(request).encode()
        service = exporter.ExportService(lambda: "/output", lambda _prompt: history(), uploader)
        with patch.object(exporter, "now_ms", side_effect=lambda: current[0]), \
                patch.object(exporter, "hash_file", side_effect=slow_hash):
            admitted = exporter.authenticate(raw, signed(raw), SECRET)
            self.assertEqual(await service.execute(admitted, True), file_info())
            with self.assertRaisesRegex(exporter.ExportError, "INVALID_EXPIRY"):
                exporter.authenticate(raw, signed(raw), SECRET)
        self.assertEqual(calls, [file_info()])

    async def test_history_prevents_network(self):
        service = exporter.ExportService(lambda: "/output", lambda _prompt: {})
        with self.assertRaisesRegex(exporter.ExportError, "HISTORY_MISMATCH"):
            await service.execute(self.upload_payload(), True)

    async def test_busy_rejects_without_queueing(self):
        started, release = asyncio.Event(), asyncio.Event()

        async def uploader(_stream, _original, file, _target, _request):
            started.set()
            await release.wait()
            return file

        service = exporter.ExportService(lambda: "/output", lambda _prompt: history(), uploader)
        first = asyncio.create_task(service.execute(self.upload_payload(), True))
        try:
            await asyncio.wait_for(started.wait(), 1)
            with self.assertRaisesRegex(exporter.ExportError, "BUSY"):
                await service.execute(self.upload_payload(), True)
        finally:
            release.set()
            await first
        self.assertFalse(service.lock.locked())

    async def test_timeout_releases_lock(self):
        async def uploader(*_args):
            await asyncio.sleep(10)

        service = exporter.ExportService(lambda: "/output", lambda _prompt: history(), uploader)
        with patch.object(exporter, "TIMEOUT_SECONDS", 0.01):
            with self.assertRaises(asyncio.TimeoutError):
                await service.execute(self.upload_payload(), True)
        self.assertFalse(service.lock.locked())

    async def test_describe_has_independent_60_second_budget(self):
        self.assertEqual(exporter.DESCRIBE_TIMEOUT_SECONDS, 60)
        self.assertEqual(exporter.TIMEOUT_SECONDS, 600)
        service = exporter.ExportService(lambda: "/output", lambda _prompt: history())

        async def slow_hash(*_args):
            await asyncio.sleep(10)

        with patch.object(exporter, "DESCRIBE_TIMEOUT_SECONDS", 0.01), \
                patch.object(exporter, "hash_file", side_effect=slow_hash):
            with self.assertRaises(asyncio.TimeoutError):
                await service.execute(payload(), False)
        self.assertFalse(service.lock.locked())


class FakeContent:
    def __init__(self, raw):
        self.raw = io.BytesIO(raw)

    async def read(self, size):
        return self.raw.read(size)


class FakeHeaders(dict):
    def getall(self, key, default):
        value = self.get(key)
        return default if value is None else [value]


class RouteTests(unittest.IsolatedAsyncioTestCase):
    def request(self, raw, signature=None, length=None):
        return types.SimpleNamespace(content=FakeContent(raw), content_length=length,
                                     headers=FakeHeaders({"X-Hailuo-Export-Signature": signature or signed(raw)}))

    async def test_chunked_body_limit_and_content_encoding(self):
        with self.assertRaisesRegex(exporter.ExportError, "BODY_TOO_LARGE"):
            await exporter.read_body(self.request(b"a" * (exporter.MAX_BODY_BYTES + 1)))
        request = self.request(b"a")
        request.headers["Content-Encoding"] = "gzip"
        with self.assertRaisesRegex(exporter.ExportError, "INVALID_REQUEST"):
            await exporter.read_body(request)

    async def test_route_registration_and_sanitized_errors(self):
        handlers = {}

        class Routes:
            def post(self, path):
                def register(handler):
                    handlers[path] = handler
                    return handler
                return register

        web = types.SimpleNamespace(json_response=lambda body, **kwargs: (body, kwargs))
        with patch.dict("sys.modules", {"aiohttp": types.SimpleNamespace(web=web)}):
            service = exporter.register_routes(Routes(), lambda: "/private/path", lambda _prompt: history())
        self.assertEqual(set(handlers), {"/hailuo/result-export/describe", "/hailuo/result-export/upload"})
        raw = json.dumps(payload()).encode()
        with patch.dict(os.environ, {"HAILUO_RESULT_EXPORT_SECRET": SECRET.decode()}), \
                patch.object(exporter, "now_ms", return_value=CURRENT_MS):
            result, options = await handlers["/hailuo/result-export/describe"](self.request(raw, "0" * 64))
            self.assertEqual(result, {"error": "UNAUTHORIZED"})
            self.assertEqual(options["status"], 401)
            with patch.object(service, "execute", side_effect=RuntimeError("secret URL /private/path")):
                result, options = await handlers["/hailuo/result-export/describe"](self.request(raw))
            self.assertEqual(result, {"error": "EXPORT_FAILED"})
            self.assertEqual(options["status"], 502)


class UploadTransportTests(unittest.IsolatedAsyncioTestCase):
    async def run_upload(self, response_status=200, address="8.8.8.8", early_response=False,
                         current_ms=CURRENT_MS):
        captured = {"chunks": [], "closed": False}

        class Resolver:
            async def resolve(self, host, port, family):
                return [{"host": address}]

            async def close(self):
                captured["closed"] = True

        class Connector:
            def __init__(self, **kwargs):
                captured["connector"] = kwargs

        class Session:
            def __init__(self, **kwargs):
                captured["session"] = kwargs

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            def put(self, url, **kwargs):
                captured["put"] = kwargs

                class Response:
                    status = response_status

                    async def __aenter__(self):
                        await captured["connector"]["resolver"].resolve("example-bucket.tos-cn-beijing.volces.com", 443)
                        async for chunk in kwargs["data"]:
                            captured["chunks"].append(chunk)
                            if early_response and sum(map(len, captured["chunks"])) == int(kwargs["headers"]["content-length"]):
                                await kwargs["data"].aclose()
                                break
                        return self

                    async def __aexit__(self, *_args):
                        return False

                return Response()

        aiohttp = types.SimpleNamespace(abc=types.SimpleNamespace(AbstractResolver=object),
                                        resolver=types.SimpleNamespace(DefaultResolver=Resolver),
                                        TCPConnector=Connector, ClientSession=Session,
                                        ClientTimeout=lambda **kwargs: kwargs, DummyCookieJar=lambda: None)
        yarl = types.SimpleNamespace(URL=lambda value, **kwargs: value)
        data = b"x" * (exporter.CHUNK_BYTES + 17)
        with tempfile.TemporaryFile("w+b") as stream, \
                patch.dict("sys.modules", {"aiohttp": aiohttp, "yarl": yarl}), \
                patch.object(exporter, "now_ms", return_value=current_ms):
            stream.write(data)
            stream.flush()
            original = exporter.fingerprint(os.fstat(stream.fileno()))
            result = await exporter.upload_file(stream, original, file_info(data), target(file_info(data)), payload())
        return result, captured, data

    async def test_streaming_put_and_transport_limits(self):
        result, captured, data = await self.run_upload()
        self.assertEqual(result, file_info(data))
        self.assertEqual(b"".join(captured["chunks"]), data)
        self.assertTrue(all(len(chunk) <= exporter.CHUNK_BYTES for chunk in captured["chunks"]))
        self.assertFalse(captured["put"]["allow_redirects"])
        self.assertFalse(captured["session"]["trust_env"])
        self.assertEqual(captured["put"]["headers"]["x-tos-acl"], "public-read")
        self.assertLessEqual(captured["session"]["timeout"]["total"], 600)
        self.assertTrue(captured["closed"])

    async def test_response_immediately_after_last_byte(self):
        result, _captured, data = await self.run_upload(early_response=True)
        self.assertEqual(result, file_info(data))

    async def test_put_allows_expired_admission_but_valid_tos_url(self):
        result, _captured, data = await self.run_upload(current_ms=CURRENT_MS + 121_000)
        self.assertEqual(result, file_info(data))

    async def test_put_rechecks_tos_expiry(self):
        with self.assertRaisesRegex(exporter.ExportError, "INVALID_TARGET"):
            await self.run_upload(current_ms=CURRENT_MS + 600_001)

    async def test_redirect_and_failure_rejected(self):
        for status in [301, 302, 307, 308, 400, 403, 500]:
            with self.subTest(status=status), self.assertRaisesRegex(exporter.ExportError, "UPLOAD_FAILED"):
                await self.run_upload(response_status=status)

    async def test_dns_private_address_rejected(self):
        with self.assertRaisesRegex(exporter.ExportError, "INVALID_TARGET"):
            await self.run_upload(address="169.254.169.254")


class SdkCompatibilityTests(unittest.TestCase):
    def test_actual_tos_adapter_sdk_signature_offline(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        rtk = shutil.which("rtk")
        if rtk is None or shutil.which("node") is None or not (root / "node_modules/@volcengine/tos-sdk").exists():
            self.skipTest("Requires repository Node/RTK and installed TOS SDK; no dependencies installed by tests")
        script = r'''
const { createHash } = require('node:crypto');
const networkDenied = () => { throw new Error('OFFLINE_TEST_NETWORK_FORBIDDEN'); };
globalThis.fetch = networkDenied;
require('node:http').request = networkDenied;
require('node:http').get = networkDenied;
require('node:https').request = networkDenied;
require('node:https').get = networkDenied;
require('node:net').Socket.prototype.connect = networkDenied;
require('node:tls').connect = networkDenied;
const { TosResultStorage } = require('./src/comfyui/tos-result-storage.ts');
const bytes = Buffer.from('test-mp4-payload');
const file = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  md5: createHash('md5').update(bytes).digest('base64') };
const storage = new TosResultStorage({ bucket: 'public-results', region: 'cn-beijing',
  endpoint: 'https://tos-cn-beijing.volces.com', keyPrefix: 'archive/results',
  accessKeyId: 'offline-test-not-a-real-access-key', accessKeySecret: 'offline-test-not-a-real-secret' });
const target = storage.uploadTarget('job/视频 +.mp4', file);
const downloadUrl = storage.downloadUrl('job/视频 +.mp4', 60);
process.stdout.write(JSON.stringify({ target, downloadUrl, generatedAt: Date.now() }));
'''
        completed = subprocess.run([rtk, "proxy", "node", "--import", "tsx", "-e", script],
                                   cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=30)
        self.assertEqual(completed.returncode, 0, "Actual adapter/SDK offline signing failed (output suppressed)")
        try:
            fixture = json.loads(completed.stdout)
            url, headers = exporter.validate_target(fixture["target"], file_info(), fixture["generatedAt"])
        except Exception:
            self.fail("Actual adapter/SDK target failed export validation (sensitive target suppressed)")
        self.assertEqual(set(fixture["target"]["headers"]),
                         {"Content-MD5", "Content-Type", "x-tos-meta-sha256", "x-tos-acl"})
        self.assertEqual(headers["x-tos-acl"], "public-read")
        self.assertEqual(url, fixture["target"]["url"], "Presigned URL must be preserved byte-for-byte")
        parsed = exporter.urlsplit(url)
        query = dict(exporter.parse_qsl(parsed.query))
        self.assertEqual(parsed.hostname, "public-results.tos-cn-beijing.volces.com")
        download = exporter.urlsplit(fixture["downloadUrl"])
        self.assertEqual(download.scheme, "https")
        self.assertEqual(download.netloc, parsed.netloc)
        self.assertEqual(download.path, parsed.path)
        self.assertEqual(download.query, "")
        self.assertEqual(download.fragment, "")
        self.assertNotIn("offline-test", fixture["downloadUrl"])
        self.assertEqual(query["X-Tos-Expires"], "900")
        self.assertEqual(query["X-Tos-SignedHeaders"], "host")
        self.assertEqual(query["X-Tos-Content-Sha256"], "UNSIGNED-PAYLOAD")
        self.assertIn(query["X-Tos-Credential"].split("/")[2], ["cn-beijing", "tos-cn-beijing.volces.com"])
        self.assertIn("%", parsed.path)
        for changed_url in [url.replace("UNSIGNED-PAYLOAD", "untrusted"),
                            url.replace("tos-cn-beijing.volces.com%2Ftos", "tos-cn-shanghai.volces.com%2Ftos"),
                            url + "&X-Tos-Content-Sha256=UNSIGNED-PAYLOAD"]:
            if changed_url == url:
                continue
            with self.assertRaisesRegex(exporter.ExportError, "INVALID_TARGET"):
                exporter.validate_target(dict(fixture["target"], url=changed_url), file_info(), fixture["generatedAt"])


if __name__ == "__main__":
    unittest.main()

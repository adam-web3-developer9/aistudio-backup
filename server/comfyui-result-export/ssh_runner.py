import asyncio
import contextlib
import http.client
import json
import os
import posixpath
import queue
import re
import sys
import threading
import types
from urllib.parse import quote


MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_SOURCE_BYTES = 512 * 1024
MAX_PAYLOAD_BYTES = 64 * 1024
MAX_RESULT_BYTES = 4096
MAX_PROC_BYTES = 64 * 1024
MAX_HISTORY_BYTES = 1024 * 1024
HISTORY_TIMEOUT_SECONDS = 10
PROC_ROOT = "/proc"
EXPORT_CODES = frozenset({
    "INVALID_EXPIRY", "INVALID_REQUEST", "INVALID_OUTPUT", "INVALID_PATH",
    "INVALID_FILE", "INVALID_TARGET", "INVALID_OUTPUT_ROOT", "HISTORY_MISMATCH",
    "HISTORY_NOT_SUCCEEDED", "UNSUPPORTED_FILESYSTEM", "UNSAFE_FILE",
    "FILE_UNAVAILABLE", "FILE_CHANGED", "UPLOAD_FAILED", "BUSY",
})
RUNNER_CODES = frozenset({
    "INVALID_REQUEST", "REQUEST_TOO_LARGE", "INVALID_SOURCE", "SOURCE_TOO_LARGE",
    "INVALID_RUNTIME", "COMFY_NOT_FOUND", "COMFY_AMBIGUOUS", "RUNTIME_CHANGED",
    "HISTORY_FAILED", "HISTORY_TIMEOUT", "HISTORY_TOO_LARGE", "INVALID_HISTORY",
    "TIMEOUT", "RUNNER_FAILED", "EXPORT_FAILED",
})


class RunnerError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class Discard:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def encode_json(value, limit=MAX_REQUEST_BYTES):
    raw = json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > limit:
        raise RunnerError("REQUEST_TOO_LARGE")
    return raw


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise RunnerError("INVALID_REQUEST")
        result[key] = value
    return result


def invalid_constant(_value):
    raise RunnerError("INVALID_REQUEST")


def decode_json(raw, limit=MAX_REQUEST_BYTES):
    if len(raw) > limit:
        raise RunnerError("REQUEST_TOO_LARGE")
    try:
        return json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise RunnerError("INVALID_REQUEST") from None


def read_request():
    return decode_json(sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1))


def read_proc(pid, name):
    with open(posixpath.join(PROC_ROOT, str(pid), name), "rb") as stream:
        value = stream.read(MAX_PROC_BYTES + 1)
    if len(value) > MAX_PROC_BYTES:
        raise ValueError()
    return value


def start_time(pid):
    tail = read_proc(pid, "stat").rsplit(b")", 1)[1].split()
    value = tail[19].decode("ascii")
    if not re.fullmatch(r"[0-9]{1,32}", value):
        raise ValueError()
    return value


def process_runtime(pid):
    before = start_time(pid)
    raw = read_proc(pid, "cmdline")
    if not raw.endswith(b"\0"):
        raise ValueError()
    argv = [part.decode("utf-8", "strict") for part in raw[:-1].split(b"\0")]
    index = 1
    while index < len(argv) and argv[index].startswith("-"):
        option = argv[index]
        if option == "--":
            index += 1
            break
        if option in ("-W", "-X"):
            index += 2
        elif (option in ("-u", "-B", "-I", "-E", "-s", "-S", "-O", "-OO", "-P", "-q", "-v")
              or option.startswith(("-W", "-X"))):
            index += 1
        else:
            return None
    if index >= len(argv) or posixpath.basename(argv[index]) != "main.py":
        return None
    arguments = argv[index + 1:]
    options = {}
    offset = 0
    while offset < len(arguments):
        argument = arguments[offset]
        name, separator, value = argument.partition("=")
        if name in ("--port", "--output-directory"):
            if name in options:
                raise ValueError()
            if not separator:
                offset += 1
                if offset >= len(arguments):
                    raise ValueError()
                value = arguments[offset]
            if not value or value.startswith("-"):
                raise ValueError()
            options[name] = value
        offset += 1
    port = options.get("--port", "8188")
    if not re.fullmatch(r"[0-9]{1,5}", port) or int(port) != 8188:
        return None
    directory = posixpath.join(PROC_ROOT, str(pid))
    cwd = os.readlink(posixpath.join(directory, "cwd"))
    python = os.readlink(posixpath.join(directory, "exe"))
    if (not cwd.startswith("/") or not python.startswith("/")
            or python.endswith(" (deleted)") or "\0" in python):
        raise ValueError()
    script = os.path.realpath(posixpath.join(cwd, argv[index]))
    output = options.get("--output-directory")
    root = (posixpath.join(cwd, output) if output is not None
            else posixpath.join(posixpath.dirname(script), "output"))
    root = os.path.realpath(root)
    if not root.startswith("/") or not os.path.isdir(root) or before != start_time(pid):
        raise ValueError()
    return {"python": python, "outputRoot": root, "port": 8188, "pid": pid}, before


def inspect_runtime():
    candidates = []
    try:
        pids = os.listdir(PROC_ROOT)
    except OSError:
        raise RunnerError("COMFY_NOT_FOUND") from None
    for name in pids:
        if not re.fullmatch(r"[0-9]{1,10}", name):
            continue
        try:
            candidate = process_runtime(int(name))
        except (OSError, ValueError, UnicodeError, IndexError):
            continue
        if candidate is not None:
            candidates.append(candidate)
    if len(candidates) != 1:
        raise RunnerError("COMFY_NOT_FOUND" if not candidates else "COMFY_AMBIGUOUS")
    return candidates[0]


def validate_runtime(runtime):
    if (not isinstance(runtime, dict) or set(runtime) != {"python", "outputRoot", "port", "pid"}
            or type(runtime["port"]) is not int or runtime["port"] != 8188
            or type(runtime["pid"]) is not int or runtime["pid"] <= 0):
        raise RunnerError("INVALID_RUNTIME")
    for key in ("python", "outputRoot"):
        value = runtime[key]
        if (not isinstance(value, str) or not value.startswith("/") or len(value) > 4096
                or any(ord(char) < 32 or ord(char) == 127 for char in value)):
            raise RunnerError("INVALID_RUNTIME")


def verify_runtime(runtime, identity=None):
    try:
        current, current_identity = inspect_runtime()
    except RunnerError:
        raise RunnerError("RUNTIME_CHANGED") from None
    if current != runtime or (identity is not None and current_identity != identity):
        raise RunnerError("RUNTIME_CHANGED")
    return current_identity


def fetch_history(prompt_id):
    connection = http.client.HTTPConnection("127.0.0.1", 8188, timeout=HISTORY_TIMEOUT_SECONDS)
    try:
        connection.request("GET", "/history/" + quote(prompt_id, safe=""),
                           headers={"Accept": "application/json", "Accept-Encoding": "identity",
                                    "Connection": "close"})
        response = connection.getresponse()
        if response.status != 200 or response.getheader("Content-Encoding", "identity") != "identity":
            raise RunnerError("HISTORY_FAILED")
        length = response.getheader("Content-Length")
        if length is not None:
            if not re.fullmatch(r"[0-9]{1,10}", length):
                raise RunnerError("INVALID_HISTORY")
            if int(length) > MAX_HISTORY_BYTES:
                raise RunnerError("HISTORY_TOO_LARGE")
        raw = response.read(MAX_HISTORY_BYTES + 1)
        if len(raw) > MAX_HISTORY_BYTES:
            raise RunnerError("HISTORY_TOO_LARGE")
        try:
            result = decode_json(raw, MAX_HISTORY_BYTES)
        except RunnerError:
            raise RunnerError("INVALID_HISTORY") from None
        if not isinstance(result, dict) or set(result) != {prompt_id}:
            raise RunnerError("INVALID_HISTORY")
        return result
    finally:
        connection.close()


def get_history(prompt_id):
    if not isinstance(prompt_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,256}", prompt_id):
        raise RunnerError("INVALID_REQUEST")
    completed = queue.Queue(maxsize=1)

    def fetch():
        try:
            completed.put((fetch_history(prompt_id), None))
        except BaseException as error:
            completed.put((None, error))

    threading.Thread(target=fetch, daemon=True).start()
    try:
        result, error = completed.get(timeout=HISTORY_TIMEOUT_SECONDS)
    except queue.Empty:
        raise RunnerError("HISTORY_TIMEOUT") from None
    if error is not None:
        if isinstance(error, RunnerError) and error.code in RUNNER_CODES:
            raise error
        raise RunnerError("HISTORY_FAILED") from None
    return result


def validate_request(request):
    encode_json(request)
    if not isinstance(request, dict):
        raise RunnerError("INVALID_REQUEST")
    operation = request.get("operation")
    if operation == "inspect" and set(request) == {"operation"}:
        return operation
    if operation not in ("describe", "upload") or set(request) != {
            "operation", "runtime", "exporterSource", "payload"}:
        raise RunnerError("INVALID_REQUEST")
    validate_runtime(request["runtime"])
    source = request["exporterSource"]
    if not isinstance(source, str) or not source.strip() or "\0" in source:
        raise RunnerError("INVALID_SOURCE")
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise RunnerError("SOURCE_TOO_LARGE")
    if not isinstance(request["payload"], dict):
        raise RunnerError("INVALID_REQUEST")
    encode_json(request["payload"], MAX_PAYLOAD_BYTES)
    return operation


def load_exporter(source):
    module = types.ModuleType("_hailuo_ssh_exporter")
    exec(compile(source, "<hailuo-exporter>", "exec"), module.__dict__)
    return module


def archive_file(result):
    if not isinstance(result, dict) or set(result) != {"size", "sha256", "md5"}:
        raise RunnerError("EXPORT_FAILED")
    import base64
    if (type(result["size"]) is not int or not 0 < result["size"] <= 5 * 1024 ** 3
            or not isinstance(result["sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", result["sha256"])
            or not isinstance(result["md5"], str) or len(result["md5"]) != 24):
        raise RunnerError("EXPORT_FAILED")
    try:
        digest = base64.b64decode(result["md5"], validate=True)
        if len(digest) != 16 or base64.b64encode(digest).decode("ascii") != result["md5"]:
            raise ValueError()
    except ValueError:
        raise RunnerError("EXPORT_FAILED") from None
    return result


def run_export(request, identity):
    runtime = request["runtime"]
    verify_runtime(runtime, identity)
    module = load_exporter(request["exporterSource"])

    def checked_history(prompt_id):
        verify_runtime(runtime, identity)
        result = get_history(prompt_id)
        verify_runtime(runtime, identity)
        return result

    def output_root():
        verify_runtime(runtime, identity)
        return runtime["outputRoot"]

    try:
        service = module.ExportService(output_root, checked_history)
        result = asyncio.run(service.execute(request["payload"], request["operation"] == "upload"))
        verify_runtime(runtime, identity)
        return archive_file(result)
    except module.ExportError as error:
        raise RunnerError(error.code if error.code in EXPORT_CODES else "EXPORT_FAILED") from None


def main(request):
    output = sys.stdout
    try:
        with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
            operation = validate_request(request)
            if operation == "inspect":
                result = inspect_runtime()[0]
            else:
                identity = verify_runtime(request["runtime"])
                result = run_export(request, identity)
            raw = encode_json(result, MAX_RESULT_BYTES).decode("ascii")
    except RunnerError as error:
        code = error.code if error.code in RUNNER_CODES | EXPORT_CODES else "RUNNER_FAILED"
        raw = json.dumps({"error": code}, separators=(",", ":"))
    except (TimeoutError, asyncio.TimeoutError):
        raw = '{"error":"TIMEOUT"}'
    except BaseException:
        raw = '{"error":"RUNNER_FAILED"}'
    output.write(raw + "\n")
    output.flush()
if "request" in globals():
    main(request)

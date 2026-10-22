import io
import json
import os
import pathlib
import posixpath
import subprocess
import sys
import tempfile
import time
import types
import unittest
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from unittest.mock import patch

import ssh_runner as runner
import test_exporter as fixtures


SOURCE = pathlib.Path(__file__).with_name("ssh_runner.py").read_text(encoding="utf-8")
EXPORTER_SOURCE = pathlib.Path(__file__).with_name("exporter.py").read_text(encoding="utf-8")
RUNTIME = {"python": "/usr/bin/python3", "outputRoot": "/srv/comfy/output", "port": 8188, "pid": 123}
IDENTITY = "123456"
BOOTSTRAP = (
    "import json,sys\n"
    "request=json.load(sys.stdin)\n"
    "source=request.pop('runnerSource')\n"
    "exec(compile(source,'<ssh-runner>','exec'),{'request':request})\n"
)


def request(operation="describe"):
    payload = fixtures.payload()
    payload["expiresAt"] = int(time.time() * 1000) + 60_000
    if operation == "upload":
        payload.update(file=fixtures.file_info(), target=fixtures.target())
    return {"operation": operation, "runtime": dict(RUNTIME),
            "exporterSource": EXPORTER_SOURCE, "payload": payload}


def invoke(value):
    stdout, stderr = io.StringIO(), io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        runner.main(value)
    raw = stdout.getvalue()
    result = json.loads(raw)
    if raw.count("\n") != 1 or stderr.getvalue():
        raise AssertionError("Runner must emit exactly one JSON line and no diagnostics")
    return result


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.links = {}
        self.realpaths = {}
        self.enterContext(patch.object(runner, "PROC_ROOT", self.root.as_posix()))
        self.enterContext(patch.object(runner.os, "readlink", side_effect=self.links.__getitem__))
        self.enterContext(patch.object(runner.os.path, "realpath", side_effect=self.realpath))
        self.enterContext(patch.object(runner.os.path, "isdir", return_value=True))

    def realpath(self, path):
        normalized = posixpath.normpath(path)
        return self.realpaths.get(normalized, normalized)

    def process(self, pid=123, args=None, cwd="/srv/comfy", executable="/usr/bin/python3", start=IDENTITY):
        directory = self.root / str(pid)
        directory.mkdir(exist_ok=True)
        argv = ["python3", "main.py"] if args is None else args
        (directory / "cmdline").write_bytes(b"\0".join(value.encode() for value in argv) + b"\0")
        (directory / "stat").write_text(f"{pid} (python main) S " + "0 " * 18 + start + " 0\n")
        self.links[directory.as_posix() + "/cwd"] = cwd
        self.links[directory.as_posix() + "/exe"] = executable

    def test_default_port_script_directory_and_real_executable(self):
        self.process(args=["/venv/bin/python", "-u", "/srv/comfy/main.py"], cwd="/work")
        self.assertEqual(runner.inspect_runtime(), (RUNTIME, IDENTITY))
        self.assertEqual(set(invoke({"operation": "inspect"})), {"python", "outputRoot", "port", "pid"})

    def test_relative_and_absolute_output_options_and_realpath(self):
        for args, expected in [
            (["--output-directory", "../results"], "/srv/results"),
            (["--output-directory=/disk/results"], "/disk/results"),
            (["--port=8188", "--output-directory", "linked"], "/real/output"),
        ]:
            with self.subTest(args=args):
                self.realpaths["/srv/comfy/linked"] = "/real/output"
                self.process(args=["python3", "main.py"] + args)
                self.assertEqual(runner.inspect_runtime()[0]["outputRoot"], expected)

    def test_default_output_uses_real_main_script_directory_not_cwd(self):
        self.realpaths["/links/main.py"] = "/srv/comfy/main.py"
        self.process(args=["python3", "../links/main.py"], cwd="/work")
        self.assertEqual(runner.inspect_runtime()[0]["outputRoot"], "/srv/comfy/output")

    def test_other_ports_and_non_main_commands_are_ignored(self):
        self.process()
        for pid, args in [
            (124, ["python3", "main.py", "--port", "8189"]),
            (125, ["python3", "main.py", "--port=8187"]),
            (126, ["python3", "other.py", "main.py"]),
            (127, ["python3", "-c", "main.py"]),
            (128, ["python3", "-m", "main.py"]),
        ]:
            self.process(pid=pid, args=args)
        self.assertEqual(runner.inspect_runtime()[0], RUNTIME)

    def test_ambiguous_and_missing_processes_fail_closed(self):
        self.assertEqual(invoke({"operation": "inspect"}), {"error": "COMFY_NOT_FOUND"})
        self.process()
        self.process(pid=124)
        self.assertEqual(invoke({"operation": "inspect"}), {"error": "COMFY_AMBIGUOUS"})

    def test_invalid_or_duplicate_options_do_not_guess(self):
        for args in [["--port"], ["--port=no"], ["--port", "8188", "--port=8189"],
                     ["--output-directory"], ["--output-directory="],
                     ["--output-directory", "/one", "--output-directory=/two"]]:
            with self.subTest(args=args):
                self.process(args=["python3", "main.py"] + args)
                self.assertEqual(invoke({"operation": "inspect"}), {"error": "COMFY_NOT_FOUND"})

    def test_python_option_values_are_not_mistaken_for_script(self):
        self.process(args=["python3", "-X", "dev", "-Wignore", "-B", "main.py", "--port", "8188"])
        self.assertEqual(runner.inspect_runtime()[0], RUNTIME)

    def test_runtime_path_pid_port_and_output_changes_rejected(self):
        self.process()
        for key, value in [("pid", 124), ("python", "/other/python"),
                           ("outputRoot", "/other/output"), ("port", 8189)]:
            with self.subTest(key=key), self.assertRaisesRegex(runner.RunnerError, "RUNTIME_CHANGED"):
                runner.verify_runtime(dict(RUNTIME, **{key: value}))

    def test_pid_reuse_between_runtime_checks_rejected(self):
        self.process()
        identity = runner.verify_runtime(RUNTIME)
        self.process(start="999999")
        with self.assertRaisesRegex(runner.RunnerError, "RUNTIME_CHANGED"):
            runner.verify_runtime(RUNTIME, identity)

    def test_process_disappears_or_changes_during_probe(self):
        self.process()
        with patch.object(runner, "start_time", side_effect=[IDENTITY, "999999"]):
            self.assertEqual(invoke({"operation": "inspect"}), {"error": "COMFY_NOT_FOUND"})
        (self.root / "123" / "cmdline").unlink()
        with self.assertRaisesRegex(runner.RunnerError, "RUNTIME_CHANGED"):
            runner.verify_runtime(RUNTIME)

    def test_only_required_proc_files_are_read_and_cmdline_is_bounded(self):
        self.process(args=["python3", "main.py", "--private-value", "DO_NOT_OUTPUT"])
        original = runner.read_proc
        with patch.object(runner, "read_proc", wraps=original) as read:
            result = invoke({"operation": "inspect"})
        self.assertEqual(result, RUNTIME)
        self.assertEqual({call.args[1] for call in read.call_args_list}, {"cmdline", "stat"})
        (self.root / "123" / "cmdline").write_bytes(b"x" * (runner.MAX_PROC_BYTES + 1))
        self.assertEqual(invoke({"operation": "inspect"}), {"error": "COMFY_NOT_FOUND"})

    def test_fixed_ts_bootstrap_pops_source_and_runner_calls_main(self):
        self.process()
        source = SOURCE.replace('PROC_ROOT = "/proc"', "PROC_ROOT = " + repr(self.root.as_posix()))
        value = {"operation": "inspect", "runnerSource": source}
        stdin = io.StringIO(json.dumps(value))
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(sys, "stdin", stdin), redirect_stdout(stdout), redirect_stderr(stderr):
            exec(BOOTSTRAP, {})
        self.assertEqual(json.loads(stdout.getvalue()), RUNTIME)
        self.assertEqual(stdout.getvalue().count("\n"), 1)
        self.assertEqual(stderr.getvalue(), "")


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.response = types.SimpleNamespace(status=200)
        self.response.getheader = lambda name, default=None: default
        self.response.read = lambda size: json.dumps({"prompt:one": {"status": {}}}).encode()
        self.connection = unittest.mock.Mock()
        self.connection.getresponse.return_value = self.response
        self.factory = self.enterContext(patch.object(runner.http.client, "HTTPConnection", return_value=self.connection))

    def test_exact_localhost_path_timeout_no_proxy_or_redirect_transport(self):
        with patch.dict(os.environ, {"http_proxy": "http://forbidden.invalid", "HTTP_PROXY": "http://forbidden.invalid"}):
            self.assertEqual(runner.get_history("prompt:one"), {"prompt:one": {"status": {}}})
        self.factory.assert_called_once_with("127.0.0.1", 8188, timeout=10)
        self.connection.request.assert_called_once_with(
            "GET", "/history/prompt%3Aone", headers={"Accept": "application/json",
            "Accept-Encoding": "identity", "Connection": "close"})
        self.connection.close.assert_called_once()

    def test_invalid_prompt_cannot_change_host_path_or_query(self):
        for prompt in ["", "../secret", "/history", "id?url=https://secret", "id#fragment", "id\r\nHost:evil", "x" * 257]:
            with self.subTest(prompt=prompt), self.assertRaisesRegex(runner.RunnerError, "INVALID_REQUEST"):
                runner.get_history(prompt)
        self.factory.assert_not_called()

    def test_redirect_non_success_and_compressed_responses_rejected(self):
        for status in [301, 302, 303, 307, 308, 400, 404, 500]:
            with self.subTest(status=status), self.assertRaisesRegex(runner.RunnerError, "HISTORY_FAILED"):
                self.response.status = status
                runner.get_history("prompt:one")
        self.response.status = 200
        self.response.getheader = lambda name, default=None: "gzip" if name == "Content-Encoding" else default
        with self.assertRaisesRegex(runner.RunnerError, "HISTORY_FAILED"):
            runner.get_history("prompt:one")

    def test_declared_and_streamed_one_mib_limits(self):
        self.response.getheader = lambda name, default=None: str(runner.MAX_HISTORY_BYTES + 1) if name == "Content-Length" else default
        self.response.read = unittest.mock.Mock(return_value=b"x" * (runner.MAX_HISTORY_BYTES + 1))
        with self.assertRaisesRegex(runner.RunnerError, "HISTORY_TOO_LARGE"):
            runner.get_history("prompt:one")
        self.response.read.assert_not_called()
        self.response.getheader = lambda name, default=None: default
        with self.assertRaisesRegex(runner.RunnerError, "HISTORY_TOO_LARGE"):
            runner.get_history("prompt:one")
        self.response.read.assert_called_once_with(runner.MAX_HISTORY_BYTES + 1)

    def test_exact_one_mib_json_is_accepted(self):
        raw = json.dumps({"prompt:one": {}}).encode()
        raw += b" " * (runner.MAX_HISTORY_BYTES - len(raw))
        self.response.read = lambda size: raw
        self.assertEqual(runner.get_history("prompt:one"), {"prompt:one": {}})

    def test_other_prompt_full_history_duplicate_keys_and_invalid_json_rejected(self):
        for raw in [b"{}", b'{"other":{}}', b'{"prompt:one":{},"other":{}}',
                    b'{"prompt:one":{},"prompt:one":{}}', b'{"prompt:one":NaN}', b"[]", b"\xff"]:
            with self.subTest(raw=raw), self.assertRaisesRegex(runner.RunnerError, "INVALID_HISTORY"):
                self.response.read = lambda size: raw
                runner.get_history("prompt:one")

    def test_network_error_is_sanitized_and_connection_closed(self):
        self.connection.request.side_effect = OSError("private URL credential source")
        with self.assertRaisesRegex(runner.RunnerError, "^HISTORY_FAILED$"):
            runner.get_history("prompt:one")
        self.connection.close.assert_called_once()

    def test_total_wall_clock_timeout_not_only_socket_timeout(self):
        def slow(_prompt):
            time.sleep(0.1)
            return {}

        with patch.object(runner, "fetch_history", side_effect=slow), \
                patch.object(runner, "HISTORY_TIMEOUT_SECONDS", 0.01):
            started = time.monotonic()
            with self.assertRaisesRegex(runner.RunnerError, "HISTORY_TIMEOUT"):
                runner.get_history("prompt:one")
            self.assertLess(time.monotonic() - started, 0.09)


class ProtocolTests(unittest.TestCase):
    def test_request_shapes_source_payload_and_runtime_limits(self):
        for value in [None, [], {}, {"operation": "inspect", "extra": True},
                      {"operation": "other"}, dict(request(), unexpected=True)]:
            with self.subTest(value=type(value)):
                self.assertEqual(invoke(value), {"error": "INVALID_REQUEST"})
        for source, code in [(None, "INVALID_SOURCE"), ("", "INVALID_SOURCE"),
                             ("a\0b", "INVALID_SOURCE"),
                             ("x" * (runner.MAX_SOURCE_BYTES + 1), "SOURCE_TOO_LARGE")]:
            self.assertEqual(invoke(dict(request(), exporterSource=source)), {"error": code})
        value = request()
        value["payload"]["extra"] = "x" * runner.MAX_PAYLOAD_BYTES
        self.assertEqual(invoke(value), {"error": "REQUEST_TOO_LARGE"})
        for runtime in [None, {}, dict(RUNTIME, port=True), dict(RUNTIME, pid=True),
                        dict(RUNTIME, python="relative"), dict(RUNTIME, outputRoot="/root\0private")]:
            self.assertEqual(invoke(dict(request(), runtime=runtime)), {"error": "INVALID_RUNTIME"})

    def test_json_limits_duplicates_invalid_encoding_and_constants(self):
        for raw in [b'{"operation":"inspect","operation":"upload"}', b'{"value":NaN}', b"\xff", b"{"]:
            with self.subTest(raw=raw), self.assertRaises(runner.RunnerError):
                runner.decode_json(raw)
        with self.assertRaisesRegex(runner.RunnerError, "REQUEST_TOO_LARGE"):
            runner.decode_json(b" " * (runner.MAX_REQUEST_BYTES + 1))
        self.assertEqual(invoke({"operation": "inspect", "large": "x" * runner.MAX_REQUEST_BYTES}),
                         {"error": "REQUEST_TOO_LARGE"})

    def test_fixed_error_allowlist_never_prints_exception_source_or_url(self):
        secret = "https://private.invalid/?credential=TOP_SECRET\nsource code"
        for error in [RuntimeError(secret), SyntaxError(secret), SystemExit(secret), runner.RunnerError(secret)]:
            with self.subTest(error=type(error)), patch.object(runner, "inspect_runtime", side_effect=error):
                self.assertEqual(invoke({"operation": "inspect"}), {"error": "RUNNER_FAILED"})

    def test_runner_executes_directly_without_spawning(self):
        value = request()
        with patch.object(runner, "verify_runtime", return_value=IDENTITY) as verify, \
                patch.object(runner, "run_export", return_value=fixtures.file_info()) as execute, \
                patch.object(subprocess, "Popen") as launch:
            self.assertEqual(invoke(value), fixtures.file_info())
        verify.assert_called_once_with(RUNTIME)
        execute.assert_called_once_with(value, IDENTITY)
        launch.assert_not_called()

    def test_changed_runtime_prevents_export(self):
        with patch.object(runner, "inspect_runtime", return_value=(dict(RUNTIME, pid=999), IDENTITY)), \
                patch.object(runner, "run_export") as execute:
            self.assertEqual(invoke(request()), {"error": "RUNTIME_CHANGED"})
        execute.assert_not_called()

    def test_export_errors_and_timeouts_are_sanitized(self):
        with patch.object(runner, "verify_runtime", return_value=IDENTITY):
            for error, expected in [(runner.RunnerError("FILE_CHANGED"), "FILE_CHANGED"),
                                    (runner.RunnerError("https://secret"), "RUNNER_FAILED"),
                                    (RuntimeError("https://secret"), "RUNNER_FAILED")]:
                with self.subTest(error=type(error)), patch.object(runner, "run_export", side_effect=error):
                    self.assertEqual(invoke(request()), {"error": expected})
            with patch.object(runner, "run_export", side_effect=TimeoutError("secret")):
                self.assertEqual(invoke(request()), {"error": "TIMEOUT"})


class ExportReuseTests(unittest.TestCase):
    def setUp(self):
        self.value = request()
        self.history = fixtures.history(self.value["payload"])
        self.modules = []
        self.stream = tempfile.TemporaryFile("w+b")
        self.addCleanup(self.stream.close)
        self.stream.write(fixtures.DATA)
        self.stream.flush()
        self.enterContext(patch.object(runner, "verify_runtime", return_value=IDENTITY))
        self.history_mock = self.enterContext(patch.object(runner, "get_history", return_value=self.history))
        original_load = runner.load_exporter

        def load(source):
            module = original_load(source)
            self.modules.append(module)

            @contextmanager
            def opened(_root, _output):
                yield self.stream, module.fingerprint(os.fstat(self.stream.fileno()))

            module.open_output = opened
            return module

        self.enterContext(patch.object(runner, "load_exporter", side_effect=load))

    def run_request(self, value=None):
        return invoke(self.value if value is None else value)

    def test_real_export_service_describes_real_bytes_in_independent_module(self):
        self.assertEqual(self.run_request(), fixtures.file_info())
        self.assertEqual(self.modules[0].ExportService.__module__, "_hailuo_ssh_exporter")
        self.assertIsNot(self.modules[0], fixtures.exporter)
        self.history_mock.assert_called_once_with(self.value["payload"]["promptId"])
        self.assertNotIn("_hailuo_ssh_exporter", sys.modules)

    def test_real_service_history_ownership_and_failure_status_enforced(self):
        for change, code in [("owner", "HISTORY_MISMATCH"), ("status", "HISTORY_NOT_SUCCEEDED"),
                             ("output", "HISTORY_MISMATCH")]:
            entry = fixtures.history(self.value["payload"])
            prompt = entry[self.value["payload"]["promptId"]]
            if change == "owner":
                prompt["prompt"][3]["hailuoAttemptId"] = "other-job"
            elif change == "status":
                prompt["status"]["completed"] = False
            else:
                prompt["outputs"] = {}
            with self.subTest(change=change):
                self.history_mock.return_value = entry
                self.assertEqual(self.run_request(), {"error": code})

    def test_real_service_validates_expiry_and_paths_before_history(self):
        self.value["payload"]["expiresAt"] = 1
        self.assertEqual(self.run_request(), {"error": "INVALID_EXPIRY"})
        self.history_mock.assert_not_called()
        self.value = request()
        self.value["payload"]["output"]["subfolder"] = "../private"
        self.assertEqual(self.run_request(), {"error": "INVALID_PATH"})
        self.history_mock.assert_not_called()

    def test_runtime_rechecked_before_open_and_after_history(self):
        with patch.object(runner, "verify_runtime", side_effect=[IDENTITY, IDENTITY, IDENTITY, runner.RunnerError("RUNTIME_CHANGED")]):
            self.assertEqual(self.run_request(), {"error": "RUNTIME_CHANGED"})

    def test_real_service_upload_calls_existing_uploader_and_rechecks_history(self):
        self.value = request("upload")
        self.value["payload"]["expiresAt"] = fixtures.CURRENT_MS + 60_000
        original_load = runner.load_exporter
        uploaded = []

        def load(source):
            module = original_load(source)
            module.now_ms = lambda: fixtures.CURRENT_MS

            async def upload(stream, original, file, target, payload):
                uploaded.append((stream.read(), file, target, payload))
                return file

            module.ExportService.__init__.__defaults__ = (upload,)
            return module

        with patch.object(runner, "load_exporter", side_effect=load):
            self.assertEqual(self.run_request(), fixtures.file_info())
        self.assertEqual(self.history_mock.call_count, 2)
        self.assertEqual(uploaded[0][0], fixtures.DATA)
        self.assertEqual(uploaded[0][1], fixtures.file_info())
        self.assertEqual(uploaded[0][2], self.value["payload"]["target"])

    def test_source_logging_syntax_and_exception_messages_do_not_escape(self):
        prefix = "import sys\nprint('PRIVATE SOURCE URL')\nprint('PRIVATE STDERR', file=sys.stderr)\n"
        self.value["exporterSource"] = prefix + EXPORTER_SOURCE
        self.assertEqual(self.run_request(), fixtures.file_info())
        for source in ["not valid Python !!! private URL", "raise RuntimeError('private URL credential')",
                       "raise SystemExit('private source')"]:
            self.value["exporterSource"] = source
            self.assertEqual(self.run_request(), {"error": "RUNNER_FAILED"})


if __name__ == "__main__":
    unittest.main()

import hashlib
import io
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path

from fastapi.testclient import TestClient

from worker import create_app


def wav():
    stream = io.BytesIO()
    with wave.open(stream, "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", ""))
        audio.writeframes(b"\x00\x00" * 8000)
    return stream.getvalue()


class JobsTest(unittest.TestCase):
    def test_manifest_upload_resume_and_idempotent_submit(self):
        payload = wav()
        other = payload[:-2] + b"\x01\x00"
        digest = hashlib.sha256(payload).hexdigest()
        job = {
            "id": "one",
            "inputs": [
                {"id": "a", "sha256": digest, "size": len(payload), "durationMs": 500},
                {"id": "b", "sha256": hashlib.sha256(other).hexdigest(), "size": len(other), "durationMs": 500},
            ],
        }
        calls = []
        release_inference = threading.Event()

        def model(paths, language):
            calls.append(language)
            assert [path.read_bytes() for path in paths] == [payload, other]
            release_inference.wait(3)
            return ["十二点二十得回车间", "能"]

        control = {"Authorization": "Bearer internal"}
        with tempfile.TemporaryDirectory() as tmp:
            app = create_app(load=lambda: model, root=tmp, token="internal")
            with TestClient(app) as c:
                self.assertEqual(c.get("/health").json()["ready"], True)
                self.assertEqual(c.post("/v1/jobs", json=job).status_code, 401)
                first = c.post("/v1/jobs", json=job, headers=control).json()
                upload = {"Authorization": "Bearer " + first["uploadToken"]}
                self.assertEqual(c.post("/v1/jobs", json=job, headers=control).json(), first)
                underdeclared = {
                    **job, "id": "two", "inputs": [{**job["inputs"][0], "durationMs": 1}],
                }
                second = c.post("/v1/jobs", json=underdeclared, headers=control).json()
                wrong_duration = c.put(
                    "/v1/jobs/two/audio/a",
                    headers={"Authorization": "Bearer " + second["uploadToken"]},
                    content=payload,
                )
                self.assertEqual(wrong_duration.status_code, 422)
                self.assertEqual(wrong_duration.json()["detail"]["code"], "ASR_AUDIO_DURATION_MISMATCH")
                conflict = c.post("/v1/jobs", json={**job, "language": "Auto"}, headers=control)
                self.assertEqual(conflict.status_code, 409)
                early = c.post("/v1/jobs/one/start", headers=control)
                self.assertEqual(early.json()["detail"]["code"], "ASR_INPUTS_MISSING")
                self.assertEqual(c.get("/v1/jobs/one", headers=upload).status_code, 401)
                wrong_bytes = c.put("/v1/jobs/one/audio/a", headers=upload, content=payload[:-1] + b"x")
                self.assertEqual(wrong_bytes.json()["detail"]["code"], "ASR_INPUT_MISMATCH")
                self.assertEqual(c.put("/v1/jobs/one/audio/a", headers=upload, content=payload).json(), job["inputs"][0])
                self.assertEqual(c.put("/v1/jobs/one/audio/b", headers=upload, content=other).json(), job["inputs"][1])
                self.assertEqual(c.post("/v1/jobs/one/start", headers=control).json()["status"], "queued")
                self.assertIn(c.post("/v1/jobs/one/start", headers=control).json()["status"], ("queued", "running"))
                release_inference.set()
                for _ in range(60):
                    reply = c.get("/v1/jobs/one", headers=control).json()
                    if reply["status"] == "succeeded":
                        break
                    time.sleep(0.01)
                self.assertEqual(reply["results"], [
                    {"id": "a", "text": "十二点二十得回车间", "durationMs": 500},
                    {"id": "b", "text": "能", "durationMs": 500},
                ])
                self.assertEqual(calls, ["Chinese"])
                self.assertFalse(Path(tmp, "audio", "one", "a.audio").exists())
            with TestClient(create_app(load=lambda: model, root=tmp, token="internal")) as c:
                self.assertEqual(c.post("/v1/jobs/one/start", headers=control).json(), reply)
                self.assertEqual(c.post("/v1/jobs", json=job, headers=control).json()["uploadToken"], first["uploadToken"])
                self.assertEqual(calls, ["Chinese"])


if __name__ == "__main__":
    unittest.main()

"""One-node Qwen3-ASR worker. Hailuo owns externally visible jobs."""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import sqlite3
import tempfile
import time
from contextlib import asynccontextmanager, closing, suppress
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, Header, HTTPException, Path as RoutePath, Request
from pydantic import BaseModel, Field, StringConstraints

MODEL_NAME = "Qwen/Qwen3-ASR-0.6B"
MODEL_PATH = "/opt/qwen-asr/model"
MODEL_REVISION = "5eb144179a02acc5e5ba31e748d22b0cf3e303b0"
STATE_DIR = "/home/waas/qwen-asr"
MAX_AUDIO_BYTES = 32 * 1024 * 1024
MAX_INPUTS = 128
ID_PATTERN = r"^[a-zA-Z0-9_-]{1,128}$"
Id = Annotated[str, StringConstraints(pattern=ID_PATTERN)]
UrlId = Annotated[str, RoutePath(pattern=ID_PATTERN)]
Auth = Annotated[str | None, Header()]
LOG = logging.getLogger(__name__)


class Input(BaseModel):
    id: Id
    sha256: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
    size: int = Field(ge=1, le=MAX_AUDIO_BYTES)
    durationMs: int = Field(gt=0)


class CreateJob(BaseModel):
    id: Id
    inputs: list[Input] = Field(min_length=1, max_length=MAX_INPUTS)
    language: Literal["Chinese", "Auto"] = "Chinese"


def fail(status, code, message):
    raise HTTPException(status, {"code": code, "message": message})


def stamp():
    return time.time_ns() // 1_000_000


class Jobs:
    def __init__(self, root):
        self.root = root
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.db = sqlite3.connect(root / "jobs.sqlite3")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS jobs ("
            "id TEXT PRIMARY KEY, request TEXT NOT NULL, reply TEXT NOT NULL)"
        )
        self.db.commit()

    def read(self, job_id):
        row = self.db.execute(
            "SELECT request, reply FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
        if row is None:
            fail(404, "ASR_JOB_NOT_FOUND", "语音识别任务不存在")
        return CreateJob.model_validate_json(row[0]), json.loads(row[1])

    def create(self, job):
        reply = {"id": job.id, "status": "awaiting_upload"}
        spec = job.model_dump_json()
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO jobs VALUES (?, ?, ?)",
                (job.id, spec, json.dumps(reply)),
            )
        saved, reply = self.read(job.id)
        if saved != job:
            fail(409, "ASR_JOB_CONFLICT", "同一任务号已有不同的语音清单")
        return reply

    def save(self, reply):
        with self.db:
            self.db.execute(
                "UPDATE jobs SET reply = ? WHERE id = ?",
                (json.dumps(reply, ensure_ascii=False), reply["id"]),
            )

    def pending(self):
        for (job_id, raw) in self.db.execute("SELECT id, reply FROM jobs").fetchall():
            reply = json.loads(raw)
            if reply["status"] in ("queued", "running"):
                self.save({**reply, "status": "queued"})
                yield job_id

    def audio(self, job_id, input_id):
        return self.root / "audio" / job_id / (input_id + ".audio")

    def discard_audio(self, job):
        directory = self.root / "audio" / job.id
        for spec in job.inputs:
            try:
                self.audio(job.id, spec.id).unlink(missing_ok=True)
            except OSError:
                LOG.warning("Unable to delete completed ASR audio for job %s", job.id)
        with suppress(OSError):
            directory.rmdir()


def audio_duration(path):
    import soundfile

    audio = soundfile.info(path)
    if audio.format not in ("WAV", "WAVEX", "FLAC") or audio.frames <= 0:
        raise ValueError("Expected nonempty WAV or FLAC")
    return (1000 * audio.frames + audio.samplerate // 2) // audio.samplerate


def load_model():
    import torch
    from qwen_asr import Qwen3ASRModel

    if not torch.cuda.is_available():
        raise RuntimeError("Qwen ASR worker requires a CUDA GPU")
    model = Qwen3ASRModel.from_pretrained(
        os.environ.get("QWEN_ASR_MODEL_PATH", MODEL_PATH),
        dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16,
        device_map="cuda:0",
        max_inference_batch_size=max(1, int(os.environ.get("QWEN_ASR_MAX_BATCH_SIZE", "16"))),
        max_new_tokens=512,
    )

    def transcribe(paths, language):
        return [
            result.text
            for result in model.transcribe(
                audio=[str(path) for path in paths],
                language=None if language == "Auto" else language,
            )
        ]

    return transcribe


def create_app(*, load=load_model, root=None, token=None):
    @asynccontextmanager
    async def lifespan(app):
        app.state.token = token if token is not None else os.environ["QWEN_ASR_TOKEN"]
        if not app.state.token:
            raise RuntimeError("QWEN_ASR_TOKEN must be set")
        data = Path(root if root is not None else os.environ.get("QWEN_ASR_STATE", STATE_DIR))
        jobs = Jobs(data)
        with closing(jobs.db):
            app.state.jobs = jobs
            app.state.queue = asyncio.Queue()
            for job_id in jobs.pending():
                app.state.queue.put_nowait(job_id)
            transcribe = await asyncio.to_thread(load)
            execution = asyncio.create_task(run_jobs(app.state, transcribe))
            try:
                yield
            finally:
                execution.cancel()
                with suppress(asyncio.CancelledError):
                    await execution

    app = FastAPI(lifespan=lifespan)

    def require_bearer(authorization, expected):
        if not hmac.compare_digest((authorization or "").encode(), ("Bearer " + expected).encode()):
            fail(401, "ASR_UNAUTHORIZED", "语音识别凭证无效")

    def upload_token(job_id):
        return hmac.digest(app.state.token.encode(), ("upload:" + job_id).encode(), "sha256").hex()

    @app.get("/health")
    async def health():
        return {"ready": True, "model": MODEL_NAME, "revision": MODEL_REVISION}

    @app.post("/v1/jobs")
    async def create(job: CreateJob, authorization: Auth = None):
        require_bearer(authorization, app.state.token)
        if len({i.id for i in job.inputs}) != len(job.inputs):
            fail(422, "ASR_DUPLICATE_INPUT", "语音输入编号重复")
        return {**app.state.jobs.create(job), "uploadToken": upload_token(job.id)}

    @app.put("/v1/jobs/{job_id}/audio/{input_id}")
    async def upload(job_id: UrlId, input_id: UrlId, request: Request, authorization: Auth = None):
        require_bearer(authorization, upload_token(job_id))
        jobs = app.state.jobs
        job, _ = jobs.read(job_id)
        spec = next((item for item in job.inputs if item.id == input_id), None)
        if spec is None:
            fail(404, "ASR_INPUT_NOT_FOUND", "音频不在任务清单内")
        target = jobs.audio(job_id, input_id)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temp = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, dir=target.parent) as out:
                temp = Path(out.name)
                digest = hashlib.sha256()
                length = 0
                async for chunk in request.stream():
                    length += len(chunk)
                    if length > spec.size:
                        fail(413, "ASR_INPUT_SIZE_MISMATCH", "收到的音频超出清单大小")
                    digest.update(chunk)
                    out.write(chunk)
                if length != spec.size or digest.hexdigest() != spec.sha256:
                    fail(422, "ASR_INPUT_MISMATCH", "收到的音频与清单不符")
                out.flush()
            try:
                duration = await asyncio.to_thread(audio_duration, temp)
            except (RuntimeError, ValueError):
                fail(422, "ASR_AUDIO_INVALID", "音频须为可读取的 WAV 或 FLAC")
            if abs(duration - spec.durationMs) > 10:
                fail(422, "ASR_AUDIO_DURATION_MISMATCH", "实际音频时长与清单不符")
            _, reply = jobs.read(job_id)
            if reply["status"] == "awaiting_upload":
                os.replace(temp, target)
            return {**spec.model_dump(), "durationMs": duration}
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)

    @app.post("/v1/jobs/{job_id}/start")
    async def start(job_id: UrlId, authorization: Auth = None):
        require_bearer(authorization, app.state.token)
        jobs = app.state.jobs
        job, reply = jobs.read(job_id)
        if reply["status"] == "awaiting_upload":
            if any(not jobs.audio(job_id, spec.id).is_file() for spec in job.inputs):
                fail(409, "ASR_INPUTS_MISSING", "任务还有音频未上传")
            reply = {**reply, "status": "queued", "queuedAt": stamp()}
            jobs.save(reply)
            app.state.queue.put_nowait(job_id)
        return reply

    @app.get("/v1/jobs/{job_id}")
    async def query(job_id: UrlId, authorization: Auth = None):
        require_bearer(authorization, app.state.token)
        _, reply = app.state.jobs.read(job_id)
        return reply

    return app


async def run_jobs(state, transcribe):
    jobs = state.jobs
    while True:
        job_id = await state.queue.get()
        job, reply = jobs.read(job_id)
        reply = {**reply, "status": "running", "startedAt": stamp()}
        jobs.save(reply)
        try:
            audio = [jobs.audio(job_id, spec.id) for spec in job.inputs]
            durations = await asyncio.to_thread(lambda: [audio_duration(path) for path in audio])
            texts = await asyncio.to_thread(transcribe, audio, job.language)
            if len(texts) != len(audio):
                raise RuntimeError("Qwen ASR returned the wrong number of transcripts")
            reply.update(
                status="succeeded",
                results=[
                    {"id": spec.id, "text": text, "durationMs": duration}
                    for spec, text, duration in zip(job.inputs, texts, durations)
                ],
            )
        except Exception:
            LOG.exception("Qwen ASR job %s failed", job_id)
            reply.update(
                status="failed",
                error={"code": "ASR_INFERENCE_FAILED", "message": "Qwen 语音识别执行失败"},
            )
        reply["finishedAt"] = stamp()
        jobs.save(reply)
        jobs.discard_audio(job)


app = create_app()

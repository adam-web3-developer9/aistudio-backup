# Qwen3-ASR worker on AIGate

The service runs Qwen3-ASR-0.6B at a pinned weight revision and keeps a single model resident on CUDA. It accepts WAV or FLAC, returns one transcript per submitted clip and leaves subtitle mapping and forced alignment to the caller.

Use the official AIGate Ubuntu PyTorch system image with CUDA 12.8 or newer. Add HTTP port 18080 when creating the instance. With root access, copy this directory to the instance and run `QWEN_ASR_BASE_PYTHON=/path/to/image/python bash bootstrap.sh` to reuse the image's PyTorch. Set `PIP_NO_INDEX=1` and `PIP_FIND_LINKS` to a wheelhouse prepared for the image's Python version for offline installation. The model, dependencies and launcher live under `/opt/qwen-asr` so AIGate's system-disk snapshot includes them. Save the running instance as a personal image after verifying GPU inference.

On each node, mount the runtime data disk at `/home/waas` and provision `/home/waas/qwen-asr/worker.env` with mode 0600 and a deployment-specific `QWEN_ASR_TOKEN` matching Hailuo's node configuration. Keep the token and job data outside the system disk. Start `qwen-asr.service` on systemd instances or run `/opt/qwen-asr/run.sh` with the instance supervisor. `GET /health` returns the model and pinned weight revision after the GPU model has loaded successfully.

## Jobs

The control routes use the deployment bearer. Create with `POST /v1/jobs` and JSON `{"id":"job-1","inputs":[{"id":"shot-01","sha256":"...","size":1234,"durationMs":500}],"language":"Chinese"}`. Identical replays return the current status and the same job-bound upload token. The optional language defaults to Chinese; Auto enables language detection.

The client PUTs each file to `/v1/jobs/{id}/audio/{inputId}` with its raw audio as the body and the job-bound upload bearer. The worker checks byte count, SHA-256 and WAV or FLAC duration rounded to milliseconds, then returns the receipt. Input IDs permit letters, digits, underscore and hyphen. One job accepts up to 128 clips of 32 MiB each.

Hailuo calls `POST /v1/jobs/{id}/start` to enqueue after all uploads committed. Replaying start returns the existing job status. A missing file produces HTTP 409 with `detail.code=ASR_INPUTS_MISSING`, leaving the job available for upload. `GET /v1/jobs/{id}` returns the current status and, on success, ordered `results` with `id`, `text` and measured `durationMs`. Time fields are Unix milliseconds. The worker persists receipts in SQLite, restores queued or interrupted jobs on restart, and removes audio after writing the terminal result.

#!/usr/bin/env bash
set -euo pipefail

set -a
source "${QWEN_ASR_ENV_FILE:-/home/waas/qwen-asr/worker.env}"
set +a
umask 077
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
cd /opt/qwen-asr
exec ./venv/bin/python -m uvicorn worker:app --host 0.0.0.0 \
    --port "${QWEN_ASR_PORT:-18080}" --workers 1

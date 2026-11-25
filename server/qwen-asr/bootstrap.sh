#!/usr/bin/env bash
# Run on an AIGate Ubuntu instance with its CUDA driver installed.
set -euo pipefail

src="$(cd "$(dirname "$0")" && pwd)"
prefix=/opt/qwen-asr
torch_index="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu126}"
base_python="${QWEN_ASR_BASE_PYTHON:-python3}"

if [[ "$base_python" == python3 ]]; then
    apt-get update
    apt-get install -y python3-venv libsndfile1 sox ca-certificates
fi
install -d "$prefix"
install -m 0644 "$src/worker.py" "$src/requirements.txt" "$prefix/"
install -m 0755 "$src/run.sh" "$prefix/"
venv_flags=()
if [[ "$base_python" != python3 ]]; then
    venv_flags+=(--system-site-packages)
fi
"$base_python" -m venv "${venv_flags[@]}" "$prefix/venv"
python="$prefix/venv/bin/python"
if [[ "$base_python" == python3 ]]; then
    "$python" -m pip install --no-cache-dir --index-url "$torch_index" \
        torch==2.8.0 torchvision==0.23.0
fi
"$python" -m pip install --no-cache-dir -r "$prefix/requirements.txt"
"$python" -c 'import torch; assert torch.cuda.is_available(); print(torch.__version__, torch.cuda.get_device_name(0))'

cd "$prefix"
"$python" - <<'PY'
from huggingface_hub import snapshot_download
from worker import MODEL_NAME, MODEL_PATH, MODEL_REVISION

snapshot_download(
    MODEL_NAME,
    revision=MODEL_REVISION,
    local_dir=MODEL_PATH,
    ignore_patterns=["*.md", "*.png", ".gitattributes"],
)
PY

if [[ -d /run/systemd/system ]]; then
    install -m 0644 "$src/qwen-asr.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable qwen-asr.service
fi

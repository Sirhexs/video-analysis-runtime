#!/usr/bin/env python3
"""
本地 ASR：faster-whisper 单次转写（任务结束释放显存）。

用法:
  python transcribe.py audio.wav --model small --device cuda

stdout 仅输出一行 JSON:
  {"text":"...","segments":[{"start":0.1,"end":1.2,"text":"..."}]}
日志走 stderr。
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback


def main() -> int:
    # 子进程管道在中文 Windows 上可能默认采用 GBK；强制 UTF-8，保证 Node 能解析 JSON。
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="faster-whisper local ASR")
    parser.add_argument("audio", help="path to wav/mp3/...")
    parser.add_argument(
        "--model",
        default="small",
        help="tiny|base|small|medium|large-v3 or local path (default: small)",
    )
    parser.add_argument(
        "--device",
        default="cuda",
        choices=["cuda", "cpu", "auto"],
        help="cuda|cpu|auto (default: cuda)",
    )
    parser.add_argument(
        "--compute-type",
        default="",
        help="float16|int8_float16|int8|float32；空则按 device 自动",
    )
    parser.add_argument(
        "--language",
        default="zh",
        help="language code or empty for auto (default: zh)",
    )
    parser.add_argument(
        "--beam-size",
        type=int,
        default=5,
    )
    parser.add_argument(
        "--vad",
        action="store_true",
        help="enable VAD filter",
    )
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            json.dumps(
                {
                    "error": "未安装 faster-whisper。请执行: cd server/asr && python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt"
                },
                ensure_ascii=False,
            )
        )
        return 2

    device = args.device
    if device == "auto":
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"

    compute_type = args.compute_type.strip()
    if not compute_type:
        compute_type = "float16" if device == "cuda" else "int8"

    def run_once(dev: str, ctype: str):
        print(
            f"[asr-local] model={args.model} device={dev} compute_type={ctype}",
            file=sys.stderr,
            flush=True,
        )
        print(
            "[asr-local] 正在加载模型（首次会下载，请耐心等待，勿中断）…",
            file=sys.stderr,
            flush=True,
        )
        model = WhisperModel(args.model, device=dev, compute_type=ctype)
        print("[asr-local] 模型已加载，开始转写…", file=sys.stderr, flush=True)
        lang = args.language.strip() or None
        segments_iter, info = model.transcribe(
            args.audio,
            language=lang,
            beam_size=args.beam_size,
            vad_filter=args.vad,
            condition_on_previous_text=True,
        )
        segments = []
        texts = []
        for seg in segments_iter:
            t = (seg.text or "").strip()
            if not t:
                continue
            segments.append(
                {
                    "start": float(seg.start or 0),
                    "end": float(seg.end or 0),
                    "text": t,
                }
            )
            texts.append(t)
        text = "".join(texts).strip()
        if not text:
            text = " ".join(s["text"] for s in segments).strip()
        out = {
            "text": text,
            "segments": segments,
            "language": getattr(info, "language", lang or ""),
            "duration": float(getattr(info, "duration", 0) or 0),
            "device": dev,
        }
        sys.stdout.write(json.dumps(out, ensure_ascii=False))
        sys.stdout.write("\n")
        sys.stdout.flush()
        print(
            f"[asr-local] done chars={len(text)} segs={len(segments)} lang={out.get('language')} device={dev}",
            file=sys.stderr,
            flush=True,
        )
        return 0

    def is_cuda_lib_error(msg: str) -> bool:
        low = msg.lower()
        return any(
            k in low
            for k in (
                "cublas",
                "cudnn",
                "cuda",
                "nvrtc",
                "cannot load",
                "not found or cannot be loaded",
                "libcudart",
            )
        )

    try:
        return run_once(device, compute_type)
    except Exception as e:
        msg = str(e)
        # GPU 库缺失时自动回退 CPU（笔记本常见：有驱动无完整 CUDA Toolkit）
        if device == "cuda" and is_cuda_lib_error(msg):
            print(
                f"[asr-local] CUDA 不可用（{msg}），自动回退 CPU int8…",
                file=sys.stderr,
                flush=True,
            )
            try:
                return run_once("cpu", "int8")
            except Exception as e2:
                msg = str(e2)
                e = e2

        hint = ""
        low = msg.lower()
        if is_cuda_lib_error(msg):
            hint = (
                "；缺少 CUDA 运行库（如 cublas64_12.dll）。"
                "可装 CUDA Toolkit 12.x，或使用 LOCAL_ASR_DEVICE=cpu"
            )
        if "huggingface" in low or "hub" in low or "connect" in low or "timed out" in low:
            hint += "；网络拉模型失败：.env 设 HF_ENDPOINT=https://hf-mirror.com"
        print(
            json.dumps(
                {
                    "error": msg + hint,
                    "trace": traceback.format_exc()[-800:],
                },
                ensure_ascii=False,
            )
        )
        print(f"[asr-local] failed: {msg}{hint}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

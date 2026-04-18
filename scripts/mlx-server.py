#!/usr/bin/env python3
"""
MLX FastAPI wrapper for llm-tasks pipeline.
Provides an Ollama-compatible /api/generate endpoint using Apple MLX for ~20-30% faster inference on M3 Max.

Install: pip3 install mlx-lm fastapi uvicorn
Usage:   python3 mlx-server.py
         curl http://localhost:8765/api/generate -d '{"model":"mlx-community/Qwen3-35B-A3B-4bit","prompt":"hi"}'
"""

import asyncio
import json
import sys
from contextlib import asynccontextmanager

try:
    import mlx_lm
    from fastapi import FastAPI, Request
    from fastapi.responses import StreamingResponse
    import uvicorn
except ImportError:
    print("Missing dependencies. Install with:")
    print("  pip3 install mlx-lm fastapi uvicorn")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────
HOST = "127.0.0.1"
PORT = 8765
DEFAULT_MODEL = "mlx-community/Qwen3-35B-A3B-4bit"

# Cache loaded models to avoid reloading on every request
_model_cache: dict = {}


def get_model(model_name: str):
    """Load and cache an MLX model."""
    if model_name not in _model_cache:
        print(f"Loading model: {model_name}")
        model, tokenizer = mlx_lm.load(model_name)
        _model_cache[model_name] = (model, tokenizer)
        print(f"Model loaded: {model_name}")
    return _model_cache[model_name]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Preload the default model on startup."""
    print(f"Preloading default model: {DEFAULT_MODEL}")
    get_model(DEFAULT_MODEL)
    print(f"MLX server ready on {HOST}:{PORT}")
    yield
    _model_cache.clear()


app = FastAPI(title="llm-tasks MLX Server", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", "models_loaded": list(_model_cache.keys())}


@app.post("/api/generate")
async def generate(request: Request):
    """Ollama-compatible generate endpoint."""
    body = await request.json()
    model_name = body.get("model", DEFAULT_MODEL)
    prompt = body.get("prompt", "")
    stream = body.get("stream", True)
    max_tokens = body.get("options", {}).get("num_predict", 4096)
    temperature = body.get("options", {}).get("temperature", 0.3)

    model, tokenizer = get_model(model_name)

    if stream:
        return StreamingResponse(
            _stream_generate(model, tokenizer, prompt, max_tokens, temperature),
            media_type="application/x-ndjson",
        )
    else:
        text = mlx_lm.generate(
            model,
            tokenizer,
            prompt=prompt,
            max_tokens=max_tokens,
            temp=temperature,
        )
        return {"model": model_name, "response": text, "done": True}


async def _stream_generate(model, tokenizer, prompt, max_tokens, temperature):
    """Yield Ollama-compatible streaming NDJSON chunks."""
    tokens = []
    for token_text in mlx_lm.stream_generate(
        model, tokenizer, prompt=prompt, max_tokens=max_tokens, temp=temperature
    ):
        tokens.append(token_text)
        chunk = json.dumps({"response": token_text, "done": False})
        yield chunk + "\n"
        await asyncio.sleep(0)  # yield control to event loop

    full_response = "".join(tokens)
    final = json.dumps({"response": "", "done": True, "total_duration": 0})
    yield final + "\n"


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

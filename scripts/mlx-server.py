#!/usr/bin/env python3
"""
MLX FastAPI wrapper for llm-tasks pipeline.
Provides an Ollama-compatible /api/generate endpoint using Apple MLX for ~20-30% faster inference on M3 Max.

Install: pip3 install mlx-lm fastapi uvicorn
Usage:   python3 mlx-server.py
         curl http://localhost:8765/api/generate -d '{"model":"mlx-community/Qwen3.6-35B-A3B-4bit-DWQ","prompt":"hi"}'
"""

import asyncio
import json
import sys
from contextlib import asynccontextmanager

try:
    import mlx_lm
    from mlx_lm.sample_utils import make_sampler
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
DEFAULT_MODEL = "mlx-community/Qwen3.6-35B-A3B-4bit-DWQ"

import gc

# Cache loaded models to avoid reloading on every request — single model eviction
_model_cache: dict = {}


def get_model(model_name: str):
    """Load and cache an MLX model. Evicts other models to fit in memory."""
    if model_name not in _model_cache:
        # Evict all other models before loading a new one
        if _model_cache:
            evicted = list(_model_cache.keys())
            _model_cache.clear()
            gc.collect()
            print(f"Evicted model(s): {', '.join(evicted)}")
        print(f"Loading model: {model_name}")
        model, tokenizer = mlx_lm.load(model_name)
        _model_cache[model_name] = (model, tokenizer)
        print(f"Model loaded: {model_name}")
    return _model_cache[model_name]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lazy-load mode: models load on first request to minimize idle memory."""
    print(f"MLX server ready on {HOST}:{PORT} (lazy-load mode — model loads on first request)")
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
            sampler=make_sampler(temp=temperature),
        )
        text = _strip_think_tags(text)
        return {"model": model_name, "response": text, "done": True}


async def _stream_generate(model, tokenizer, prompt, max_tokens, temperature):
    """Yield Ollama-compatible streaming NDJSON chunks."""
    tokens = []
    for response in mlx_lm.stream_generate(
        model, tokenizer, prompt=prompt, max_tokens=max_tokens, sampler=make_sampler(temp=temperature)
    ):
        token_text = response.text
        tokens.append(token_text)
        chunk = json.dumps({"response": token_text, "done": False})
        yield chunk + "\n"
        await asyncio.sleep(0)  # yield control to event loop

    full_response = "".join(tokens)
    final = json.dumps({"response": "", "done": True, "total_duration": 0})
    yield final + "\n"


# ── OpenAI-compatible endpoints (/v1/) ────────────────────────────

import time
import uuid


import re as _re

_THINK_RE = _re.compile(r"<think>[\s\S]*?</think>\s*", _re.DOTALL)


def _strip_think_tags(text: str) -> str:
    """Remove <think>...</think> blocks that Qwen3 models may emit."""
    return _THINK_RE.sub("", text).strip()


def _messages_to_prompt(messages, tokenizer, enable_thinking=False):
    """Convert OpenAI-style messages to a single prompt string via the tokenizer's chat template."""
    try:
        return tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True,
            enable_thinking=enable_thinking,
        )
    except TypeError:
        # Tokenizer doesn't support enable_thinking kwarg — try without it
        return tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
    except Exception:
        # Fallback: simple concatenation if no chat template
        parts = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                parts.append(f"[System] {content}")
            elif role == "assistant":
                parts.append(f"[Assistant] {content}")
            else:
                parts.append(f"[User] {content}")
        return "\n".join(parts) + "\n[Assistant]"


@app.get("/v1/models")
async def list_models():
    """OpenAI-compatible model listing."""
    models = []
    for name in _model_cache:
        models.append({
            "id": name,
            "object": "model",
            "created": int(time.time()),
            "owned_by": "mlx-local",
        })
    return {"object": "list", "data": models}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """OpenAI-compatible chat completions endpoint."""
    from fastapi.responses import JSONResponse

    body = await request.json()
    model_name = body.get("model", DEFAULT_MODEL)
    messages = body.get("messages", [])
    stream = body.get("stream", False)
    max_tokens = body.get("max_tokens", 4096)
    temperature = body.get("temperature", 0.3)
    enable_thinking = body.get("enable_thinking", False)

    try:
        model, tokenizer = get_model(model_name)
    except Exception as e:
        return JSONResponse(
            status_code=404,
            content={"error": {"message": f"Model not found: {model_name}: {e}", "type": "model_not_found"}},
        )

    try:
        prompt = _messages_to_prompt(messages, tokenizer, enable_thinking=enable_thinking)
    except Exception as e:
        print(f"Error converting messages to prompt: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": {"message": f"Failed to build prompt: {e}", "type": "prompt_error"}},
        )

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    if stream:
        return StreamingResponse(
            _stream_chat_completions(
                model, tokenizer, prompt, max_tokens, temperature,
                model_name, completion_id,
            ),
            media_type="text/event-stream",
        )
    else:
        text = mlx_lm.generate(
            model, tokenizer, prompt=prompt, max_tokens=max_tokens, sampler=make_sampler(temp=temperature),
        )
        if not enable_thinking:
            text = _strip_think_tags(text)
        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model_name,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }


async def _stream_chat_completions(
    model, tokenizer, prompt, max_tokens, temperature, model_name, completion_id
):
    """Yield OpenAI-compatible SSE chunks."""
    created = int(time.time())

    for response in mlx_lm.stream_generate(
        model, tokenizer, prompt=prompt, max_tokens=max_tokens, sampler=make_sampler(temp=temperature)
    ):
        chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_name,
            "choices": [{
                "index": 0,
                "delta": {"content": response.text},
                "finish_reason": None,
            }],
        }
        yield f"data: {json.dumps(chunk)}\n\n"
        await asyncio.sleep(0)

    # Final chunk with finish_reason
    final = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model_name,
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": "stop",
        }],
    }
    yield f"data: {json.dumps(final)}\n\n"
    yield "data: [DONE]\n\n"


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

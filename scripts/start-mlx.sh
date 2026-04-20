#!/bin/bash
# Start the MLX FastAPI server for llm-tasks
# Usage: ./start-mlx.sh [--install]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$SCRIPT_DIR/mlx-server.py"
VENV_DIR="$SCRIPT_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python3"

if [[ "$1" == "--install" ]]; then
    echo "📦 Creating virtual environment at $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
    echo "📦 Installing MLX dependencies..."
    "$VENV_PYTHON" -m pip install --upgrade pip
    "$VENV_PYTHON" -m pip install mlx-lm fastapi uvicorn
    echo "✅ Dependencies installed."
    exit 0
fi

# Check venv exists
if [[ ! -x "$VENV_PYTHON" ]]; then
    echo "❌ Virtual environment not found. Run: $0 --install"
    exit 1
fi

# Check dependencies
if ! "$VENV_PYTHON" -c "import mlx_lm, fastapi, uvicorn" 2>/dev/null; then
    echo "❌ Missing dependencies. Run: $0 --install"
    exit 1
fi

echo "🚀 Starting MLX server on http://127.0.0.1:8765"
exec "$VENV_PYTHON" "$SERVER"

#!/bin/bash
# Start the MLX FastAPI server for llm-tasks
# Usage: ./start-mlx.sh [--install]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$SCRIPT_DIR/mlx-server.py"

if [[ "$1" == "--install" ]]; then
    echo "📦 Installing MLX dependencies..."
    pip3 install mlx-lm fastapi uvicorn
    echo "✅ Dependencies installed."
    exit 0
fi

# Check dependencies
if ! python3 -c "import mlx_lm, fastapi, uvicorn" 2>/dev/null; then
    echo "❌ Missing dependencies. Run: $0 --install"
    exit 1
fi

echo "🚀 Starting MLX server on http://127.0.0.1:8765"
exec python3 "$SERVER"

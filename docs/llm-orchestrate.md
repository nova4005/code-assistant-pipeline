# llm-orchestrate

Autonomous overnight coding pipeline. Picks tasks from each project's backlog, runs them through a 9-phase LLM pipeline, and commits results to git branches — all using local models only (no cloud APIs).

## Installation

Install globally from the repo root:

```bash
npm install -g .
```

Or run directly without installing:

```bash
node /path/to/llm-tasks/orchestrator/cli.js <command>
```

---

## Commands

### `run` — Execute the pipeline

```bash
# Run for all enabled projects in configs/projects.json
llm-orchestrate run

# Run for a single project (uses projects.json config if found, otherwise defaults)
llm-orchestrate run <path>
llm-orchestrate run .
llm-orchestrate run /Users/garrett/Code/myapp
```

Each run:
1. Loads the backlog (manual tasks + scanned TODO/FIXME annotations)
2. Filters tasks by `complexityCeiling` and skips already-completed ones
3. Processes up to `maxTasksPerRun` tasks through the 9-phase pipeline
4. Commits each completed task to a branch named `llm-orchestrator/<task-id>`
5. Writes a Markdown run report to `.llm-orchestrator/reports/run-YYYY-MM-DD.md`

---

### `scan` — Preview auto-detected tasks

```bash
llm-orchestrate scan <path>
llm-orchestrate scan .
```

Walks the project directory and prints tasks that would be generated from code annotations. Does **not** run the pipeline or modify anything.

Detected annotations: `TODO`, `FIXME`, `BUG`, `HACK`, `XXX`, `OPTIMIZE`, `@deprecated`

Scanned file types: `.js` `.ts` `.tsx` `.jsx` `.php` `.py` `.rb` `.go` `.java` `.rs` `.vue` `.svelte` `.css` `.scss` `.md`

---

### `add` — Add a task to the backlog

```bash
llm-orchestrate add <path> "<title>" [options]
llm-orchestrate add . "Add rate limiting to API endpoints"
llm-orchestrate add /path/to/project "Fix null pointer in auth flow" --type bugfix --priority high
```

**Options:**

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--type` | `feature` `bugfix` `refactor` `chore` `docs` `test` | `feature` | Task type |
| `--priority` | `critical` `high` `normal` `low` | `normal` | Task priority |
| `--desc` | string | `""` | Longer description of the task |

Tasks are written to `.llm-orchestrator/backlog.json` in the project folder and picked up on the next `run`.

---

### `status` — Show task state for a project

```bash
llm-orchestrate status <path>
llm-orchestrate status .
```

Reads `.llm-orchestrator/state.json` and prints each task with its current status and completed pipeline phases.

**Status icons:**
- ✅ `complete` — pipeline finished, changes committed to branch
- ⏳ `running` — currently in progress
- ❌ `error` — failed (error message shown)
- ⚪ `pending` — queued but not yet started

---

### `validate` — Verify local-only enforcement

```bash
llm-orchestrate validate
```

Checks that:
- All configured endpoints resolve to `localhost` / `127.0.0.1` / `[::1]`
- No cloud API key env vars are set (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, etc.)

Exits with code `1` and prints warnings if any violations are found.

---

### `health` — Check LLM backend connectivity

```bash
llm-orchestrate health
```

Pings both backends and reports their status:

| Backend | URL | Role |
|---------|-----|------|
| MLX | `localhost:8765` | Primary — required for the pipeline to run |
| Ollama | `localhost:11434` | Fallback only |

Exits with code `1` if MLX is offline.

---

## Pipeline Phases

Each task runs through up to 9 phases in order. Some phases are skipped based on task type (configured in `configs/orchestrator.json`).

| Phase | Model | Purpose |
|-------|-------|---------|
| `triage` | Qwen3.6-35B (planning) | Assess scope, classify complexity |
| `research` | Qwen3.6-35B (planning) | Gather relevant context from codebase |
| `prd` | Qwen3.6-35B (planning) | Write product requirements |
| `tech-research` | Qwen3.6-35B (planning) | Investigate technical approach |
| `design` | Qwen3.6-35B (planning) | Produce architecture/design spec |
| `spec` | Qwen3-Coder-30B (code) | Write detailed implementation spec |
| `build` | Qwen3-Coder-30B (code) | Generate the actual code changes |
| `review` | Qwen3-Coder-30B (code) | Self-review and iterate |
| `audit` | Qwen3.6-35B (planning) | Security and quality audit |

**Phase skipping by task type:**

| Task type | Skipped phases |
|-----------|---------------|
| `docs` | `build` |
| `test` | `prd`, `design` |
| `refactor` | `prd` |
| `chore` | `audit` |

---

## Project Setup

To add a project, append an entry to `configs/projects.json`:

```json
{
  "path": "/absolute/path/to/project",
  "enabled": true,
  "baseBranch": "main",
  "maxTasksPerRun": 2,
  "complexityCeiling": "M",
  "scanOnRun": true,
  "taskFiles": []
}
```

**Project config fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | — | Absolute path to the project root |
| `enabled` | boolean | `true` | Whether this project is included in `run` (all projects) |
| `baseBranch` | string | `"main"` | Branch task branches are created from |
| `maxTasksPerRun` | number | `5` | Max tasks to process in a single run |
| `complexityCeiling` | string | `"M"` | Ignore tasks above this complexity (`XS` `S` `M` `L` `XL`) |
| `scanOnRun` | boolean | `true` | Auto-scan for TODO/FIXME tasks on each run |
| `taskFiles` | array | `[]` | Reserved for future use |

**Requirements in the project folder:**
- Must be a git repository with the configured `baseBranch` present
- Manual tasks: create `.llm-orchestrator/backlog.json` (see below)
- Auto tasks: add `TODO` / `FIXME` / `HACK` / `BUG` / `OPTIMIZE` annotations in source files

**Optional setup script** — run from inside the project folder to configure Husky pre-commit hooks and VS Code tasks:

```bash
cd /path/to/project
node /path/to/llm-tasks/scripts/init-project.js
```

---

## Backlog Format

`.llm-orchestrator/backlog.json` in the project folder:

```json
[
  {
    "id": "task-001",
    "title": "Add input validation to login form",
    "description": "Validate email format and password length before submitting the form",
    "type": "feature",
    "priority": "high",
    "complexity": "S"
  }
]
```

| Field | Required | Values | Description |
|-------|----------|--------|-------------|
| `id` | no | string | Stable ID for deduplication. Auto-generated if omitted via `add` command |
| `title` | yes | string | Short description shown in status and reports |
| `description` | no | string | Full context passed to the LLM pipeline |
| `type` | no | `feature` `bugfix` `refactor` `chore` `docs` `test` | Affects which phases run |
| `priority` | no | `critical` `high` `normal` `low` | Controls processing order |
| `complexity` | no | `XS` `S` `M` `L` `XL` | Tasks above `complexityCeiling` are skipped |

---

## Starting the MLX Backend

The pipeline requires the MLX server to be running before calling `run`:

```bash
./scripts/start-mlx.sh
```

Or start it manually:

```bash
cd scripts
python3 mlx-server.py
```

The server runs on `http://127.0.0.1:8765`. It loads models on demand and evicts the previous model before loading a new one (single-model policy, ~17 GB per model).

Check backend status at any time:

```bash
llm-orchestrate health
```

---

## Scheduling (Launchd)

To run the orchestrator automatically overnight, install the provided launchd plist:

```bash
cp scripts/com.llm-tasks.orchestrator.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.llm-tasks.orchestrator.plist
```

Configured to start at **22:00** and run for up to **8 hours** (`configs/orchestrator.json → schedule`).

To start the MLX server automatically on login:

```bash
cp scripts/com.llm-tasks.mlx.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.llm-tasks.mlx.plist
```

---

## Output & Reports

After each run a Markdown report is written:

- **Single-project run:** `.llm-orchestrator/reports/run-YYYY-MM-DD.md` inside the project folder
- **All-projects run:** `reports/run-YYYY-MM-DD.md` inside the `llm-tasks` repo root

Task state (status, completed phases, errors) persists in `.llm-orchestrator/state.json` in each project folder. Completed task IDs are never re-processed.

---

## Guardrails

Enforced at runtime via `configs/orchestrator.json`:

| Guardrail | Value | Description |
|-----------|-------|-------------|
| `maxLinesChangedPerTask` | 200 | Hard limit on lines the build phase can modify |
| `neverDeleteFiles` | true | Build phase cannot delete existing files |
| `memoryPressureThreshold` | 85% | Pauses before loading a new model if RAM is above this |
| `allowedEndpoints` | localhost only | Any non-local URL throws a hard error |
| `blockedEnvVars` | see validate | Cloud API keys in env cause validation failure |

#!/usr/bin/env node
/**
 * benchmark-quality.js – Quality benchmark for coder models.
 *
 * Runs spec→build→review for both coder models (4bit, 8bit) on
 * 3 large task scenarios. A fixed neutral judge (planning model)
 * reviews all outputs for apples-to-apples comparison.
 *
 * Usage:
 *   node scripts/benchmark-quality.js                     # all scenarios, own-spec
 *   node scripts/benchmark-quality.js --fixed-spec         # all scenarios, fixed spec
 *   node scripts/benchmark-quality.js --scenario 1         # single scenario
 *   node scripts/benchmark-quality.js --scenario 2 --fixed-spec
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// ── Config ──────────────────────────────────────────────────────

const MLX_BASE = 'http://127.0.0.1:8765';
const MAX_LINES = 4000;

const CODER_MODELS = [
  { id: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit', label: 'Coder 4bit', slug: 'coder-4bit' },
  { id: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-6bit-DWQ-lr3e-7', label: 'Coder 6bit-DWQ', slug: 'coder-6bit-dwq' },
];

const JUDGE_MODEL = 'mlx-community/Qwen3.6-35B-A3B-4bit-DWQ';

const FIXED_SPEC_MODE = process.argv.includes('--fixed-spec');
const SCENARIO_FLAG = process.argv.indexOf('--scenario');
const SCENARIO_FILTER = SCENARIO_FLAG !== -1 ? parseInt(process.argv[SCENARIO_FLAG + 1], 10) : null;

const RESULTS_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname), '..', 'test-fixtures', 'benchmark-quality-results.json'
);

// ── Reusable parsers (from build.js / review.js) ────────────────

function parseFileBlocks(buildOutput) {
  const blocks = [];
  // Try strict format first (### `path`)
  const strictRegex = /### `([^`]+)`\s*\n```[\w]*\n([\s\S]*?)```/g;
  let match;
  while ((match = strictRegex.exec(buildOutput)) !== null) {
    blocks.push({ filePath: match[1], content: match[2] });
  }
  if (blocks.length > 0) return blocks;

  // Fallback: handle ## or ### with or without backticks, and possible extra whitespace
  const looseRegex = /#{2,4}\s+`?([^\n`]+?)`?\s*\n+```[\w]*\n([\s\S]*?)```/g;
  while ((match = looseRegex.exec(buildOutput)) !== null) {
    const fp = match[1].trim();
    if (fp.includes('/') || fp.includes('.')) {
      blocks.push({ filePath: fp, content: match[2] });
    }
  }
  return blocks;
}

const VERDICT_PATTERN = /\*{0,2}Verdict\*{0,2}[:\s]+(?:✅|⚠️|❌)?\s*(PASS WITH NOTES|PASS|NEEDS REVISION)/i;
const ISSUES_SECTION_PATTERN = /## Issues Found\n([\s\S]*?)(?=\n## |$)/i;

function parseVerdict(reviewOutput) {
  if (!reviewOutput) return { verdict: 'unknown', issues: '' };
  const verdictMatch = reviewOutput.match(VERDICT_PATTERN);
  let verdict = 'unknown';
  if (verdictMatch) {
    const raw = verdictMatch[1].toUpperCase().trim();
    if (raw === 'PASS') verdict = 'pass';
    else if (raw === 'PASS WITH NOTES') verdict = 'pass_with_notes';
    else if (raw === 'NEEDS REVISION') verdict = 'needs_revision';
  }
  const issuesMatch = reviewOutput.match(ISSUES_SECTION_PATTERN);
  const issues = issuesMatch ? issuesMatch[1].trim() : '';
  return { verdict, issues };
}

function parseIssueCounts(issuesText) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  if (!issuesText) return counts;
  counts.critical = (issuesText.match(/🔴/g) || []).length;
  counts.high = (issuesText.match(/🟠/g) || []).length;
  counts.medium = (issuesText.match(/🟡/g) || []).length;
  counts.low = (issuesText.match(/🟢/g) || []).length;
  return counts;
}

// ── Spec section validator ──────────────────────────────────────

const REQUIRED_SPEC_SECTIONS = [
  'Implementation Plan', 'Constants', 'Test Plan', 'Migration', 'Checklist'
];

function validateSpec(specText) {
  const sections = {};
  for (const section of REQUIRED_SPEC_SECTIONS) {
    sections[section] = specText.includes(`## ${section}`) || specText.toLowerCase().includes(section.toLowerCase());
  }
  const fileCount = (specText.match(/### `[^`]+`/g) || []).length;
  return { sections, fileCount, allPresent: Object.values(sections).every(Boolean) };
}

// ── Syntax checking ─────────────────────────────────────────────

const SYNTAX_CHECK_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json']);

function checkSyntax(filePath) {
  const ext = path.extname(filePath);
  if (!SYNTAX_CHECK_EXTENSIONS.has(ext)) return null;
  if (ext === '.json') {
    try {
      JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return null;
    } catch (err) {
      return `Invalid JSON: ${err.message}`;
    }
  }
  try {
    execFileSync('node', ['--check', filePath], { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    return null;
  } catch (err) {
    return `Syntax error: ${(err.stderr || err.message).split('\n').slice(0, 3).join(' ')}`;
  }
}

// ── Temp dir management ─────────────────────────────────────────

function setupTempDir(modelSlug, scenarioSlug) {
  const dir = path.join(os.tmpdir(), 'benchmark-quality', modelSlug, scenarioSlug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── MLX API call ────────────────────────────────────────────────

async function callModel(modelId, systemPrompt, userPrompt, maxTokens) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 min
  try {
    const res = await fetch(`${MLX_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.15,
        max_tokens: maxTokens,
        stream: false,
        enable_thinking: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API error ${res.status}: ${body}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeout);
  }
}

async function checkHealth() {
  try {
    const res = await fetch(`${MLX_BASE}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    console.log(`MLX server healthy – loaded models: ${data.models_loaded ?? '?'}\n`);
  } catch {
    console.error(`✗ MLX server not reachable at ${MLX_BASE}`);
    console.error(`  Start it first:  python3 scripts/mlx-server.py\n`);
    process.exit(1);
  }
}

// ── Phase runners ───────────────────────────────────────────────

const SPEC_SYSTEM_PROMPT = `You are a senior engineer writing an implementation specification. This spec will be handed directly to a code-generation model, so be precise and unambiguous.

Output a markdown document with these sections:

## Implementation Plan
Ordered list of file changes. For each file:

### \`path/to/file.ext\`
- **Action**: create | modify | delete
- **Purpose**: One-line description
- **Pseudocode**:
\`\`\`
// Step-by-step pseudocode showing the implementation logic
\`\`\`
- **Key decisions**: Any important implementation choices

## Constants & Configuration
List any new constants, config values, or environment variables.

## Test Plan
For each test file:
### \`path/to/test.ext\`
- Test cases with inputs and expected outputs

## Migration Notes
Any database migrations, config changes, or manual steps needed.

## Checklist
- [ ] All files listed
- [ ] All edge cases covered in pseudocode
- [ ] All tests specified
- [ ] No breaking changes to existing APIs (or migration plan provided)

Be concrete: use actual file paths, function names, and data structures from the design and tech research.`;

const BUILD_SYSTEM_PROMPT = `You are a senior software engineer implementing code based on a detailed specification.

RULES:
1. Output ONLY the code files. No explanations outside of code blocks.
2. For each file, use this exact format:

### \`path/to/file.ext\`
\`\`\`language
// full file contents here
\`\`\`

3. Include ALL necessary imports and exports.
4. Follow existing code style and conventions in the project.
5. Include inline comments for complex logic.
6. Do NOT generate test files — those come in a separate phase.
7. Do NOT delete any existing files.
8. Maximum ${MAX_LINES} total lines of new/changed code.

Output ONLY the files. Start directly with the first ### heading.`;

const REVIEW_SYSTEM_PROMPT = `You are a STRICT senior code reviewer performing a final quality review of auto-generated code. You are the last line of defense before this code is committed. Be skeptical — auto-generated code frequently has subtle issues.

Review the code for:
1. **Correctness** — Does it match the spec and PRD requirements? Are there logic errors?
2. **Security** — Any injection vectors, data exposure, or auth issues?
3. **Performance** — Any obvious N+1 queries, memory leaks, or blocking operations?
4. **Style** — Does it follow the project's existing conventions?
5. **Completeness** — Are all requirements from the spec addressed? Are any missing?
6. **Edge Cases** — Are edge cases from the tech research handled?
7. **Syntax Errors** — Check the build output's syntax check section. Any syntax errors MUST result in NEEDS REVISION.

VERDICT RULES:
- ❌ NEEDS REVISION if ANY of: syntax errors reported, security issues, missing requirements, logic errors
- ⚠️ PASS WITH NOTES if: minor style issues, non-blocking suggestions only
- ✅ PASS if: code is correct, complete, secure, and follows conventions

Be specific. Cite file names and line numbers when reporting issues.

Format your response as:

## Review Summary
- **Verdict**: ✅ PASS | ⚠️ PASS WITH NOTES | ❌ NEEDS REVISION
- **Confidence**: high | medium | low

## Checklist
- [ ] Matches PRD acceptance criteria
- [ ] No security vulnerabilities introduced
- [ ] No performance regressions
- [ ] Follows project conventions
- [ ] Edge cases handled
- [ ] No files deleted
- [ ] Line count within limits

## Issues Found
List issues by severity (🔴 Critical, 🟠 High, 🟡 Medium, 🟢 Low).

## Suggestions
Improvements that are nice-to-have but not blocking.

## Next Steps
What a human reviewer should focus on when reviewing this branch.`;

async function runSpec(modelId, scenario) {
  const userPrompt = `Task: ${scenario.task.title}
Type: ${scenario.task.type}

## Design
${scenario.context.design}

## Tech Research
${scenario.context['tech-research']}

## PRD
${scenario.context.prd}`;

  return await callModel(modelId, SPEC_SYSTEM_PROMPT, userPrompt, 8192);
}

async function runBuild(modelId, scenario, spec, tempDir) {
  const userPrompt = `Task: ${scenario.task.title}
Type: ${scenario.task.type}

## Spec
${spec}

## Design
${scenario.context.design}

## Tech Research
${scenario.context['tech-research']}`;

  const buildOutput = await callModel(modelId, BUILD_SYSTEM_PROMPT, userPrompt, 8192);
  const fileBlocks = parseFileBlocks(buildOutput);

  if (fileBlocks.length === 0) {
    const dumpPath = path.join(tempDir, '_raw_build_output.txt');
    fs.writeFileSync(dumpPath, buildOutput);
    console.log(`\n  ⚠ parseFileBlocks matched 0 files — raw output dumped to ${dumpPath}`);
    console.log(`  ⚠ First 500 chars: ${buildOutput.slice(0, 500).replace(/\n/g, '\\n')}`);
  }

  let totalLines = 0;
  const writtenFiles = [];
  const syntaxErrors = [];
  let hitLineLimit = false;

  for (const block of fileBlocks) {
    const lines = block.content.split('\n').length;
    if (totalLines + lines > MAX_LINES) {
      hitLineLimit = true;
      break;
    }

    const fullPath = path.join(tempDir, block.filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, block.content);
    totalLines += lines;
    writtenFiles.push(block.filePath);

    const syntaxErr = checkSyntax(fullPath);
    if (syntaxErr) syntaxErrors.push({ file: block.filePath, error: syntaxErr });
  }

  // Build the written code text for the reviewer
  const writtenCodeText = fileBlocks
    .filter(b => writtenFiles.includes(b.filePath))
    .map(b => `### ${b.filePath}\n\`\`\`\n${b.content}\n\`\`\``)
    .join('\n\n');

  const syntaxSection = syntaxErrors.length > 0
    ? `## Syntax Errors (${syntaxErrors.length})\n${syntaxErrors.map(e => `- \`${e.file}\`: ${e.error}`).join('\n')}`
    : '## Syntax Check\nAll files passed syntax checks.';

  const buildSummary = `## Build Summary\nFiles written (${writtenFiles.length}):\n${writtenFiles.map(f => `- \`${f}\``).join('\n')}\nTotal lines: ${totalLines}\n\n${syntaxSection}\n\n---\n## Raw Build Output\n${buildOutput}`;

  return {
    buildOutput: buildSummary,
    rawBuildOutput: buildOutput,
    filesWritten: writtenFiles.length,
    totalLines,
    syntaxErrors: syntaxErrors.length,
    syntaxErrorDetails: syntaxErrors,
    hitLineLimit,
    writtenCodeText,
  };
}

async function runReview(scenario, spec, buildOutput, writtenCodeText) {
  const userPrompt = `Task: ${scenario.task.title}
Type: ${scenario.task.type}

## PRD
${scenario.context.prd}

## Spec
${spec}

## Build Output
${buildOutput}

## Generated Code
${writtenCodeText}`;

  const reviewOutput = await callModel(JUDGE_MODEL, REVIEW_SYSTEM_PROMPT, userPrompt, 4096);
  const { verdict, issues } = parseVerdict(reviewOutput);
  const issueCounts = parseIssueCounts(issues);

  return { verdict, issues, issueCounts, rawReview: reviewOutput };
}

// ── Scenarios ───────────────────────────────────────────────────

const SCENARIOS = [
  {
    name: 'REST API + RBAC',
    slug: 'rest-api-rbac',
    task: {
      title: 'Build a REST API with role-based access control for a document management system',
      type: 'feature',
    },
    context: {
      prd: `# Document Management API — Product Requirements

## Overview
Build a Node.js/TypeScript REST API for managing documents with role-based access control. The system supports three roles: admin, editor, and viewer. Documents belong to workspaces, and users are assigned roles per workspace.

## Functional Requirements
1. **Authentication**: JWT-based auth with access/refresh token pair. Access tokens expire in 15 minutes, refresh tokens in 7 days. Login via POST /auth/login with email + password.
2. **User Management** (admin only): POST /users to create users. GET /users to list. PATCH /users/:id to update role assignments.
3. **Workspace CRUD**: POST /workspaces, GET /workspaces, GET /workspaces/:id, DELETE /workspaces/:id (admin only).
4. **Document CRUD**: POST /workspaces/:wid/documents (editor+), GET /workspaces/:wid/documents (all roles), GET /workspaces/:wid/documents/:id (all roles), PUT /workspaces/:wid/documents/:id (editor+), DELETE /workspaces/:wid/documents/:id (admin only).
5. **Rate Limiting**: 100 requests/minute per user for read endpoints, 20/minute for write endpoints. Return 429 with Retry-After header.
6. **Pagination**: All list endpoints support cursor-based pagination with limit (max 100, default 20).
7. **Audit Log**: All write operations logged to an audit_logs table with user_id, action, resource_type, resource_id, timestamp, and diff.

## Non-Functional Requirements
- Input validation on all endpoints with descriptive error messages.
- Consistent error response format: { error: { code, message, details? } }.
- Request IDs in all responses via X-Request-ID header.
- Passwords hashed with bcrypt (cost factor 12).
- All database queries parameterized (no string interpolation).

## Acceptance Criteria
- Admin can CRUD users, workspaces, and documents.
- Editor can create/edit documents in assigned workspaces but cannot delete.
- Viewer can only read documents in assigned workspaces.
- Unauthenticated requests return 401.
- Unauthorized role access returns 403.
- Rate limit violations return 429 with correct Retry-After.`,

      design: `# Design Document — Document Management API

## Architecture
Express.js application with layered architecture:
- **Routes layer**: Express routers, input validation via zod schemas, auth middleware.
- **Service layer**: Business logic, role checks, audit logging.
- **Data layer**: Drizzle ORM with PostgreSQL 16.

## Database Schema
- \`users\`: id (UUID), email (unique), password_hash, created_at, updated_at
- \`workspaces\`: id (UUID), name, created_by (FK users), created_at, updated_at
- \`workspace_members\`: workspace_id + user_id (composite PK), role ENUM('admin','editor','viewer')
- \`documents\`: id (UUID), workspace_id (FK), title, content (TEXT), created_by (FK), version (INT), created_at, updated_at
- \`audit_logs\`: id (UUID), user_id (FK), action VARCHAR, resource_type VARCHAR, resource_id UUID, diff JSONB, created_at
- \`refresh_tokens\`: id (UUID), user_id (FK), token_hash VARCHAR, expires_at TIMESTAMPTZ, created_at

## Auth Flow
1. Login: validate credentials → generate JWT access token (15m, contains user_id + email) + refresh token (7d, stored hashed in DB).
2. Middleware: extract Bearer token → verify JWT → attach user to req.user.
3. Role middleware: given resource type + workspace_id from route params, look up workspace_members → check role ≥ required.
4. Refresh: POST /auth/refresh with refresh token → validate against DB → issue new pair → revoke old.

## Rate Limiting Strategy
Use a sliding window counter per user stored in-memory (Map). On each request:
1. Get/create window for user_id + endpoint category (read/write).
2. Prune entries older than 60s.
3. If count ≥ limit, return 429 with Retry-After = seconds until oldest entry expires.
4. Else, add current timestamp to window.

## File Structure
\`\`\`
src/
  index.ts          — App entry, middleware setup, graceful shutdown
  config.ts         — Environment config via dotenv
  middleware/
    auth.ts         — JWT verification middleware
    rbac.ts         — Role-based access control middleware
    rate-limit.ts   — Sliding window rate limiter
    request-id.ts   — X-Request-ID header middleware
  routes/
    auth.ts         — Login, refresh, logout
    users.ts        — User CRUD (admin)
    workspaces.ts   — Workspace CRUD
    documents.ts    — Document CRUD within workspace
  services/
    auth.ts         — Token generation, password hashing
    users.ts        — User business logic
    workspaces.ts   — Workspace business logic
    documents.ts    — Document business logic
    audit.ts        — Audit log writer
  db/
    schema.ts       — Drizzle schema definitions
    index.ts        — Database connection pool
  types.ts          — Shared TypeScript types
\`\`\`

## Error Handling
Centralized error handler middleware at the end of the middleware chain. Custom AppError class with code, statusCode, message, details. All controllers wrap logic in try/catch and call next(error).`,

      'tech-research': `# Tech Research — Document Management API

## Dependencies
- express@4.21 — HTTP framework
- drizzle-orm@0.38 + drizzle-kit — ORM and migration tooling
- @node-postgres/pg@8 — PostgreSQL driver
- zod@3.24 — Input validation
- jsonwebtoken@9 — JWT signing/verification
- bcrypt@5 — Password hashing
- uuid@11 — UUID generation
- dotenv@16 — Environment variable loading
- typescript@5.7, tsx — TypeScript compilation

## Key Implementation Notes
1. **Drizzle schema**: Use \`pgTable()\` with \`uuid().defaultRandom().primaryKey()\` for IDs. Use \`pgEnum()\` for role enum. Timestamps via \`timestamp().defaultNow()\`.
2. **JWT**: Sign with HS256. Payload: \`{ sub: user_id, email, iat, exp }\`. Secret from env \`JWT_SECRET\`.
3. **bcrypt**: \`await bcrypt.hash(password, 12)\` for hashing, \`await bcrypt.compare()\` for verification.
4. **Rate limiter**: Do NOT use Redis (keep it simple). In-memory Map<string, number[]> keyed by \`\${userId}:\${category}\`. This is fine for single-instance deployment.
5. **Cursor pagination**: Use \`created_at\` + \`id\` as cursor (encode as base64). WHERE clause: \`(created_at, id) < (cursor_date, cursor_id) ORDER BY created_at DESC, id DESC LIMIT N\`.
6. **Audit log**: Insert asynchronously (fire-and-forget with error logging) to avoid blocking write responses. Use \`setImmediate()\` wrapper.
7. **Graceful shutdown**: Listen for SIGTERM/SIGINT → stop accepting requests → drain existing connections (30s timeout) → close DB pool → exit.

## Edge Cases
- Concurrent document edits: Use optimistic locking via version column. \`UPDATE ... WHERE version = $expected\`, check rowCount.
- Token refresh race: Use DB transaction to atomically revoke old + create new refresh token.
- Deleted workspace: CASCADE delete on workspace_members and documents. Audit logs preserved (no FK cascade).
- Empty pagination: Return \`{ data: [], cursor: null, hasMore: false }\`.
- Self-demotion: Admin cannot remove their own admin role on a workspace if they are the last admin.`,
    },
    fixedSpec: `## Implementation Plan

### \`src/config.ts\`
- **Action**: create
- **Purpose**: Load and validate environment variables
- **Pseudocode**:
\`\`\`
// Load dotenv
// Export typed config object: PORT, DATABASE_URL, JWT_SECRET, JWT_EXPIRES_IN, BCRYPT_ROUNDS
// Throw on missing required vars
\`\`\`

### \`src/db/schema.ts\`
- **Action**: create
- **Purpose**: Define Drizzle ORM schema for all tables
- **Pseudocode**:
\`\`\`
// Define pgEnum for roles: admin, editor, viewer
// Define users table: id (uuid pk), email (unique), password_hash, created_at, updated_at
// Define workspaces table: id (uuid pk), name, created_by (fk users), timestamps
// Define workspace_members: composite pk (workspace_id, user_id), role enum
// Define documents: id, workspace_id (fk), title, content, created_by, version (int default 1), timestamps
// Define audit_logs: id, user_id, action, resource_type, resource_id, diff (jsonb), created_at
// Define refresh_tokens: id, user_id, token_hash, expires_at, created_at
\`\`\`

### \`src/db/index.ts\`
- **Action**: create
- **Purpose**: Create and export database connection pool
- **Pseudocode**:
\`\`\`
// Create pg Pool from DATABASE_URL
// Create drizzle instance wrapping pool
// Export db and pool for graceful shutdown
\`\`\`

### \`src/types.ts\`
- **Action**: create
- **Purpose**: Shared TypeScript types and AppError class
- **Pseudocode**:
\`\`\`
// Define AppError extends Error with code, statusCode, details
// Define Role type union
// Define AuthUser type (id, email)
// Define PaginationParams and PaginatedResponse types
\`\`\`

### \`src/middleware/request-id.ts\`
- **Action**: create
- **Purpose**: Attach X-Request-ID to all responses
- **Pseudocode**:
\`\`\`
// Generate uuid, set on req and res header
\`\`\`

### \`src/middleware/auth.ts\`
- **Action**: create
- **Purpose**: JWT verification middleware
- **Pseudocode**:
\`\`\`
// Extract Bearer token from Authorization header
// Verify with jwt.verify(token, JWT_SECRET)
// Attach decoded payload to req.user
// On failure: throw AppError(401, 'UNAUTHORIZED')
\`\`\`

### \`src/middleware/rbac.ts\`
- **Action**: create
- **Purpose**: Role-based access control middleware factory
- **Pseudocode**:
\`\`\`
// Export requireRole(minimumRole) factory
// Extract workspace_id from req.params
// Query workspace_members for user + workspace
// Compare role against hierarchy: admin > editor > viewer
// If insufficient: throw AppError(403, 'FORBIDDEN')
\`\`\`

### \`src/middleware/rate-limit.ts\`
- **Action**: create
- **Purpose**: Sliding window rate limiter
- **Pseudocode**:
\`\`\`
// In-memory Map<string, number[]>
// Export createRateLimiter(limit, windowMs) factory
// On request: key = userId:category, prune old entries, check count
// If over limit: 429 with Retry-After header
// Else: push Date.now(), call next()
\`\`\`

### \`src/services/auth.ts\`
- **Action**: create
- **Purpose**: Authentication service (JWT, passwords, refresh tokens)
- **Pseudocode**:
\`\`\`
// hashPassword(plain): bcrypt.hash(plain, 12)
// verifyPassword(plain, hash): bcrypt.compare
// generateTokenPair(user): sign access JWT (15m) + generate refresh token + store hash in DB
// refreshTokens(token): verify against DB, atomically revoke old + create new pair in transaction
\`\`\`

### \`src/services/audit.ts\`
- **Action**: create
- **Purpose**: Fire-and-forget audit log writer
- **Pseudocode**:
\`\`\`
// logAction(userId, action, resourceType, resourceId, diff)
// Use setImmediate to insert into audit_logs asynchronously
// Catch and log errors without propagating
\`\`\`

### \`src/routes/auth.ts\`
- **Action**: create
- **Purpose**: Auth endpoints (login, refresh, logout)
- **Pseudocode**:
\`\`\`
// POST /auth/login: validate body with zod, verify credentials, return token pair
// POST /auth/refresh: validate refresh token, return new pair
// POST /auth/logout: revoke refresh token
\`\`\`

### \`src/routes/users.ts\`
- **Action**: create
- **Purpose**: User management (admin only)
- **Pseudocode**:
\`\`\`
// All routes require auth + admin role
// POST /users: validate with zod, hash password, insert, return user (no password)
// GET /users: cursor pagination, return list
// PATCH /users/:id: validate fields, update, audit log
\`\`\`

### \`src/routes/workspaces.ts\`
- **Action**: create
- **Purpose**: Workspace CRUD
- **Pseudocode**:
\`\`\`
// POST /workspaces: auth required, create workspace, add creator as admin member, audit
// GET /workspaces: return workspaces where user is a member
// GET /workspaces/:id: require membership
// DELETE /workspaces/:id: require admin role, cascade delete, audit
\`\`\`

### \`src/routes/documents.ts\`
- **Action**: create
- **Purpose**: Document CRUD within workspace
- **Pseudocode**:
\`\`\`
// POST /workspaces/:wid/documents: require editor+, validate, insert, audit
// GET /workspaces/:wid/documents: require viewer+, cursor pagination
// GET /workspaces/:wid/documents/:id: require viewer+
// PUT /workspaces/:wid/documents/:id: require editor+, optimistic lock on version, audit
// DELETE /workspaces/:wid/documents/:id: require admin, soft or hard delete, audit
\`\`\`

### \`src/index.ts\`
- **Action**: create
- **Purpose**: App entry point with middleware chain and graceful shutdown
- **Pseudocode**:
\`\`\`
// Load config
// Create Express app
// Apply middleware: json, requestId, rateLimiters (read: 100/min, write: 20/min)
// Mount routes: /auth, /users, /workspaces
// Apply error handler middleware
// Start server, listen on PORT
// SIGTERM/SIGINT: stop accepting, drain 30s, close DB pool, exit
\`\`\`

## Constants & Configuration
- JWT_SECRET (env, required)
- JWT_EXPIRES_IN = '15m'
- REFRESH_TOKEN_EXPIRES_DAYS = 7
- BCRYPT_ROUNDS = 12
- RATE_LIMIT_READ = 100/min
- RATE_LIMIT_WRITE = 20/min
- PAGINATION_DEFAULT_LIMIT = 20
- PAGINATION_MAX_LIMIT = 100
- SHUTDOWN_TIMEOUT_MS = 30000
- DATABASE_URL (env, required)
- PORT (env, default 3000)

## Test Plan
### \`tests/auth.test.ts\`
- Login with valid credentials → 200 + tokens
- Login with wrong password → 401
- Access protected route without token → 401
- Access protected route with expired token → 401
- Refresh token flow → new valid pair

### \`tests/rbac.test.ts\`
- Admin can create/edit/delete documents
- Editor can create/edit but not delete documents
- Viewer can read but not create/edit/delete
- Non-member gets 403

### \`tests/documents.test.ts\`
- CRUD lifecycle: create → read → update → delete
- Optimistic locking: concurrent update with stale version → 409
- Pagination: create 25 docs, paginate with limit 10, verify cursors
- Empty workspace returns empty list

### \`tests/rate-limit.test.ts\`
- Send 101 read requests → 100 succeed, 101st returns 429
- Verify Retry-After header value

## Migration Notes
- Run \`npx drizzle-kit generate\` to create initial migration.
- Run \`npx drizzle-kit migrate\` to apply.
- Seed an initial admin user for bootstrapping.

## Checklist
- [x] All files listed
- [x] All edge cases covered (optimistic locking, last admin, pagination, token races)
- [x] All tests specified
- [x] No breaking changes (greenfield project)`,
  },

  {
    name: 'Real-time Event System',
    slug: 'realtime-events',
    task: {
      title: 'Build a real-time event broadcasting system with WebSocket rooms and presence tracking',
      type: 'feature',
    },
    context: {
      prd: `# Real-time Event System — Product Requirements

## Overview
Build a WebSocket-based real-time event broadcasting system. Clients connect to rooms, receive events broadcast to their rooms, and can see which other users are present. The server uses Redis pub/sub for horizontal scalability across multiple server instances.

## Functional Requirements
1. **Connection**: Clients connect via WebSocket at ws://host/ws?token=JWT. Server validates JWT and extracts user identity.
2. **Room Join/Leave**: Client sends \`{ type: "join", room: "room-id" }\`. Server confirms with \`{ type: "joined", room, members }\`. On leave or disconnect, server broadcasts updated member list.
3. **Event Broadcasting**: Client sends \`{ type: "event", room: "room-id", payload: {...} }\`. Server broadcasts to all room members except sender. Events have server-assigned IDs and timestamps.
4. **Presence**: Each room maintains a live member list. Broadcast \`{ type: "presence", room, members: [{id, name, joinedAt}] }\` on any join/leave/disconnect.
5. **Reconnection**: If a client disconnects and reconnects within 30 seconds with the same user ID, restore their room memberships automatically. After 30s, treat as new connection.
6. **Heartbeat**: Server sends ping every 15s. Client must respond with pong within 5s or gets disconnected.
7. **Admin Events**: Server can broadcast system-wide events to all connected clients (e.g., maintenance notifications) via an internal HTTP endpoint POST /admin/broadcast (API key auth).

## Non-Functional Requirements
- Handle 10,000 concurrent connections per server instance.
- Message delivery latency < 50ms within a single server, < 200ms cross-server via Redis.
- Graceful shutdown: stop accepting new connections, send "server_shutdown" event to all clients, wait 10s for in-flight messages, close all connections.
- All messages are JSON. Invalid JSON or unknown message types get error response, not disconnection.
- Connection-level rate limiting: max 50 messages/second per client.

## Acceptance Criteria
- Client connects with valid JWT → receives "connected" event with connection ID.
- Client joins room → receives current member list.
- Client sends event → all other room members receive it within latency targets.
- Client disconnects → other members see updated presence.
- Reconnecting client within 30s → rooms automatically restored.
- Admin broadcast → all connected clients receive the message.`,

      design: `# Design Document — Real-time Event System

## Architecture
Standalone Node.js server using the \`ws\` library for WebSocket handling and \`ioredis\` for Redis pub/sub. Each server instance maintains local WebSocket connections and room state, with Redis synchronizing events across instances.

## Message Protocol
All messages are JSON with a \`type\` field:

**Client → Server:**
- \`{ type: "join", room: string }\`
- \`{ type: "leave", room: string }\`
- \`{ type: "event", room: string, payload: object }\`
- \`{ type: "pong" }\`

**Server → Client:**
- \`{ type: "connected", connectionId: string, userId: string }\`
- \`{ type: "joined", room: string, members: Member[] }\`
- \`{ type: "left", room: string }\`
- \`{ type: "event", id: string, room: string, sender: string, payload: object, timestamp: string }\`
- \`{ type: "presence", room: string, members: Member[] }\`
- \`{ type: "ping" }\`
- \`{ type: "error", code: string, message: string }\`
- \`{ type: "system", payload: object }\`

## Components

### ConnectionManager
- Stores active WebSocket connections keyed by connectionId.
- Maps userId → connectionId for reconnection lookups.
- Handles heartbeat loop: schedule ping every 15s per connection, mark as "awaiting pong", disconnect if no pong within 5s.
- On disconnect: mark connection as "disconnected" with a 30s TTL for reconnection.

### RoomManager
- Local room state: Map<roomId, Set<connectionId>>.
- Redis channel per room: \`room:\${roomId}\`.
- On join: add to local set, subscribe to Redis channel (if first local member), publish presence update.
- On leave/disconnect: remove from local set, unsubscribe if last local member, publish presence update.
- On event: publish to Redis channel → all instances receive → broadcast to local connections in room.

### PresenceTracker
- Tracks per-room member info: userId, displayName, joinedAt.
- Uses Redis hash \`presence:\${roomId}\` with userId as field, JSON {name, joinedAt, serverId} as value.
- On join: HSET + publish presence event.
- On leave: HDEL + publish presence event.
- On reconnect within TTL: restore HSET entries from cached state.

### ReconnectionManager
- On disconnect: store {userId, rooms[], timestamp} in local Map with 30s TTL setTimeout.
- On new connection with same userId within TTL: cancel timeout, re-join all stored rooms, send "reconnected" event.
- After TTL: delete stored state, broadcast final leave to all rooms.

## File Structure
\`\`\`
src/
  index.ts          — Server entry, HTTP + WebSocket setup, graceful shutdown
  config.ts         — Environment config
  auth.ts           — JWT validation for WebSocket handshake
  connection.ts     — ConnectionManager class
  rooms.ts          — RoomManager class
  presence.ts       — PresenceTracker class
  reconnect.ts      — ReconnectionManager class
  messages.ts       — Message parsing, validation, type guards
  redis.ts          — Redis client setup (pub + sub instances)
  admin.ts          — Express mini-app for admin HTTP endpoints
  rate-limit.ts     — Per-connection message rate limiter
\`\`\``,

      'tech-research': `# Tech Research — Real-time Event System

## Dependencies
- ws@8 — WebSocket server (no framework overhead, handles 10K+ connections easily)
- ioredis@5 — Redis client with built-in pub/sub support, reconnection, and pipelining
- jsonwebtoken@9 — JWT validation
- uuid@11 — Connection and event ID generation
- express@4 — Minimal HTTP server for admin endpoint only
- zod@3.24 — Message validation
- typescript@5.7, tsx

## Key Implementation Notes
1. **ws setup**: Create \`WebSocketServer\` attached to HTTP server. Use \`handleUpgrade\` for JWT validation during handshake (in the \`upgrade\` event, NOT after connection).
2. **Redis pub/sub**: Need TWO ioredis clients — one for publishing, one for subscribing. Subscriber client enters a special mode and can't run normal commands.
3. **Heartbeat**: Use \`ws.ping()\` native ping frames, not application-level messages. Listen for \`'pong'\` event. Set \`isAlive = false\` before ping, set \`true\` on pong, terminate if still false on next interval.
4. **Rate limiting**: Simple token bucket per connection. 50 tokens, refill 50/second. On exceeded: send error message, don't disconnect (transient spike protection).
5. **Redis presence**: Use HGETALL for member list queries. Set TTL on the hash key to auto-clean stale rooms (EXPIRE 3600s, refresh on any activity).
6. **Message validation**: Parse JSON in try/catch. Validate with zod schemas per message type. On invalid: send error message with code "INVALID_MESSAGE".
7. **Graceful shutdown**: On SIGTERM: (1) stop accepting new WS connections, (2) broadcast {type:"system", payload:{event:"shutdown"}}, (3) setTimeout 10s, (4) close all connections, (5) close Redis clients.
8. **Memory management**: Each connection stores minimal state: connectionId, userId, rooms Set<string>, lastPong timestamp. No message buffering.

## Edge Cases
- Client sends event to room they haven't joined → error response, not disconnection.
- Client joins same room twice → idempotent, no duplicate presence entries.
- Redis disconnect during operation → ioredis auto-reconnects, local room state stays intact, events queue until Redis recovers.
- Server crash (no graceful shutdown) → Redis presence entries stale → TTL auto-cleans after 1 hour. Other instances detect via heartbeat timeout.
- JWT expired mid-session → Don't disconnect. Token was valid at handshake. Only check on initial connection and reconnection.`,
    },
    fixedSpec: `## Implementation Plan

### \`src/config.ts\`
- **Action**: create
- **Purpose**: Environment configuration
- **Pseudocode**:
\`\`\`
// Load dotenv, export typed config: PORT, REDIS_URL, JWT_SECRET, ADMIN_API_KEY
// Heartbeat interval 15s, pong timeout 5s, reconnect TTL 30s, rate limit 50/s
\`\`\`

### \`src/redis.ts\`
- **Action**: create
- **Purpose**: Redis client setup (pub + sub instances)
- **Pseudocode**:
\`\`\`
// Create two ioredis instances from REDIS_URL
// pubClient for commands + publishing
// subClient for subscriptions only
// Export both + cleanup function
\`\`\`

### \`src/auth.ts\`
- **Action**: create
- **Purpose**: JWT validation for WebSocket handshake
- **Pseudocode**:
\`\`\`
// authenticateUpgrade(req): extract token from query string
// jwt.verify → return {userId, name} or throw
// Used in HTTP upgrade handler before accepting WS connection
\`\`\`

### \`src/messages.ts\`
- **Action**: create
- **Purpose**: Message parsing and validation
- **Pseudocode**:
\`\`\`
// Define zod schemas for each client message type (join, leave, event, pong)
// parseMessage(raw): JSON.parse + discriminated union validation
// Define ServerMessage types for type-safe sending
// serialize(msg): JSON.stringify
\`\`\`

### \`src/rate-limit.ts\`
- **Action**: create
- **Purpose**: Per-connection token bucket rate limiter
- **Pseudocode**:
\`\`\`
// RateLimiter class: tokens=50, refillRate=50/sec, lastRefill timestamp
// consume(): refill based on elapsed time, if tokens > 0 decrement and return true, else false
// One instance per connection, created on connect
\`\`\`

### \`src/connection.ts\`
- **Action**: create
- **Purpose**: ConnectionManager — tracks active WebSocket connections and heartbeats
- **Pseudocode**:
\`\`\`
// Map<connectionId, {ws, userId, rooms: Set, isAlive, rateLimiter}>
// Map<userId, connectionId> for reconnection lookup
// add(ws, userId) → connectionId
// remove(connectionId) → {userId, rooms}
// getByUser(userId) → connection or null
// startHeartbeat(): setInterval 15s, send ws.ping(), mark isAlive=false
// On 'pong' event: mark isAlive=true
// If !isAlive on next tick: terminate connection
\`\`\`

### \`src/presence.ts\`
- **Action**: create
- **Purpose**: Room presence tracking via Redis
- **Pseudocode**:
\`\`\`
// join(roomId, userId, name): HSET presence:roomId {userId: JSON({name, joinedAt, serverId})}
// leave(roomId, userId): HDEL presence:roomId userId
// getMembers(roomId): HGETALL → parse values → return Member[]
// refreshTTL(roomId): EXPIRE presence:roomId 3600
\`\`\`

### \`src/rooms.ts\`
- **Action**: create
- **Purpose**: RoomManager — local room state + Redis pub/sub for cross-instance events
- **Pseudocode**:
\`\`\`
// Local: Map<roomId, Set<connectionId>>
// join(connectionId, roomId, userId):
//   add to local set
//   if first local member: redis subClient.subscribe("room:roomId")
//   presence.join(roomId, userId, name)
//   publish presence update to room channel
//   return current members
// leave(connectionId, roomId, userId):
//   remove from local set
//   if last local member: unsubscribe
//   presence.leave(roomId, userId)
//   publish presence update
// broadcast(roomId, message, excludeConnectionId):
//   publish to redis channel "room:roomId"
// onRedisMessage(channel, message):
//   extract roomId from channel
//   send to all local connections in that room
\`\`\`

### \`src/reconnect.ts\`
- **Action**: create
- **Purpose**: Handle client reconnection within TTL
- **Pseudocode**:
\`\`\`
// Map<userId, {rooms: string[], timeout: NodeJS.Timeout, timestamp}>
// onDisconnect(userId, rooms):
//   store rooms + set 30s timeout to call onExpire
// onReconnect(userId):
//   if entry exists and within TTL: cancel timeout, return stored rooms
//   else: return null
// onExpire(userId):
//   delete entry, broadcast final leave to all stored rooms
\`\`\`

### \`src/admin.ts\`
- **Action**: create
- **Purpose**: HTTP admin endpoint for system broadcasts
- **Pseudocode**:
\`\`\`
// Express mini-app
// POST /admin/broadcast: validate API key header, parse body, broadcast {type:"system"} to all connections
\`\`\`

### \`src/index.ts\`
- **Action**: create
- **Purpose**: Server entry, WebSocket setup, graceful shutdown
- **Pseudocode**:
\`\`\`
// Create HTTP server with admin Express app
// Create WebSocketServer on same HTTP server
// On 'upgrade': authenticateUpgrade → accept/reject
// On 'connection': connectionManager.add, set up message handler
// Message handler: parse → switch(type) → join/leave/event/pong
// On 'close': connectionManager.remove, reconnectManager.onDisconnect, roomManager.leave for each room
// Graceful shutdown: SIGTERM → stop accepting, broadcast shutdown, wait 10s, close all, close Redis
\`\`\`

## Constants & Configuration
- REDIS_URL (env, required)
- JWT_SECRET (env, required)
- ADMIN_API_KEY (env, required)
- PORT (env, default 8080)
- HEARTBEAT_INTERVAL_MS = 15000
- PONG_TIMEOUT_MS = 5000
- RECONNECT_TTL_MS = 30000
- RATE_LIMIT_MESSAGES_PER_SEC = 50
- PRESENCE_TTL_SECONDS = 3600
- SHUTDOWN_GRACE_MS = 10000

## Test Plan
### \`tests/connection.test.ts\`
- Connect with valid JWT → receive "connected" event
- Connect with invalid JWT → connection rejected
- Heartbeat timeout → connection terminated

### \`tests/rooms.test.ts\`
- Join room → receive "joined" with member list
- Send event → other members receive it, sender does not
- Leave room → presence updated for remaining members

### \`tests/reconnect.test.ts\`
- Disconnect and reconnect within 30s → rooms restored
- Disconnect and wait 31s → rooms not restored, treated as new connection

### \`tests/rate-limit.test.ts\`
- Send 51 messages in 1s → 50 succeed, 51st gets error response (not disconnect)

## Migration Notes
- Ensure Redis 7+ is running and accessible.
- Set ADMIN_API_KEY to a secure random value.
- No database migrations (stateless except Redis).

## Checklist
- [x] All files listed with clear pseudocode
- [x] Edge cases covered: duplicate join, event to non-joined room, Redis disconnect, stale presence
- [x] All tests specified
- [x] No breaking changes (new service)`,
  },

  {
    name: 'ORM Migration Refactor',
    slug: 'orm-migration',
    task: {
      title: 'Migrate an Express.js API from Sequelize ORM to Drizzle ORM with zero-downtime deployment',
      type: 'refactor',
    },
    context: {
      prd: `# ORM Migration — Product Requirements

## Overview
Migrate an existing Express.js e-commerce API from Sequelize v6 to Drizzle ORM. The API serves 500 req/s in production and cannot have downtime during the migration. The codebase has 4 Sequelize models, 12 API endpoints, and 3 background jobs.

## Existing Models (Sequelize)
1. **Product**: id, sku (unique), name, description, price (decimal), category_id (FK), stock_quantity, is_active, created_at, updated_at
2. **Category**: id, name, slug (unique), parent_id (self-referential FK, nullable), sort_order, created_at
3. **Order**: id, user_id, status (pending/confirmed/shipped/delivered/cancelled), total_amount (decimal), shipping_address (JSONB), notes (TEXT), created_at, updated_at
4. **OrderItem**: id, order_id (FK), product_id (FK), quantity, unit_price (decimal), created_at

## Existing Endpoints
- GET/POST /products, GET/PUT/DELETE /products/:id
- GET/POST /categories, GET/PUT/DELETE /categories/:id, GET /categories/:id/products
- GET/POST /orders, GET /orders/:id, PATCH /orders/:id/status
- Background: inventory sync (every 5m), order cleanup (daily), category cache rebuild (hourly)

## Migration Requirements
1. Replace ALL Sequelize model definitions with Drizzle schema.
2. Replace ALL Sequelize query calls with Drizzle query builder equivalents.
3. Maintain identical API response shapes — no breaking changes for API consumers.
4. Preserve all existing database indexes and constraints.
5. The migration must work against the EXISTING database — no schema changes, no new migrations. Drizzle connects to the same PostgreSQL database Sequelize was using.
6. Maintain transactional behavior: order creation (insert order + items) must remain atomic.
7. Update all background jobs to use Drizzle.

## Acceptance Criteria
- All 12 endpoints return identical responses before and after migration.
- Transaction semantics preserved for order creation.
- No N+1 queries introduced (Sequelize eager loading → Drizzle joins).
- All background jobs function correctly.
- Sequelize fully removed from package.json dependencies.`,

      design: `# Design Document — ORM Migration

## Migration Strategy
**Parallel implementation with feature flag.** Not a big-bang swap.

Phase 1 (this task): Create Drizzle schema + query layer alongside Sequelize. Implement all data access functions with Drizzle. Wire up via feature flag (USE_DRIZZLE=true/false env var). This allows instant rollback.

Phase 2 (follow-up): Remove Sequelize code and feature flag after production validation.

## Schema Mapping

Sequelize → Drizzle type mapping:
- \`DataTypes.UUID\` → \`uuid().defaultRandom()\`
- \`DataTypes.STRING(N)\` → \`varchar(N)\`
- \`DataTypes.TEXT\` → \`text()\`
- \`DataTypes.DECIMAL(10,2)\` → \`numeric({ precision: 10, scale: 2 })\`
- \`DataTypes.INTEGER\` → \`integer()\`
- \`DataTypes.BOOLEAN\` → \`boolean()\`
- \`DataTypes.JSONB\` → \`jsonb()\`
- \`DataTypes.DATE\` → \`timestamp()\`
- Self-referential FK (Category.parent_id): use \`references(() => categories.id)\` with explicit table reference.

## Query Migration Patterns

| Sequelize | Drizzle Equivalent |
|---|---|
| \`Model.findAll({ where, order, limit, offset })\` | \`db.select().from(table).where(conditions).orderBy(col).limit(n).offset(n)\` |
| \`Model.findByPk(id)\` | \`db.select().from(table).where(eq(table.id, id)).limit(1)\` |
| \`Model.create(data)\` | \`db.insert(table).values(data).returning()\` |
| \`Model.update(data, { where })\` | \`db.update(table).set(data).where(conditions).returning()\` |
| \`Model.destroy({ where })\` | \`db.delete(table).where(conditions)\` |
| \`Model.findAll({ include: [...] })\` | \`db.select().from(table).leftJoin(other, eq(...))\` |
| \`sequelize.transaction(async t => ...)\` | \`db.transaction(async tx => ...)\` |

## File Structure (new files)
\`\`\`
src/
  db/
    drizzle-schema.ts   — Drizzle table definitions matching existing DB
    drizzle-client.ts   — Drizzle connection setup
    drizzle-queries/
      products.ts       — Product data access functions
      categories.ts     — Category data access functions (with tree queries)
      orders.ts         — Order + OrderItem data access (transactional)
  feature-flags.ts      — USE_DRIZZLE env flag reader
\`\`\`

## Modified Files
\`\`\`
src/
  routes/products.ts    — Import from drizzle-queries when flag is on
  routes/categories.ts  — Same
  routes/orders.ts      — Same
  jobs/inventory-sync.ts   — Same
  jobs/order-cleanup.ts    — Same
  jobs/category-cache.ts   — Same
\`\`\`

## Key Complexity: Category Tree
Categories have parent_id self-referential FK. Current Sequelize code uses a recursive CTE for "get all subcategories." Drizzle supports raw SQL via \`sql\` tagged template for the CTE, or we can use a WITH RECURSIVE query.`,

      'tech-research': `# Tech Research — ORM Migration

## Dependencies
- drizzle-orm@0.38 — Core ORM
- drizzle-kit@0.30 — Only for introspection (\`drizzle-kit introspect\`) to verify schema matches DB. NOT for migrations (we're keeping existing schema).
- @node-postgres/pg@8 — Same driver Sequelize was using, now shared with Drizzle.

## Key Implementation Notes
1. **drizzle-kit introspect**: Run \`npx drizzle-kit introspect\` against the existing DB to auto-generate a Drizzle schema, then manually clean it up. This ensures exact column type matches.
2. **Connection pooling**: Drizzle wraps a pg Pool. We can reuse the SAME Pool instance that Sequelize uses, or create a separate one. Recommendation: separate pool (cleaner, avoids contention) with max 10 connections.
3. **Decimal handling**: Drizzle returns decimal columns as strings by default. Need \`mapWith(Number)\` or a custom column type to match Sequelize behavior (which returned floats). Important for price fields.
4. **JSONB**: Drizzle's \`jsonb()\` type returns parsed objects automatically. Sequelize did too. No change needed.
5. **Transactions**: \`db.transaction(async (tx) => { await tx.insert(...); await tx.insert(...); })\`. The \`tx\` object is used exactly like \`db\` but within the transaction scope.
6. **Category recursive CTE**:
\`\`\`typescript
const subcategories = db.execute(sql\`
  WITH RECURSIVE tree AS (
    SELECT * FROM categories WHERE id = \${parentId}
    UNION ALL
    SELECT c.* FROM categories c JOIN tree t ON c.parent_id = t.id
  )
  SELECT * FROM tree
\`);
\`\`\`
7. **Eager loading replacement**: Sequelize's \`include\` becomes explicit \`leftJoin\` + manual result mapping. For OrderItems: \`db.select().from(orders).leftJoin(orderItems, eq(orders.id, orderItems.orderId))\`. Group results manually by order ID.

## Edge Cases
- **Decimal precision**: Sequelize's DECIMAL(10,2) returns JavaScript numbers (potential floating point issues). Drizzle returns strings. Ensure API responses format prices consistently as numbers, not strings.
- **Null parent_id**: Category.parent_id is nullable. Drizzle handles this correctly with \`references(() => categories.id)\` on a nullable column.
- **Empty results**: Sequelize \`findAll\` returns []. Drizzle \`select()\` also returns []. No change.
- **Order creation atomicity**: Must use \`db.transaction\`. If OrderItem insert fails, Order insert must roll back.
- **Sequelize hooks**: Check if any beforeCreate/afterCreate hooks exist on models. These need manual reimplementation (Drizzle has no hooks). In this codebase: Product.beforeCreate sets is_active=true by default. Handle via default value in schema.`,
    },
    fixedSpec: `## Implementation Plan

### \`src/feature-flags.ts\`
- **Action**: create
- **Purpose**: Feature flag for Drizzle migration rollout
- **Pseudocode**:
\`\`\`
// Export USE_DRIZZLE = process.env.USE_DRIZZLE === 'true'
// Log which ORM is active on startup
\`\`\`

### \`src/db/drizzle-schema.ts\`
- **Action**: create
- **Purpose**: Drizzle schema matching existing PostgreSQL tables exactly
- **Pseudocode**:
\`\`\`
// categories table: id (uuid pk), name (varchar 255), slug (varchar 255 unique), parent_id (uuid nullable, self-ref FK), sort_order (int default 0), created_at (timestamp)
// products table: id (uuid pk), sku (varchar 100 unique), name (varchar 255), description (text), price (numeric 10,2), category_id (uuid FK categories), stock_quantity (int), is_active (boolean default true), created_at, updated_at
// orders table: id (uuid pk), user_id (uuid), status (varchar 20 default 'pending'), total_amount (numeric 10,2), shipping_address (jsonb), notes (text nullable), created_at, updated_at
// order_items table: id (uuid pk), order_id (uuid FK orders), product_id (uuid FK products), quantity (int), unit_price (numeric 10,2), created_at
// All numeric columns: use .mapWith(Number) to match Sequelize float behavior
\`\`\`

### \`src/db/drizzle-client.ts\`
- **Action**: create
- **Purpose**: Drizzle database connection
- **Pseudocode**:
\`\`\`
// Create new pg Pool (separate from Sequelize pool) with max 10 connections
// Create drizzle instance wrapping pool, pass schema
// Export db instance and pool for shutdown
\`\`\`

### \`src/db/drizzle-queries/products.ts\`
- **Action**: create
- **Purpose**: Product data access layer using Drizzle
- **Pseudocode**:
\`\`\`
// getAllProducts(filters): select from products, optional where category_id/is_active, orderBy, limit/offset, leftJoin category for category name
// getProductById(id): select where id, limit 1, join category
// createProduct(data): insert into products, returning *
// updateProduct(id, data): update where id, set updated_at = now(), returning *
// deleteProduct(id): delete where id
// getProductsByCategoryId(categoryId): select where category_id, paginated
\`\`\`

### \`src/db/drizzle-queries/categories.ts\`
- **Action**: create
- **Purpose**: Category data access with recursive tree support
- **Pseudocode**:
\`\`\`
// getAllCategories(): select all, order by sort_order
// getCategoryById(id): select where id, limit 1
// createCategory(data): insert, returning *
// updateCategory(id, data): update where id, returning *
// deleteCategory(id): delete where id (check no children first)
// getSubcategories(parentId): WITH RECURSIVE CTE via db.execute(sql\`...\`)
// getCategoryProducts(categoryId): select products where category_id, join category
\`\`\`

### \`src/db/drizzle-queries/orders.ts\`
- **Action**: create
- **Purpose**: Order + OrderItem transactional data access
- **Pseudocode**:
\`\`\`
// getAllOrders(filters): select from orders, optional where user_id/status, paginated
// getOrderById(id): select order + leftJoin order_items + leftJoin products for item details
//   Group results: single order object with items array
// createOrder(orderData, items): db.transaction(async tx => {
//   insert order → get orderId
//   insert all items with orderId
//   return order with items
// })
// updateOrderStatus(id, status): update where id, set updated_at, returning *
\`\`\`

### \`src/routes/products.ts\`
- **Action**: modify
- **Purpose**: Wire up Drizzle queries behind feature flag
- **Pseudocode**:
\`\`\`
// Import USE_DRIZZLE flag
// Import both sequelize and drizzle query modules
// In each handler: if (USE_DRIZZLE) use drizzle queries, else use existing sequelize code
// Response shapes must be identical — format drizzle results to match sequelize output
\`\`\`

### \`src/routes/categories.ts\`
- **Action**: modify
- **Purpose**: Wire up Drizzle queries behind feature flag
- **Pseudocode**:
\`\`\`
// Same pattern as products: feature flag switch between ORMs
// Category tree endpoint: use getSubcategories() CTE query
\`\`\`

### \`src/routes/orders.ts\`
- **Action**: modify
- **Purpose**: Wire up Drizzle queries behind feature flag
- **Pseudocode**:
\`\`\`
// Same pattern: feature flag switch
// Order creation: use transactional createOrder()
// Order detail: flatten joined results into nested {order, items[]} shape
\`\`\`

### \`src/jobs/inventory-sync.ts\`
- **Action**: modify
- **Purpose**: Use Drizzle for inventory sync background job
- **Pseudocode**:
\`\`\`
// Feature flag: select products with low stock via drizzle query
// Update stock quantities in batch
\`\`\`

### \`src/jobs/order-cleanup.ts\`
- **Action**: modify
- **Purpose**: Use Drizzle for stale order cleanup
- **Pseudocode**:
\`\`\`
// Feature flag: delete/archive orders older than 30 days with status 'pending'
\`\`\`

### \`src/jobs/category-cache.ts\`
- **Action**: modify
- **Purpose**: Use Drizzle for category cache rebuild
- **Pseudocode**:
\`\`\`
// Feature flag: fetch all categories with product counts via Drizzle
\`\`\`

## Constants & Configuration
- USE_DRIZZLE (env, default 'false') — feature flag
- DATABASE_URL (env, existing) — shared between ORMs
- DRIZZLE_POOL_MAX = 10

## Test Plan
### \`tests/drizzle-products.test.ts\`
- CRUD operations return same shapes as Sequelize versions
- Filter by category and active status
- Pagination matches

### \`tests/drizzle-categories.test.ts\`
- CRUD operations match
- Recursive subcategory query returns correct tree
- Delete with children → error

### \`tests/drizzle-orders.test.ts\`
- Create order with items → atomic (both inserted or neither)
- Get order by ID → includes nested items with product details
- Status update preserves other fields

### \`tests/feature-flag.test.ts\`
- USE_DRIZZLE=false → all queries use Sequelize
- USE_DRIZZLE=true → all queries use Drizzle
- Toggle mid-process → no errors (stateless flag check)

## Migration Notes
- NO database schema changes. Drizzle connects to existing tables.
- Run \`npx drizzle-kit introspect\` to verify schema accuracy before deployment.
- Deploy with USE_DRIZZLE=false first, then enable via env var flip.
- Monitor query latency and error rates after enabling.
- Rollback: set USE_DRIZZLE=false, restart.

## Checklist
- [x] All new and modified files listed
- [x] Feature flag for zero-risk rollout
- [x] Decimal precision edge case handled (mapWith Number)
- [x] Transaction semantics preserved
- [x] Recursive CTE for category tree
- [x] All 3 background jobs included
- [x] No schema changes required`,
  },
];

// ── Reporting ───────────────────────────────────────────────────

function verdictSymbol(v) {
  if (v === 'pass') return '✅ PASS';
  if (v === 'pass_with_notes') return '⚠️  PASS+NOTES';
  if (v === 'needs_revision') return '❌ NEEDS REV';
  return '❓ UNKNOWN';
}

function printResults(allResults) {
  console.log('\n' + '═'.repeat(110));
  console.log('  QUALITY BENCHMARK RESULTS' + (FIXED_SPEC_MODE ? '  [fixed-spec mode]' : '  [own-spec mode]'));
  console.log('═'.repeat(110));

  // Group by scenario
  const byScenario = new Map();
  for (const r of allResults) {
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
    byScenario.get(r.scenario).push(r);
  }

  for (const [scenarioName, rows] of byScenario) {
    console.log(`\n  ── ${scenarioName} ──`);
    const header =
      '  ' + 'Model'.padEnd(20) +
      'Verdict'.padEnd(16) +
      'Files'.padStart(6) +
      'Lines'.padStart(7) +
      'SynErr'.padStart(7) +
      '🔴'.padStart(5) +
      '🟠'.padStart(5) +
      '🟡'.padStart(5) +
      '🟢'.padStart(5) +
      'SpecSec'.padStart(8) +
      'SpecFiles'.padStart(10);
    console.log(header);
    console.log('  ' + '─'.repeat(104));

    for (const r of rows) {
      const line =
        '  ' + r.model.padEnd(20) +
        verdictSymbol(r.review.verdict).padEnd(16) +
        String(r.build.filesWritten).padStart(6) +
        String(r.build.totalLines).padStart(7) +
        String(r.build.syntaxErrors).padStart(7) +
        String(r.review.issueCounts.critical).padStart(5) +
        String(r.review.issueCounts.high).padStart(5) +
        String(r.review.issueCounts.medium).padStart(5) +
        String(r.review.issueCounts.low).padStart(5) +
        (r.spec.allPresent ? '  ALL' : '  MISS').padStart(8) +
        String(r.spec.fileCount).padStart(10);
      console.log(line);
    }
  }

  // Summary comparison
  console.log('\n' + '═'.repeat(110));
  console.log('  SUMMARY');
  console.log('─'.repeat(110));

  const byModel = new Map();
  for (const r of allResults) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }

  for (const [modelLabel, rows] of byModel) {
    const verdicts = rows.map(r => r.review.verdict);
    const passes = verdicts.filter(v => v === 'pass' || v === 'pass_with_notes').length;
    const totalSyntax = rows.reduce((s, r) => s + r.build.syntaxErrors, 0);
    const totalCritical = rows.reduce((s, r) => s + r.review.issueCounts.critical, 0);
    const totalHigh = rows.reduce((s, r) => s + r.review.issueCounts.high, 0);
    console.log(`  ${modelLabel}: ${passes}/${rows.length} pass, ${totalSyntax} syntax errors, ${totalCritical} critical + ${totalHigh} high issues`);
  }
  console.log('═'.repeat(110));
}

function saveResults(allResults) {
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8')); } catch {}

  const timestamp = new Date().toISOString();
  const mode = FIXED_SPEC_MODE ? 'fixed-spec' : 'own-spec';
  const runKey = `${mode}-${timestamp}`;

  existing[runKey] = allResults.map(r => ({
    model: r.model,
    scenario: r.scenario,
    mode,
    spec: r.spec,
    build: { filesWritten: r.build.filesWritten, totalLines: r.build.totalLines, syntaxErrors: r.build.syntaxErrors, hitLineLimit: r.build.hitLineLimit },
    review: { verdict: r.review.verdict, issueCounts: r.review.issueCounts },
    timestamp,
  }));

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log(`\nResults saved to ${RESULTS_PATH}`);
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const mode = FIXED_SPEC_MODE ? 'fixed-spec' : 'own-spec';
  const activeScenarios = SCENARIO_FILTER != null
    ? [SCENARIOS[SCENARIO_FILTER - 1]].filter(Boolean)
    : SCENARIOS;

  if (activeScenarios.length === 0) {
    console.error(`Invalid --scenario value. Use 1-${SCENARIOS.length}.`);
    process.exit(1);
  }

  console.log(`Coder Model Quality Benchmark (${mode} mode)`);
  console.log(`Scenarios: ${activeScenarios.map(s => s.name).join(', ')}`);
  console.log(`Models: ${CODER_MODELS.map(m => m.label).join(', ')}`);
  console.log(`Judge: Qwen3.6-35B-A3B (planning model)\n`);

  await checkHealth();

  const allResults = [];

  for (const scenario of activeScenarios) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`  Scenario: ${scenario.name}`);
    console.log('═'.repeat(80));

    for (const model of CODER_MODELS) {
      const tempDir = setupTempDir(model.slug, scenario.slug);
      console.log(`\n  ── ${model.label} ──`);

      try {
        // Spec phase
        let spec;
        if (FIXED_SPEC_MODE) {
          console.log('  [spec] Using fixed spec');
          spec = scenario.fixedSpec;
        } else {
          process.stdout.write('  [spec] Generating… ');
          const t0 = performance.now();
          spec = await runSpec(model.id, scenario);
          const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
          console.log(`done (${elapsed}s)`);
        }

        const specValidation = validateSpec(spec);
        console.log(`  [spec] Sections: ${specValidation.allPresent ? 'ALL present' : 'MISSING some'}, files listed: ${specValidation.fileCount}`);

        // Build phase
        process.stdout.write('  [build] Generating… ');
        const t1 = performance.now();
        const buildResult = await runBuild(model.id, scenario, spec, tempDir);
        const buildElapsed = ((performance.now() - t1) / 1000).toFixed(1);
        console.log(`done (${buildElapsed}s)`);
        console.log(`  [build] Files: ${buildResult.filesWritten}, Lines: ${buildResult.totalLines}, Syntax errors: ${buildResult.syntaxErrors}${buildResult.hitLineLimit ? ' ⚠️ HIT LINE LIMIT' : ''}`);
        if (buildResult.syntaxErrorDetails.length > 0) {
          for (const e of buildResult.syntaxErrorDetails) {
            console.log(`    ✗ ${e.file}: ${e.error}`);
          }
        }

        // Review phase (always uses judge model)
        process.stdout.write('  [review] Judging with planning model… ');
        const t2 = performance.now();
        const reviewResult = await runReview(scenario, spec, buildResult.buildOutput, buildResult.writtenCodeText);
        const reviewElapsed = ((performance.now() - t2) / 1000).toFixed(1);
        console.log(`done (${reviewElapsed}s)`);
        console.log(`  [review] Verdict: ${verdictSymbol(reviewResult.verdict)}`);

        const ic = reviewResult.issueCounts;
        if (ic.critical + ic.high + ic.medium + ic.low > 0) {
          console.log(`  [review] Issues: 🔴 ${ic.critical}  🟠 ${ic.high}  🟡 ${ic.medium}  🟢 ${ic.low}`);
        }

        allResults.push({
          model: model.label,
          scenario: scenario.name,
          spec: specValidation,
          build: {
            filesWritten: buildResult.filesWritten,
            totalLines: buildResult.totalLines,
            syntaxErrors: buildResult.syntaxErrors,
            hitLineLimit: buildResult.hitLineLimit,
          },
          review: {
            verdict: reviewResult.verdict,
            issueCounts: reviewResult.issueCounts,
          },
        });
      } catch (err) {
        console.error(`  ✗ FAILED: ${err.message}`);
        allResults.push({
          model: model.label,
          scenario: scenario.name,
          spec: { allPresent: false, fileCount: 0, sections: {} },
          build: { filesWritten: 0, totalLines: 0, syntaxErrors: 0, hitLineLimit: false },
          review: { verdict: 'error', issueCounts: { critical: 0, high: 0, medium: 0, low: 0 } },
        });
      } finally {
        cleanupTempDir(tempDir);
      }
    }
  }

  printResults(allResults);
  saveResults(allResults);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.cwd();
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');
const COMPOSER_JSON = path.join(PROJECT_ROOT, 'composer.json');
const VS_CODE_DIR = path.join(PROJECT_ROOT, '.vscode');
const HUSKY_DIR = path.join(PROJECT_ROOT, '.husky');
const GIT_DIR = path.join(PROJECT_ROOT, '.git');
const GITIGNORE = path.join(PROJECT_ROOT, '.gitignore');

const DEFAULT_LLM_SCRIPT = path.join(__dirname, 'pipeline.js');
let LLM_SCRIPT = DEFAULT_LLM_SCRIPT;
if (process.env.LLM_PIPELINE_SCRIPT) {
  const raw = path.resolve(process.env.LLM_PIPELINE_SCRIPT);
  if (/[;&|`$<>(){}!\\]/.test(raw) || !fs.existsSync(raw)) {
    console.warn('\x1b[33m⚠️  LLM_PIPELINE_SCRIPT contains shell metacharacters or does not exist — using default.\x1b[0m');
  } else {
    LLM_SCRIPT = raw;
  }
}

function log(msg) {
  console.log(`\x1b[32m${msg}\x1b[0m`);
}
function warn(msg) {
  console.warn(`\x1b[33m${msg}\x1b[0m`);
}
function err(msg) {
  console.error(`\x1b[31m${msg}\x1b[0m`);
  process.exit(1);
}

// ── 0. Health check: Ollama running? ────────────────────────────
async function checkOllama() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      log('✅ Ollama is running');
    } else {
      warn('⚠️  Ollama responded with an error. Check: brew services list');
    }
  } catch {
    warn('⚠️  Ollama is not running at localhost:11434. Start it with: brew services start ollama');
  }
}
await checkOllama();

// 1. Auto-init package.json if missing
if (!fs.existsSync(PACKAGE_JSON)) {
  log('📦 No package.json found. Initializing Node project...');
  try {
    execSync('npm init -y', { stdio: 'inherit' });
  } catch (e) {
    err('❌ npm init failed. Is Node.js installed?');
  }
}

// 2. Force ES modules for pipeline compatibility
let pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8'));
if (pkg.type !== 'module') {
  pkg.type = 'module';
  fs.writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2));
  log('🔧 Updated package.json to "type": "module"');
}

// 3. Check Git
if (!fs.existsSync(GIT_DIR)) {
  err('❌ Not a Git repository. Run `git init` in this exact folder first.');
}

// 4. Framework Detection (WordPress takes priority)
let detectedFrameworks = new Set();
const dirs = fs.readdirSync(PROJECT_ROOT);

// WordPress detection FIRST — always wins if wp-config.php or wp-content/ present
if (dirs.includes('wp-config.php') || dirs.includes('wp-content')) {
  detectedFrameworks.add('wordpress');
}

// composer.json
if (fs.existsSync(COMPOSER_JSON)) {
  try {
    const composer = JSON.parse(fs.readFileSync(COMPOSER_JSON, 'utf-8'));
    const req = composer.require || {};
    if (req['laravel/framework']) detectedFrameworks.add('laravel');
    if (req['wordpress'] || req['roots/bedrock'] || req['roots/sage'])
      detectedFrameworks.add('wordpress');
  } catch {}
}

// package.json
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const scripts = pkg.scripts || {};

// Electron detection
if (deps.electron) detectedFrameworks.add('electron');

// React Native / Expo detection
if (deps['react-native'] || deps.expo) detectedFrameworks.add('react-native');

if (
  deps.next ||
  deps['@next'] ||
  scripts.next ||
  scripts.build?.includes('next')
)
  detectedFrameworks.add('nextjs');

// Express / API server detection (only if no frontend framework detected)
if (
  (deps.express || deps.fastify || deps.hono || deps.koa || deps['@nestjs/core']) &&
  !deps['react-dom'] && !deps.next && !deps.vite
)
  detectedFrameworks.add('express');

// Vite detection (only if WordPress not already detected — WordPress block themes use Vite)
if (!detectedFrameworks.has('wordpress')) {
  if (deps.vite || scripts.vite || scripts.build?.includes('vite'))
    detectedFrameworks.add('vite');
  if (dirs.includes('vite.config.js') || dirs.includes('vite.config.ts'))
    detectedFrameworks.add('vite');
}

if (
  deps['@wordpress'] ||
  scripts.wordpress ||
  scripts.build?.includes('wordpress')
)
  detectedFrameworks.add('wordpress');

// Directory structure fallback
if (!detectedFrameworks.has('laravel') && !detectedFrameworks.has('wordpress')) {
  if (dirs.includes('routes') && dirs.includes('config') && fs.existsSync(COMPOSER_JSON))
    detectedFrameworks.add('laravel');
}

if (detectedFrameworks.size === 0) detectedFrameworks.add('tsjs');
log(`🔍 Detected frameworks: ${[...detectedFrameworks].join(', ')}`);

// 5. Install husky & lint-staged if needed
const needsHusky = !pkg.devDependencies?.husky;
const needsLintStaged = !pkg.devDependencies?.['lint-staged'];

if (needsHusky || needsLintStaged) {
  log('📦 Installing husky & lint-staged...');
  try {
    execSync('npm install husky lint-staged --save-dev', { stdio: 'inherit' });
  } catch (e) {
    err('❌ npm install failed.');
  }
}
pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8'));

// 6. Configure Husky with parallel review + security
log('🔧 Setting up Husky...');
if (!fs.existsSync(HUSKY_DIR)) {
  try {
    execSync('npx husky init', { stdio: 'inherit' });
  } catch (e) {
    err('❌ Husky init failed.');
  }
}

// Validate LLM_SCRIPT exists before writing hook
if (!fs.existsSync(LLM_SCRIPT)) {
  warn(`⚠️  LLM pipeline script not found at ${LLM_SCRIPT}. Husky hook may fail until it exists.`);
}

const PRE_COMMIT = path.join(HUSKY_DIR, 'pre-commit');
fs.writeFileSync(
  PRE_COMMIT,
  `#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Run LLM review + security audit on staged files (parallel)
# Uses while-read loop to safely handle filenames with spaces/special chars
git diff --cached --name-only --diff-filter=ACM | grep -E '\\.(ts|tsx|js|jsx|mjs|cjs|php|json)$' | while IFS= read -r file; do
  node "${LLM_SCRIPT}" "$file"
done
`,
);
fs.chmodSync(PRE_COMMIT, '755');
log('✅ Husky pre-commit hook configured (review + security in parallel).');

// 7. Configure lint-staged (framework-aware)
log('⚙️ Configuring lint-staged...');
if (!pkg['lint-staged']) pkg['lint-staged'] = {};

if (detectedFrameworks.has('nextjs'))
  pkg['lint-staged']['src/**/*.{ts,tsx,js,jsx}'] = ['next lint --fix'];
if (detectedFrameworks.has('vite'))
  pkg['lint-staged']['src/**/*.{ts,tsx,js,jsx}'] = ['vitest related --run'];
if (detectedFrameworks.has('laravel') || detectedFrameworks.has('wordpress'))
  pkg['lint-staged']['*.php'] = ['php -l'];

// LLM pipeline on staged code files
pkg['lint-staged']['*.{ts,tsx,js,mjs,cjs,php,json}'] = [`node "${LLM_SCRIPT}"`];

fs.writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2));
log('✅ lint-staged configured.');

// 8. Add *.llm-draft to .gitignore
log('📝 Updating .gitignore...');
let gitignoreContent = fs.existsSync(GITIGNORE) ? fs.readFileSync(GITIGNORE, 'utf-8') : '';
if (!gitignoreContent.includes('*.llm-draft')) {
  gitignoreContent += '\n# LLM pipeline draft outputs\n*.llm-draft\n';
  fs.writeFileSync(GITIGNORE, gitignoreContent);
  log('✅ Added *.llm-draft to .gitignore');
}

// 9. Create .vscode/tasks.json (all 4 modes + framework-specific)
log('📝 Creating .vscode/tasks.json...');
if (!fs.existsSync(VS_CODE_DIR)) fs.mkdirSync(VS_CODE_DIR, { recursive: true });

// Load existing tasks to preserve custom user tasks
const tasksJsonPath = path.join(VS_CODE_DIR, 'tasks.json');
let existingCustomTasks = [];
if (fs.existsSync(tasksJsonPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(tasksJsonPath, 'utf-8'));
    // Keep any tasks that are NOT generated by this script (no 'LLM:' prefix and not framework-specific)
    const managedLabels = new Set([
      'LLM: Code Review', 'LLM: Security Audit', 'LLM: Generate Tests',
      'LLM: Generate Docs', 'LLM: Full Project Review (256K context)',
      'Next.js Lint & Type Check', 'Laravel Test Suite',
      'WordPress PHP Lint', 'Vitest Run',
      'Electron: Rebuild Native Modules', 'React Native: Start Metro',
    ]);
    existingCustomTasks = (existing.tasks || []).filter(t => !managedLabels.has(t.label));
  } catch {}
}

const tasks = [
  {
    label: 'LLM: Code Review',
    type: 'shell',
    command: `node "${LLM_SCRIPT}" --mode review ${'${file}'}`,
    problemMatcher: [],
    group: { kind: 'test', isDefault: false },
    presentation: { reveal: 'always', panel: 'new' },
  },
  {
    label: 'LLM: Security Audit',
    type: 'shell',
    command: `node "${LLM_SCRIPT}" --mode security ${'${file}'}`,
    problemMatcher: [],
    group: { kind: 'test', isDefault: false },
    presentation: { reveal: 'always', panel: 'new' },
  },
  {
    label: 'LLM: Generate Tests',
    type: 'shell',
    command: `node "${LLM_SCRIPT}" --mode tests ${'${file}'}`,
    problemMatcher: [],
    group: { kind: 'build', isDefault: false },
    presentation: { reveal: 'always', panel: 'new' },
  },
  {
    label: 'LLM: Generate Docs',
    type: 'shell',
    command: `node "${LLM_SCRIPT}" --mode docs ${'${file}'}`,
    problemMatcher: [],
    group: { kind: 'build', isDefault: false },
    presentation: { reveal: 'always', panel: 'new' },
  },
  {
    label: 'LLM: Full Project Review (256K context)',
    type: 'shell',
    command: `node "${LLM_SCRIPT}" --mode review --ctx 262144 ${'${file}'}`,
    problemMatcher: [],
    group: { kind: 'test', isDefault: false },
    presentation: { reveal: 'always', panel: 'new' },
  },
];

if (detectedFrameworks.has('nextjs')) {
  tasks.push({
    label: 'Next.js Lint & Type Check',
    type: 'shell',
    command: 'next lint && tsc --noEmit',
    group: { kind: 'test', isDefault: false },
    presentation: { reveal: 'always', panel: 'new' },
  });
}
if (detectedFrameworks.has('laravel')) {
  tasks.push({
    label: 'Laravel Test Suite',
    type: 'shell',
    command: 'php artisan test',
    group: { kind: 'test', isDefault: false },
    presentation: { reveal: 'always', panel: 'new' },
  });
}
if (detectedFrameworks.has('wordpress')) {
  tasks.push({
    label: 'WordPress PHP Lint',
    type: 'shell',
    command: 'php -l ${file}',
    problemMatcher: ['$php'],
    group: { kind: 'test', isDefault: false },
    presentation: { reveal: 'always', panel: 'new' },
  });
}
if (detectedFrameworks.has('vite')) {
  tasks.push({
    label: 'Vitest Run',
    type: 'shell',
    command: 'npx vitest run',
    group: { kind: 'test', isDefault: false },
    presentation: { reveal: 'always', panel: 'new' },
  });
}
if (detectedFrameworks.has('electron')) {
  tasks.push({
    label: 'Electron: Rebuild Native Modules',
    type: 'shell',
    command: 'npx electron-rebuild',
    group: { kind: 'build', isDefault: false },
    presentation: { reveal: 'always', panel: 'new' },
  });
}
if (detectedFrameworks.has('react-native')) {
  tasks.push({
    label: 'React Native: Start Metro',
    type: 'shell',
    command: 'npx react-native start',
    group: { kind: 'build', isDefault: false },
    presentation: { reveal: 'always', panel: 'new' },
  });
}

// Merge managed tasks with any existing custom tasks
const allTasks = [...tasks, ...existingCustomTasks];
fs.writeFileSync(
  tasksJsonPath,
  JSON.stringify({ version: '2.0.0', tasks: allTasks }, null, 2),
);
log('✅ VS Code tasks created (review, security, tests, docs, full-project).');
if (existingCustomTasks.length > 0) {
  log(`   ℹ️  Preserved ${existingCustomTasks.length} custom task(s).`);
}

// 10. Final Summary
log('\n🎉 Setup complete!');
log('📌 VS Code: ⌘+Shift+P → "Tasks: Run Task" → pick an LLM task');
log('   Available: Code Review, Security Audit, Generate Tests, Generate Docs, Full Project Review');
log(
  '🔁 Git hooks will now run review + security automatically on commit',
);
log(`🔍 Detected frameworks: ${[...detectedFrameworks].join(', ')}`);
log('💡 Draft outputs (tests/docs) will be saved as *.llm-draft files');

/**
 * scanner.js — Scans a project to auto-generate tasks from TODOs, FIXMEs, and code smells.
 */
import fs from 'fs';
import path from 'path';

const IGNORE_DIRS = new Set([
  'node_modules', 'vendor', '.git', '.llm-orchestrator', 'dist', 'build',
  '.next', '.nuxt', 'coverage', '__pycache__', '.cache', '.output',
]);

const SCAN_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.php', '.py', '.rb', '.go',
  '.java', '.rs', '.vue', '.svelte', '.css', '.scss',
]);

const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX|BUG|OPTIMIZE)\b\s*:\s*(.+)/gi;
const DEPRECATED_PATTERN = /@deprecated[:\s]*(.*)/gi;

const C_STYLE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs', '.css', '.scss', '.vue', '.svelte']);
const HASH_EXTS = new Set(['.py', '.rb']);

function getExtGroup(ext) {
  if (C_STYLE_EXTS.has(ext)) return 'c-style';
  if (HASH_EXTS.has(ext)) return 'hash';
  if (ext === '.php') return 'php';
  return 'default';
}

/**
 * Extract only comment content from a line based on language group.
 * Returns the comment text, or null if the line contains no comment.
 * `state` is mutated across lines to track multi-line block comments.
 */
function extractCommentContent(line, extGroup, state) {
  if (extGroup === 'default') return line;

  if (extGroup === 'hash') {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) return trimmed.slice(1);
    return null;
  }

  // c-style and php both support // and /* */
  if (extGroup === 'c-style' || extGroup === 'php') {
    if (state.inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx !== -1) {
        state.inBlockComment = false;
        return line.slice(0, endIdx);
      }
      return line;
    }

    const blockStart = line.indexOf('/*');
    if (blockStart !== -1) {
      const afterOpen = line.slice(blockStart + 2);
      const blockEnd = afterOpen.indexOf('*/');
      if (blockEnd !== -1) {
        return afterOpen.slice(0, blockEnd);
      }
      state.inBlockComment = true;
      return afterOpen;
    }

    const slashIdx = line.indexOf('//');
    if (slashIdx !== -1) return line.slice(slashIdx + 2);

    // php also supports # comments
    if (extGroup === 'php') {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#')) return trimmed.slice(1);
    }

    return null;
  }

  return line;
}

function walkDir(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function scanFile(filePath, projectPath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const relativePath = path.relative(projectPath, filePath);
  const lines = content.split('\n');
  const findings = [];
  const extGroup = getExtGroup(path.extname(filePath));
  const state = { inBlockComment: false };

  for (let i = 0; i < lines.length; i++) {
    const commentContent = extractCommentContent(lines[i], extGroup, state);
    if (commentContent === null) continue;

    // TODO/FIXME/HACK/XXX/BUG/OPTIMIZE
    for (const match of commentContent.matchAll(TODO_PATTERN)) {
      findings.push({
        type: mapTagToType(match[1].toUpperCase()),
        tag: match[1].toUpperCase(),
        description: match[2].trim(),
        file: relativePath,
        line: i + 1,
      });
    }

    // @deprecated
    for (const match of commentContent.matchAll(DEPRECATED_PATTERN)) {
      if (match[1].trim()) {
        findings.push({
          type: 'refactor',
          tag: 'DEPRECATED',
          description: `Remove deprecated: ${match[1].trim()}`,
          file: relativePath,
          line: i + 1,
        });
      }
    }
  }

  return findings;
}

function mapTagToType(tag) {
  switch (tag) {
    case 'TODO': return 'feature';
    case 'FIXME': return 'bugfix';
    case 'BUG': return 'bugfix';
    case 'HACK': return 'refactor';
    case 'XXX': return 'refactor';
    case 'OPTIMIZE': return 'refactor';
    default: return 'chore';
  }
}

function generateTaskId(finding) {
  // Deterministic ID from file + line + tag
  const raw = `${finding.file}:${finding.line}:${finding.tag}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `scan-${Math.abs(hash).toString(36)}`;
}

export function scanProject(projectPath) {
  const files = walkDir(projectPath);
  const allFindings = [];

  for (const file of files) {
    try {
      const findings = scanFile(file, projectPath);
      allFindings.push(...findings);
    } catch (err) {
      process.stderr.write(`  ⚠️  Scanner: could not read ${path.relative(projectPath, file)}: ${err.message}\n`);
    }
  }

  // Convert findings to tasks
  return allFindings.map(f => ({
    id: generateTaskId(f),
    title: `[${f.tag}] ${f.description}`,
    description: `Found ${f.tag} in ${f.file}:${f.line}\n\n${f.description}`,
    type: f.type,
    source: 'scan',
    file: f.file,
    line: f.line,
    priority: f.tag === 'BUG' || f.tag === 'FIXME' ? 'high' : 'normal',
  }));
}

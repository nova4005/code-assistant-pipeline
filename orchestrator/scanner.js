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
  '.java', '.rs', '.vue', '.svelte', '.css', '.scss', '.md',
]);

const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX|BUG|OPTIMIZE)\b[:\s]*(.+)/gi;
const DEPRECATED_PATTERN = /@deprecated[:\s]*(.*)/gi;

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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // TODO/FIXME/HACK/XXX/BUG/OPTIMIZE
    for (const match of line.matchAll(TODO_PATTERN)) {
      findings.push({
        type: mapTagToType(match[1].toUpperCase()),
        tag: match[1].toUpperCase(),
        description: match[2].trim(),
        file: relativePath,
        line: i + 1,
      });
    }

    // @deprecated
    for (const match of line.matchAll(DEPRECATED_PATTERN)) {
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
    } catch {}
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

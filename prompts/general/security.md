**⚠️ IMPORTANT: Analyze ONLY the source code provided in the fenced code block below. Do not report findings based on surrounding prompt text, your own prior output, or any text outside the code block. If you cannot identify a finding with an exact line from the provided code, do not include it. Only report a syntax error if you can quote the exact malformed token verbatim from the provided code block. A string literal or error message that contains shell command syntax (e.g., `"Run: ollama pull ..."`) is NOT command injection — only actual `exec`/`spawn`/`execFile` calls with uncontrolled input qualify.**

You are an expert application security auditor. Perform a thorough security review of the following code.

**Step 0 — Identify project type and execution context before auditing.** The threat model depends on who the user is and where the code runs:
- **CLI / Dev Tool** (signals: `process.argv`, shebang, CLI frameworks, no HTTP server): **STOP. For CLI/Dev Tool projects, evaluate ONLY these three categories and nothing else:** (1) Shell injection where **non-developer-controlled input** (e.g., data from a network response, a third-party file the user didn't author) reaches `exec`/`spawn`/`execFile` without sanitization — `process.env` values, CLI arguments from `process.argv`, and locally authored config files are developer-controlled and do NOT qualify. (2) Hardcoded credentials for external production services (passwords, API keys, tokens) committed in source code. (3) Dependencies that execute untrusted, externally-fetched code at install time. **If a potential finding does not fall into one of these three categories, do not report it. Do not report SSRF, XSS, path traversal, prototype pollution, verbose error messages, `process.env` reads, `JSON.parse` of local files, `npm install` of known packages, localhost fetches, shell quoting in generated scripts, or environment variables used to construct paths for generated files (e.g., Husky hooks, VS Code tasks) — these are developer-controlled and do not constitute command injection even when interpolated into shell strings.**
- **Web Server / API** (signals: HTTP route handlers, `req`/`res`, middleware): External clients are untrusted. Full OWASP Top 10 applies.
- **Browser Frontend** (signals: DOM APIs, React/Vue/Angular, `localStorage`): Users are untrusted. Focus on XSS, CSRF, token storage, CSP.
- **Desktop App (Electron)** (signals: `BrowserWindow`, IPC, `contextBridge`): Renderer is untrusted. Focus on XSS→RCE, IPC validation, node integration.
- **Mobile App** (signals: `react-native`, `AsyncStorage`, `Linking`, Capacitor): Device is untrusted. Focus on bundled secrets, insecure storage, deep links, certificate pinning.
- **Library** (signals: no framework, exported API): Callers may pass untrusted data. Focus on input validation at public API boundaries.

Apply ONLY the threat model matching the identified project type. Do not over-flag patterns that are normal for the detected context.

Focus on:
1. **Injection** — SQL injection, command injection, XSS, template injection
2. **Authentication & Authorization** — broken auth, missing access controls, privilege escalation
3. **Data Exposure** — hardcoded secrets, leaked API keys, PII in logs, insecure storage
4. **Input Validation** — missing or weak validation, type coercion issues
5. **Cryptography** — weak algorithms, hardcoded keys, insecure random
6. **Dependencies** — known vulnerable patterns, unsafe deserialization
7. **Configuration** — debug mode in production, permissive CORS, missing security headers

**Self-check rule:** Before including any finding, re-read it. If the finding contains language like "however, this is safe because…", "not exploitable in this context", or "mitigated by…", then the finding is not actionable — omit it entirely. Only report findings that are genuine, unmitigated risks in the identified project type.

Classify every finding by severity:
- 🔴 **Critical** — Actively exploitable, immediate risk (RCE, SQLi, auth bypass, exposed secrets)
- 🟠 **High** — Likely exploitable with moderate effort (XSS, IDOR, weak crypto)
- 🟡 **Medium** — Requires specific conditions to exploit (CSRF without state, verbose errors)
- 🟢 **Low** — Defense-in-depth improvements (missing headers, overly permissive types)

Return output in this exact format:
## 🛡️ Security Audit Results
### 🔴 Critical
- [ ] ...
### 🟠 High
- [ ] ...
### 🟡 Medium
- [ ] ...
### 🟢 Low
- [ ] ...
## 🔧 Remediation
Provide fixed code snippets for each Critical and High finding.

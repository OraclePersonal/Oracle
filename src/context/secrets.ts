import type { ContextFile } from "../types.js";

export interface SecretFinding {
  path: string;
  line: number;
  detector: string;
}

const TOKEN_DETECTORS = [
  { detector: "openai-api-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/ },
  { detector: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ }
];

const PLACEHOLDER_PATTERN = /^(?:["']?(?:your[-_ ]?|example[-_ ]?|sample[-_ ]?|test[-_ ]?)?(?:api[-_ ]?)?(?:key|token|secret|password)(?:[-_ ]?here)?["']?|<[^>]+>|\$\{[^}]+\}|process\.env\.[A-Z0-9_]+|undefined|null)$/i;
const ASSIGNMENT_PATTERN = /(?:password|passwd|pwd|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret)\s*(?:=|:)\s*(.+?)\s*[,;]?\s*$/i;

export function scanFilesForSecrets(files: ContextFile[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(line)) {
        findings.push({ path: file.path, line: index + 1, detector: "private-key" });
        continue;
      }

      const tokenDetector = TOKEN_DETECTORS.find(({ pattern }) => pattern.test(line));
      if (tokenDetector) {
        findings.push({ path: file.path, line: index + 1, detector: tokenDetector.detector });
        continue;
      }

      const assignment = line.match(ASSIGNMENT_PATTERN);
      if (assignment) {
        const value = assignment[1].trim().replace(/^["']|["']$/g, "");
        if (value.length >= 8 && !PLACEHOLDER_PATTERN.test(value)) {
          findings.push({ path: file.path, line: index + 1, detector: "sensitive-assignment" });
        }
      }
    }
  }
  return findings;
}

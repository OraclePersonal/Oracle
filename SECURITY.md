# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a vulnerability

If you discover a security vulnerability, **do not open a public GitHub Issue.**

Email the maintainer directly at the contact listed in the repository profile,
or open a private security advisory via GitHub's [Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/reporting-a-vulnerability) feature.

Include:
- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Suggested fix (if any)

We aim to acknowledge reports within 3 business days and provide a fix timeline
within 7 business days.

## Security considerations for users

- **File-backed stores:** Oracle stores all memory, messages, and tasks as
  plain JSON files under `~/.oracle/`. Do not store secrets (API keys, tokens)
  in memory entries or message bodies.
- **Workspace confinement:** the agent sandbox is confined to the workspace root,
  but the bash tool runs real shell commands. Review `--plan` output before
  confirming execution on untrusted codebases.
- **No network encryption:** the message bus and task store are local files only.
  Do not expose `~/.oracle/` over a network share.
- **MCP server stdio:** the MCP server communicates over stdio (stdin/stdout).
  Only wire it into MCP clients you trust.

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*

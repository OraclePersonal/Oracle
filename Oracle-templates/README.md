# Oracle-templates

> Scaffold skills, oracles, and sessions — never start from scratch.

Template management system for the Oracle ecosystem. Create, list, install,
uninstall, and apply reusable templates.

## Quick start

```bash
npm install && npm run build
```

## CLI Usage

```
oracle-templates list                 List installed templates
oracle-templates list --builtin       List built-in templates
oracle-templates install <file>       Install from JSON
oracle-templates uninstall <name>     Remove by name
oracle-templates apply <name>         Apply to cwd
oracle-templates create skill <name>  Scaffold a skill
oracle-templates create oracle <name> Scaffold an oracle
```

## Programmatic API

```typescript
import { listTemplates, installTemplate, createSkillTemplate } from "oracle-templates";
const { data: templates } = await listTemplates();
```

## Template format

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique name |
| `type` | string | `skill`, `oracle`, or `session` |
| `description` | string | Description |
| `version` | string | Semver |
| `files` | object[] | Files to scaffold |
| `metadata` | object | Type-specific data |

## Layout

```
.oracle/templates/      # Installed templates
templates/built-in/     # Shipped templates
src/
├── cli.ts              # CLI entry point
├── templates/          # Template logic
└── types.ts            # Shared types
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript |
| `npm run check` | Type-check only |
| `npm run dev` | Run CLI via tsx |
| `npm start` | Run compiled |
| `npm test` | Run tests |

## Related

- [Oracle](https://github.com/JonusNattapong/Oracle) — CLI for AI code consulting
- [Oracle-memory](https://github.com/JonusNattapong/Oracle-memory) — File-backed MCP memory server
- [Oracle-messages](https://github.com/JonusNattapong/Oracle-messages) — MCP message bus
- [Oracle-skill](https://github.com/JonusNattapong/Oracle-skill) — Cross-agent workflow docs

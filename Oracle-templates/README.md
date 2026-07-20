# Oracle-templates

Template management system for the Oracle ecosystem — create, list, install, and uninstall skill, oracle, and session templates.

## What it does

Oracle-templates manages reusable JSON template definitions for the Oracle ecosystem. It scaffolds skill and oracle templates (writing them to `.oracle/templates/`), lists installed and built-in templates, installs/uninstalls templates from JSON files, and applies a template by writing its declared scaffold files to a target directory.

## Install / Build

```bash
npm install
npm run build      # compile TypeScript to dist/
```

## Usage

The CLI is `oracle-templates` (bin → `dist/cli.js`).

```
oracle-templates list                  List installed templates
oracle-templates list --builtin        List templates shipped with the package
oracle-templates install <file>        Install a template from a JSON file
oracle-templates uninstall <name>      Remove an installed template by name
oracle-templates apply <name>          Write the template's scaffold files (to cwd)
oracle-templates apply <name> -o <dir> Write scaffold files to <dir>
oracle-templates create skill <name>   Scaffold a skill template
oracle-templates create oracle <name>  Scaffold an oracle template
```

Options for `create skill` and `create oracle`:

- `-d, --description <desc>` — description
- `-a, --author <author>` — author
- `-t, --tags <tags>` — comma-separated tags
- `-m, --model <model>` — default model (oracle only, e.g. `sonnet`, `opus`)

Templates are stored as JSON files in `<projectRoot>/.oracle/templates/` (default project root is `process.cwd()`). There is no environment variable or config file; the store location is derived from the current working directory.

Note: `session` is accepted as a `type` value in the template schema, but no `create session` subcommand or session-scaffolding function exists in this version.

## Library API

Importable from `oracle-templates` (`main` → `dist/index.js`):

- `createSkillTemplate(opts)` — returns a `Template` for a skill scaffold
- `createOracleTemplate(opts)` — returns a `Template` for an oracle agent manifest
- `listTemplates(projectRoot?)` — list installed templates
- `listBuiltinTemplates()` — list built-in templates
- `installTemplate(sourcePath, projectRoot?)` — install from a JSON file
- `uninstallTemplate(name, projectRoot?)` — remove by name
- `applyTemplate(name, targetDir?, projectRoot?)` — write scaffold files

All store functions return a `TemplateResult` (`{ ok, summary, data? }`).

## Template format

A template is a JSON object validated by `TemplateSchema`:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique template name |
| `type` | `"skill" \| "oracle" \| "session"` | Template category |
| `description` | string | Human-readable description |
| `version` | string | Semver (default `"1.0.0"`) |
| `author` | string | Optional author |
| `tags` | string[] | Search/filter tags |
| `files` | `{ path, content }[]` | Files written on apply |
| `metadata` | object | Type-specific payload |

## Layout

```
templates/built-in/   # templates shipped with the package
src/
├── cli.ts            # CLI entry point
├── index.ts          # library barrel
├── types.ts          # Template schema & types
├── utils.ts          # filesystem / path helpers
└── templates/        # store + skill/oracle scaffolding
```

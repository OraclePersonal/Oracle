# Support

## Getting help

- **Documentation:** Start with [docs/getting-started.md](docs/getting-started.md)
  and [docs/architecture.md](docs/architecture.md).
- **Issues:** Open a [GitHub Issue](https://github.com/OraclePersonal/Oracle/issues)
  for bugs and feature requests.
- **Discussions:** Use [GitHub Discussions](https://github.com/OraclePersonal/Oracle/discussions)
  for questions, ideas, and community chat.

## Common issues

### `oracle doctor` shows no provider

Set an API key or log in with the Codex CLI:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
# or
codex login
```

Then run `oracle doctor` again.

### `oracle_*` tools not appearing in Claude Code

1. Run `oracle setup-mcp --client claude-code`
2. Restart Claude Code completely
3. Verify `.mcp.json` exists in the project root

### Agent loop exits without doing anything

The configured provider must be `anthropic` or `opencode` for the agent loop to
run. `codex` does not support the tool-use loop. Check with `oracle doctor`.

### Messages not showing up

Verify both agents are registered:

```bash
oracle msg agents
```

Check the agent name matches exactly (case-sensitive).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and PR guidelines.

## License

MIT — see [LICENSE](LICENSE).

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*

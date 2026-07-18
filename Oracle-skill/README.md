# Oracle Skill

> The instruction manual you hand your AI. One file that teaches any agent how to use the Oracle stack *correctly*.

Giving an agent access to memory and a message bus is easy. Teaching it the *habits* —
recall before you start, onboard before you message, write down what you learned
before you stop — is the hard part. **Oracle Skill** is that habit, packaged as
a single portable `SKILL.md`.

## Quick start

Drop [`SKILL.md`](./SKILL.md) into your agent's skills directory:

```bash
# Claude Code
cp SKILL.md .claude/skills/oracle/
```

The agent discovers it automatically. No config, no wiring.

## What your agent learns

| Habit | Why |
|-------|-----|
| Detect first | Check which MCP servers are connected |
| Start right | Recall memory, then onboard onto the bus |
| Core loop | Wait → resolve threads → handle tasks → write memory → repeat |
| Remember where | When to write fact vs insight vs chunk vs working |
| Full toolbox | Complete tool/resource reference for both MCP surfaces |

## Layout

```
SKILL.md       # The product — this is what agents read
README.md      # The trailer (this file)
```

## Related

- [Oracle](https://github.com/JonusNattapong/Oracle) — CLI for AI code consulting
- [Oracle-memory](https://github.com/JonusNattapong/Oracle-memory) — File-backed MCP memory server
- [Oracle-messages](https://github.com/JonusNattapong/Oracle-messages) — MCP message bus
- [Oracle-templates](https://github.com/JonusNattapong/Oracle-templates) — Template system

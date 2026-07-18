# Oracle

> A senior engineer you can summon with one command. It reads your code, thinks with a real model, remembers what it learned, and can talk to other agents while it works.

**Oracle** is an MCP-powered AI coding consultant. Point it at some files,
ask a question, and it bundles the right context, sends it to the model of
your choice, and hands back a real review — not a vibe.

```
you ──▶ oracle consult ──▶ bundle context ──▶ think (AI) ──▶ answer
               │                                              │
         skills · oracles                              saved as session
               │                                              │
     memory (oracle-memory)  ◀───────────────────▶  mesh (oracle-messages)
```

## Quick start

```bash
npm install && npm run build
node dist/cli.js doctor          # check provider is wired up
node dist/cli.js consult -p "Review this" -f "src/**/*.ts"
```

## The one command: `consult`

```bash
oracle consult -p "Review for edge cases" -f "src/**/*.ts"
oracle consult -p "Find bugs" --skill debug
oracle consult --oracle senior-review -p "Review this PR"
oracle consult -p "Review my changes" --diff
oracle consult -p "Follow-up" --previous-session-id <id>
```

## Skills

Five built-in: `review`, `debug`, `architecture`, `tests`, `security`.

```bash
oracle skill list
oracle skill install ./my-skill.json
```

## Named oracles

A skill + a persistent memory:

```bash
oracle oracle register --name senior-review --skill review --memory
oracle consult --oracle senior-review -p "Review this"
```

## Peers

```bash
oracle peer send --to claude --body "Review complete" --kind review-result
oracle peer list --agent oracle --limit 10
```

## Layout

```
~/.oracle/
├── oracles/        # named profiles
├── skills/         # custom skills
├── sessions/<id>/  # consult history
└── auth/           # provider tokens

<project>/
├── .oracle/config.json
├── .oracle-memory/     # facts · insights · chunks · working
└── .oracle/messages/   # shared mailbox
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript |
| `npm run check` | Type-check only |
| `npm run dev` | Run via tsx |
| `npm start` | Run compiled |
| `npm test` | Run tests |

## Related

- [Oracle-memory](https://github.com/JonusNattapong/Oracle-memory) — File-backed MCP memory server
- [Oracle-messages](https://github.com/JonusNattapong/Oracle-messages) — MCP message bus
- [Oracle-skill](https://github.com/JonusNattapong/Oracle-skill) — Cross-agent workflow docs
- [Oracle-templates](https://github.com/JonusNattapong/Oracle-templates) — Template system
- [Oracle-dashboard](https://github.com/JonusNattapong/Oracle-dashboard) — Live web dashboard
- [Oracle-eval](https://github.com/JonusNattapong/Oracle-eval) — Benchmark suite

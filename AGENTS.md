# AGENTS.md — openfox-codebase-memory

Paths relative to `openfox-plugins/openfox-codebase-memory/`.

## Purpose

OpenFox plugin integrating codebase-memory-mcp: structural code knowledge graph, interactive visualization, automatic synchronization, and project management.

## Stack

- TypeScript, ESM, tsup, vitest 3.x
- peerDep: `openfox >=2.0.0 <3`
- Optional dependency: `better-sqlite3` (for reading OpenFox DB)

## Commands

```bash
npm run build      # tsup
npm test           # vitest run --passWithNoTests
npm run typecheck  # tsc --noEmit
```

## Project Map

```
src/
├── index.ts        # Plugin entry point (register, UI, RPCs)
├── client.ts       # CodebaseMemoryClient (codebase-memory-mcp integration)
├── types.ts        # Shared TypeScript types
├── index.test.ts   # Entry point tests
└── client.test.ts  # Client tests
```

## Where to Look What

- **Modify codebase-memory-mcp integration** → `src/client.ts`
- **Add a setting** → `src/index.ts` (SETTINGS_SCHEMA)
- **Add an RPC** → `src/index.ts`
- **Modify types** → `src/types.ts`

## Conventions

- `apiVersion: 2`, capabilities: `settings`, `tools`, `rpc`, `ui`, `hooks`, `assets`
- ESM build only via tsup
- `openfox` and `better-sqlite3` are externalized
- Full EN & FR translations

## Cross-Project Dependencies

**Consumes**: `openfox/plugin` (PluginRegistry, PluginContext), OpenFox SQLite DB (sessions.db).

**Consumed by**: OpenFox (loaded as plugin).

**Touchpoints**:

- `src/index.ts` (register)
- `src/client.ts` (CodebaseMemoryClient)

## Known Gotchas

- `dist/index.js` is the entry point loaded by OpenFox, not `src/`.
- The plugin reads the OpenFox SQLite DB (sessions.db) — multi-platform paths apply.
- UI is sandboxed in OpenFox modals.

## Do Not Read / Do Not Touch

- `node_modules/`, `dist/`, `.git/`
- `assets/` (static files)

## Further Reading

- [README.md](README.md) — overview

---

> After any change affecting structure, a command, a convention, an inter-project contract, or a primary flow, update this file in the same commit. If any information here is inaccurate, fix it.

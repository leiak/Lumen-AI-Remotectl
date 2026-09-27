# remotectl

Mobile companion for running Claude Code jobs from your phone. A small Node server exposes a REST + WebSocket API to a Capacitor-wrapped React app; jobs are driven by the `claude` CLI and state is synced live over a single WebSocket.

## Architecture

The repo is a pnpm workspace with three packages:

| Package | What it does |
| --- | --- |
| `server` (`@remotectl/server`) | Express + `ws` API (HTTP on `:8787`, WS on `:8788`), SQLite via `libsql`/Drizzle, push-notification pipeline, scheduler. Loopback-only in v0.1. |
| `cli` (`@remotectl/cli`) | The `remotectl` command. Generates the API key, runs migrations, starts the server, and prints the token. |
| `app` (`@remotectl/app`) | React + Vite SPA wrapped by Capacitor into iOS/Android. Settings → Server URL + API Key; live Inbox and Issue Detail. |

Bootstrap flow: `remotectl start` → CLI opens SQLite → generates/loads API key → instantiates `createApp()` from `@remotectl/server` → prints `HTTP`, `WS`, and `Token` lines.

## Quick start

See **[docs/SETUP.md](docs/SETUP.md)** for prerequisites (Node 22+, pnpm 9, Claude Code, Tailscale), Tailscale setup, the full clone-and-install flow, and how to wire the phone to the workstation.

Short version:

```bash
git clone <repo> remotectl
cd remotectl
pnpm install
pnpm --filter @remotectl/cli build
remotectl start   # prints: HTTP, WS, Token
```

## Development

From the repo root:

```bash
pnpm install   # install all workspace deps
pnpm dev       # run `dev` script in every package in parallel
pnpm build     # build every package
pnpm test      # run the test suite in every package
```

Per-package:

```bash
pnpm --filter @remotectl/server dev       # tsx watch
pnpm --filter @remotectl/server test      # vitest
pnpm --filter @remotectl/server build
pnpm --filter @remotectl/cli dev          # tsx (no build needed)
pnpm --filter @remotectl/cli build
pnpm --filter @remotectl/app dev          # vite dev server (port 5173)
pnpm --filter @remotectl/app build        # builds to ./dist (Capacitor webDir)
pnpm --filter @remotectl/app test         # vitest
```

Adding native platform projects (one-time, from `app/`):

```bash
pnpm --filter @remotectl/app exec cap add ios
pnpm --filter @remotectl/app exec cap add android
```

After each web rebuild, sync assets:

```bash
pnpm --filter @remotectl/app exec cap sync
```

## Repository layout

```
remotectl/
├── package.json             # workspace root, pnpm@9
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docs/
│   └── SETUP.md             # end-to-end setup guide
├── server/
│   ├── src/                 # Express app, ws, push, scheduler, db
│   └── data/                # local SQLite (gitignored)
├── cli/
│   ├── src/commands/        # `start`, `token`
│   └── dist/                # built binary (./dist/index.js → `remotectl`)
└── app/
    ├── src/                 # React SPA
    ├── capacitor.config.json
    └── vite.config.ts
```

## Configuration

The CLI reads these environment variables (defaults shown):

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP listen port |
| `WS_PORT` | `8788` | WebSocket listen port |
| `DB_PATH` | `~/.remotectl/server.db` | SQLite path |
| `CLAUDE_BINARY` | `claude` | Path to the Claude Code CLI |

The server itself reads `server/src/config.ts` for adapter paths (`claude` + `--dangerously-skip-permissions --output-format stream-json`) and a default workspace root under `$HOME/code`.

## License

MIT.

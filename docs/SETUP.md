# Setup Guide

End-to-end setup for developing and running **remotectl** on a workstation plus a phone.

> The repo is a pnpm workspace. Each package (`server`, `app`, `cli`) builds and tests independently; the CLI is the runtime entry point for the server.

## Prerequisites

Install these before continuing:

- **Node.js 22 or newer** (the workspace targets TypeScript ES2024 and uses `@types/node` ^22 in the CLI; the server uses ^24. Anything from Node 22 LTS upward works.)
- **pnpm 9** — install with `corepack enable && corepack prepare pnpm@9 --activate`.
- **Git**.
- **Claude Code** — the server shells out to the `claude` binary (see `server/src/config.ts`). Install from <https://docs.claude.com/claude-code> and verify with `claude --version`.
- **Tailscale** — installed and signed in on both your workstation and your phone. Used so the phone can reach the workstation over a private `100.x.x.x` IP. Tailnet must be reachable from the phone's network (use the official Tailscale mobile app).

### Tailscale setup

| Platform | Install |
| --- | --- |
| **macOS** | `brew install --cask tailscale` or download from <https://tailscale.com/download/mac>. Sign in via the menu bar app. |
| **Windows** | Download from <https://tailscale.com/download/windows>. Sign in from the system tray. |
| **Linux** | `curl -fsSL https://tailscale.com/install.sh \| sh` then `sudo tailscale up`. |

After installing, confirm your IP:

```bash
tailscale ip -4
# 100.x.y.z
```

Run the same command on each device to confirm both are on the same tailnet.

## Clone and install

```bash
git clone <repository-url> remotectl
cd remotectl
pnpm install
```

`pnpm install` resolves all three workspace packages (`server`, `app`, `cli`).

## Build the CLI

The `remotectl` command wraps the server. Build once so the binary is symlinked into your PATH:

```bash
pnpm --filter @remotectl/cli build
```

After this, `remotectl --help` (showing `Usage: remotectl <start|token>`) is available from any directory.

> To iterate without rebuilding, use `pnpm --filter @remotectl/cli dev` — it runs the CLI via `tsx` and reloads on edits.

## Start the server

Run the server in a dedicated terminal and **keep it open**:

```bash
remotectl start
```

On first run the CLI:

1. Creates `~/.remotectl/server.db` (Windows: `%USERPROFILE%\.remotectl\server.db`) and runs migrations.
2. Generates an API key and stores it.
3. Prints the key in the output:

   ```text
   remotectl server listening
     HTTP: http://127.0.0.1:8787
     WS:   ws://127.0.0.1:8788
     Token: sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   ```

**Copy the `Token` value.** You will paste it into the mobile app.

To retrieve the API key later (e.g. after restarting):

```bash
remotectl token
```

To override defaults, set environment variables before `remotectl start`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP listen port |
| `WS_PORT` | `8788` | WebSocket listen port |
| `DB_PATH` | `~/.remotectl/server.db` | SQLite database location |
| `CLAUDE_BINARY` | `claude` | Path to the Claude Code binary |

> v0.1 limitation: the HTTP and WS servers bind to `127.0.0.1` only (see the comment in `server/src/ws/server.ts`). To reach the server from your phone you need a Tailscale-port-forwarding or loopback tunnel — see **Troubleshooting** below.

## Keep the workstation awake

The server is meant to run for long stretches while you queue work from your phone.

- **macOS**: `caffeinate -d -i -s remotectl start` (prevents display sleep, idle sleep, and system sleep while running). Press Ctrl+C to stop.
- **Windows**: Settings → System → Power & battery → set **Screen and sleep** to "Never" while plugged in for the duration, or use `powercfg /change standby-timeout-ac 0` from an elevated prompt. Restart `powercfg /change standby-timeout-ac 15` afterwards to restore.
- **Linux**: Most desktops have a GUI toggle; from the command line, `systemd-inhibit --what=handle-suspend-sleep --why="remotectl" remotectl start`.

## Run the development stack

In separate terminals:

```bash
# Terminal 1 — server
remotectl start

# Terminal 2 — web app (Vite dev server, hot reload)
pnpm --filter @remotectl/app dev
# → http://localhost:5173

# Terminal 3 — server tests (when iterating on server code)
pnpm --filter @remotectl/server test
```

Or run all packages in parallel from the repo root:

```bash
pnpm dev   # runs `dev` in every workspace package
pnpm test  # runs the test suite in every workspace
pnpm build # builds every workspace package
```

## Build and run the mobile app

The app is a Capacitor shell wrapping a Vite/React build.

```bash
# Build the web bundle Capacitor packages into the native shell:
pnpm --filter @remotectl/app build

# (First-time only) Add native platform projects:
pnpm --filter @remotectl/app exec cap add ios
pnpm --filter @remotectl/app exec cap add android

# Sync the latest web build + plugins into the native projects:
pnpm --filter @remotectl/app exec cap sync

# Open the native IDEs:
pnpm --filter @remotectl/app exec cap open ios
pnpm --filter @remotectl/app exec cap open android
```

After each rebuild, rerun `cap sync` so the native projects pick up new assets. From the iOS/Android simulator on the same machine, `http://localhost:8787` works. From a physical device, see **Connect from a physical phone** below.

## Connect from a physical phone

1. On the workstation, find your Tailscale IP: `tailscale ip -4` (e.g. `100.64.0.2`).
2. In the app, open the **Settings** page.
3. Enter:
   - **Server URL**: `http://100.x.x.x:8787` (substitute your workstation's IP).
   - **API Key**: the `sk-…` token from `remotectl token`.
4. Tap **Test connection**. You should see `Connected — N issues`.
5. Tap **Save**.

> Note: because the server binds to `127.0.0.1` only, connecting from a physical phone over Tailscale additionally requires the workstation to forward 8787/8788 from its Tailscale IP back to loopback. Two simple options:
>
> - **SSH reverse tunnel** (Linux/macOS): `ssh -N -R 8787:127.0.0.1:8787 user@$TAILSCALE_HOST` (or run `ssh -N -L 100.64.0.2:8787:127.0.0.1:8787 localhost` if SSHing into the workstation itself).
> - **Tailscale port forwarding**: in the Tailscale admin console, set up a device-specific port forward from the workstation's Tailscale IP to `127.0.0.1:8787`.

## Push notifications (optional)

The server integrates with FCM (Android) and APNs (iOS) for background notifications. Tokens are stored via `POST /api/push/devices` and the server sends notifications from the scheduler pipeline. Configure:

- **Android**: FCM service account JSON via env var (see `server/src/push/fcm.ts`) and the `google-services.json` placed under `app/android/app/`.
- **iOS**: APNs key/cert configured on the Apple Developer portal; `cap sync` then rebuilds the Xcode project.

If push fails to deliver, the app still works in the foreground — see **Troubleshooting**.

## Troubleshooting

### "Tailscale IP not reachable from the phone"

Confirm both devices show the same tailnet name:

```bash
tailscale status
```

On the phone, install the Tailscale app and ensure it's connected. If you see "different tailnet", sign out from one device and rejoin the correct tailnet.

### Server binds to 127.0.0.1 only

By design for v0.1. Use SSH port-forwarding, Tailscale port forwarding, or run the server directly on the phone via Termux + loopback if your phone is the dev machine. The HTTP server is `http://127.0.0.1:8787`.

### "Claude binary not found" / server stays idle

The server calls the `claude` CLI to drive sessions. If it isn't on `$PATH`, the server still starts but no jobs run. Fix:

```bash
which claude || echo "not installed"
claude --version
```

If missing, reinstall Claude Code or set `CLAUDE_BINARY=/absolute/path/to/claude` before `remotectl start`.

### App shows "Error: invalid_token" or 401

- The API key on the phone doesn't match the server's. Re-run `remotectl token` on the workstation and re-enter it in **Settings**.
- HTTP and WS ports: confirm 8787 (HTTP) and 8788 (WS) match between `remotectl start` output and the app's URL.

### App shows "Error: connection refused"

- The server isn't running on the workstation. Start it with `remotectl start`.
- The phone can't reach the workstation's Tailscale IP — see **Tailscale IP not reachable** above.

### Push notifications silent on iOS / Android

- Foreground updates always work over the WebSocket — push is only for background delivery.
- iOS: confirm `cap sync` included the latest `GoogleService-Info.plist` (or APNs entitlement) and that the device granted notification permission.
- Android: confirm FCM service account credentials are loaded and the device registered a token (`POST /api/push/devices` should appear in server logs at startup).

### Tests pass locally but CI is red

Run the full matrix first:

```bash
pnpm -r run typecheck 2>/dev/null || true   # only some packages define typecheck
pnpm -r run test
pnpm -r run build
```

If any step fails locally, reproduce CI exactly with `pnpm install --frozen-lockfile` before debugging further.

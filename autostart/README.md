# Autostart toolkit

Makes the gateway (`dist/index.js`, port `8787` by default) come back up
**silently, in the background** whenever you log in - so a reboot, a sleep/
wake cycle, or a crash doesn't leave Hermes (or anything else pointed at
`http://localhost:8787/v1`) unable to reach a model provider until you
remember to run `start.bat`/`start.sh` by hand again.

Pick the folder for your OS. Every script here is safe to re-run (idempotent)
and never touches anything outside what it explicitly documents.

| OS | Mechanism | Folder |
|----|-----------|--------|
| Windows | Shortcut in the per-user Startup folder, runs hidden via PowerShell | [`windows/`](windows) |
| Linux | `systemd --user` service (falls back to a `cron @reboot` entry if systemd isn't usable) | [`linux/`](linux) |
| macOS | `launchd` LaunchAgent | [`macos/`](macos) |

None of these require admin/root/sudo for the common case (a normal desktop
login session). Each `install.sh`/`Install-Autostart.ps1` also runs the
gateway once immediately after installing, so you don't have to reboot just
to confirm it works.

## Windows

```powershell
cd autostart\windows
powershell -ExecutionPolicy Bypass -File Install-Autostart.ps1
```

Or just double-click `autostart\windows\autostart.bat` for a menu (install /
uninstall / status / start now / stop).

This creates one shortcut at `shell:startup` (visible via Win+R ->
`shell:startup`) that silently runs `Gateway-Runner.ps1` at every logon -
no console window, no taskbar icon, nothing to click through. Uses the
Startup folder rather than Task Scheduler because registering an
"at logon" scheduled task for the current user via `schtasks` typically
fails with `Access is denied` unless you're running elevated; the Startup
folder needs no elevation and is exactly how most consumer apps (Slack,
Docker Desktop, etc.) register their own per-user autostart.

Scripts:

- `Install-Autostart.ps1` - installs the Startup shortcut and starts the gateway now.
- `Uninstall-Autostart.ps1` - removes the shortcut. Add `-StopRunning` to also stop a currently-running instance (by default the running gateway is left alone - "don't autostart" and "stop it now" are different decisions).
- `Status.ps1` - read-only: is autostart installed, is it running, does `/health` respond.
- `Stop-Gateway.ps1` - stops the gateway this toolkit started (tracked via a PID file at `.cursor-gateway/autostart.pid`). Never touches a gateway process it didn't start itself.
- `Gateway-Runner.ps1` - the actual launcher (single-instance guard, first-run `npm install`/`npm run build` if needed, log rotation, hidden `Start-Process`, waits for `/health`). This is what the shortcut points at; run it by hand any time to (re)start the gateway in the background.
- `Common.ps1` - shared helpers, dot-sourced by the scripts above; not meant to be run directly.

Logs land in `logs/gateway.log` / `logs/gateway.err.log` (rotated to `*.1`
on each restart) plus `logs/autostart.log` for install/launch/stop events
from this toolkit itself.

## Linux

```bash
cd autostart/linux
chmod +x install.sh uninstall.sh status.sh run.sh   # first time only, if the executable bit didn't survive your download/clone
./install.sh
```

Prefers a `systemd --user` service (`~/.config/systemd/user/cursor-openai-gateway.service`)
for proper supervision (auto-restart on crash). In systemd mode, logs go to
journald - which rotates automatically, unlike plain files - so read them
with `journalctl --user -u cursor-openai-gateway -f`. If `systemctl --user`
isn't usable (some WSL distros without `systemd=true` in `/etc/wsl.conf`,
minimal containers), it transparently falls back to a `@reboot` cron entry
that runs `run.sh`, which does its own PID-file + port-guarded `nohup`
launch and writes `logs/gateway.log` / `logs/gateway.err.log` (rotated to
`*.1` on each restart) like the Windows launcher does.

A `systemd --user` service only starts once you log in, by default. For a
headless box where you want it up before any interactive login, run once:

```bash
loginctl enable-linger "$USER"
```

- `install.sh` - installs + starts (systemd, or cron fallback), then waits up to 20s for `/health`.
- `uninstall.sh` - removes the hook. Add `--stop-running` to also stop a currently-running instance.
- `status.sh` - read-only status + health check.
- `run.sh` - the cron-fallback launcher only; not used when the systemd unit is active (systemd calls `node` directly and supervises it itself). Mirrors the Windows runner's guarantees: PID verified against `/proc/<pid>/cmdline`, port-occupancy guard with adoption, post-launch health confirmation with crash detection.

## macOS

```bash
cd autostart/macos
chmod +x install.sh uninstall.sh status.sh   # first time only
./install.sh
```

Installs a LaunchAgent at `~/Library/LaunchAgents/com.cursor-openai.gateway.plist`
with `RunAtLoad` + `KeepAlive` (restarts on crash, not on a clean exit).
Logs go to `logs/gateway.log` / `logs/gateway.err.log`; note launchd appends
to these forever with no built-in rotation - fine for personal use, but wire
them into `newsyslog(8)` if your request volume makes them heavy.

- `install.sh` - installs + starts.
- `uninstall.sh` - removes the agent. Note: unlike Windows/Linux, `launchctl unload` always stops the running instance too - launchd has no "disable but leave it running" mode, so there's no separate `--stop-running` flag here.
- `status.sh` - read-only status + health check.

macOS support is written the same careful way as the tested Linux path but
hasn't been physically verified on real hardware (see the main
[README's Cross-platform support section](../README.md#cross-platform-support)
for the same caveat about the rest of the project) - please open an issue if
something doesn't work as documented.

## Shared conventions

- **Single-instance guard everywhere.** Re-running install, or an extra
  logon/cron firing, never spawns a duplicate gateway. The PID file is not
  trusted blindly: the recorded PID is verified against the actual process's
  command line (`node ... index.js`), so a PID recycled by an unrelated
  program - even another `node.exe`, like an editor's bundled TypeScript
  server - is treated as stale, never as "already running" and never as a
  kill target.
- **Re-installing never leaves duplicate registrations.** Installers are
  idempotent (re-running refreshes and says so), and they clean up competing
  registrations from earlier setups: the Windows installer removes the
  legacy ad-hoc shortcut name, and the Linux installer handles *mechanism
  switches* both ways - installing the systemd unit removes a leftover cron
  `@reboot` fallback entry, and falling back to cron removes a leftover unit
  file (systemd being unreachable is why it fell back). Status scripts warn
  loudly if a double registration is ever detected instead of silently
  showing only one.
- **Simultaneous starts converge.** The pre-launch port check is not atomic
  with the launch, so two runners firing at once (double logon event,
  overlapping manual + scheduled starts) could both see the port free. The
  runner that loses the race detects a healthy gateway other than its own
  child on the configured port, stops its own duplicate, and adopts the
  winner into the PID file.
- **Port-occupancy guard with adoption (Windows launcher + Linux cron
  fallback).** Before launching, if the configured port is already served by
  a *healthy* gateway the PID file didn't know about (a leftover manual
  `npm start`, a pre-toolkit orphan), that instance is adopted into the PID
  file instead of duplicated - without this, node's own port-fallback would
  silently start a second gateway on the next port up. If the port is held
  by something that is *not* answering `/health`, the launcher refuses with
  a clear log message instead of guessing; it never kills the occupant. A
  healthy gateway whose owning process isn't a directly-manageable node
  process (e.g. a Docker-published port) is left untracked rather than
  falsely claimed. (The systemd and launchd paths don't need this guard for
  autostart itself - their service managers already enforce one instance of
  the unit - but it protects the by-hand `run.sh` case.)
- **Stop only touches what's tracked.** `Stop-Gateway.ps1` / uninstall's
  stop options only ever kill the verified PID from the PID file. A listener
  on the port with no matching PID file entry is reported, not killed.
- **The interactive launchers cooperate too.** `start.bat`/`start.sh` (repo
  root) run the same detection in reverse: if a gateway from this folder is
  already running - e.g. the one this toolkit autostarted - they open its
  dashboard instead of starting a duplicate on a fallback port.
- **Consistent port resolution.** Every script resolves the port exactly the
  way the gateway itself does: `.cursor-gateway/settings.json` (the admin
  dashboard's persisted overlay - wins when present) -> `PORT` in `.env`
  (last assignment wins, quoted values and inline comments tolerated) ->
  the built-in default `8787`.
- **First-run safe.** If you point this at a fresh clone with no
  `node_modules`/`dist` yet, every `install.sh`/`Install-Autostart.ps1` runs
  `npm install` + `npm run build` for you first, exactly like `start.bat`/`start.sh`.
- **`.env` permissions.** Since `.env` holds your real `CURSOR_API_KEY`, the
  Linux/macOS installers `chmod 600` it (owner read/write only) as a matter
  of course. Windows relies on normal per-user NTFS ACLs instead (no direct
  equivalent action needed).
- **Portable paths.** Every script resolves the project root relative to its
  own location - clone this repo anywhere, on any drive, and these scripts
  work unmodified. Nothing here is hardcoded to a particular machine, user,
  or install path.

## Note for maintainers committing from Windows

All `.sh` files here are stored with their executable bit set in git's index
(mode `100755`). Windows can't record that bit from the filesystem - this
repo hit the same issue with `start.sh`, see the main README - so if you add
a **new** shell script to this folder from Windows, set the bit explicitly
after staging it:

```bash
git update-index --chmod=+x autostart/<os>/<new-script>.sh
```

The `chmod +x` line in each platform's quick start additionally covers
downloads/transfers that strip the bit. Line endings are handled repo-wide
by `.gitattributes` (`* text=auto eol=lf`, with `*.bat` checked out CRLF -
cmd.exe's `goto` label scanning misbehaves in LF-only batch files).

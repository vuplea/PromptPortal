# PocketTerminal

Open a terminal window from your phone running on your PC; work remotely.
Open any terminal window from your PC; pick it up from your phone.
Use it for Claude Code, Codex or general terminal needs.

<p align="center"><img src="docs/windows-terminal.png" width="600" alt="A Claude Code session in Windows Terminal on the workstation"></p>
<table align="center">
  <tr>
    <td><img src="docs/phone-home.png" width="270" alt="The hub in the phone browser: running sessions, profiles, quick commands"></td>
    <td><img src="docs/phone.png" width="270" alt="The same session, live in the phone browser"></td>
  </tr>
</table>
<p align="center"><em>One shared pty from both ends: the session in Windows Terminal on the
workstation (top); the hub's home screen and the same session live in the
phone browser (below). Type in either.</em></p>

## Architecture

Three tiers:

- **Client** — the browser (phone or desktop). One page lists every session on
  every connected workstation; open one to view and drive it.
- **Hub**: Serves the UI, authenticates
  clients, and brokers browser sockets to workstations. It is the one piece you host,
  and should add TLS in front of it: for access from the open Internet, a
  reverse proxy and an open port (Dokploy on a cloud VM, is an easy way to set that up);
  or keep it private with a VPN.
- **Workstations**, the machines where terminals actually run: `pt`, one self-contained executable.
  Every session is its own `pt` process owning its pty, dialing the hub over **WebSocket**;
  a small resident `pt launcher` per workstation exists so sessions can be started from the hub.
  The compose deployment also optionally includes one containerized workstation
  (`server`, in its own container beside the hub).

```
  phone ─┐
         ├─(HTTPS/WSS)─▶  HUB  ◀─(outbound WSS per session + launcher)─┬─ Windows workstation "laptop"
 desktop ┘             hub.example.com                                 ├─ Windows workstation "desktop"
                                                                       └─ workstation "server" (its own container, beside the hub)
```

### Shared, cooperative control — and one owner

A session is one shared pty. Its terminal window on the workstation renders
it natively, the browser on your phone watches and types into the same
screen; output reaches both. "Take control remotely" is just opening the
session on your phone; "take control back" is typing at the workstation
again — the first keystroke snaps the pty back to the right window size.

**Closing the window ends the session**, everywhere, always.
There are no headless leftovers on a desktop: what you see in the taskbar
is exactly what exists.


## Docker (hub + `server` workstation)

The compose deployment runs two containers:

- **hub** — the Bun aggregator, nothing else. Serves the UI and brokers
  browsers to workstations; profiles and quick commands persist on the small
  `hub-data` volume.
- **workstation** — a coding workbench registered with the hub as `server`, so
  out of the box you get terminals on the server itself. It bundles Node,
  .NET 10 SDK (`ilspycmd`), Python 3 (`uv`), `gh`, `tmux`, `ripgrep`, `jq`;
  Claude Code and Codex are installed onto the home volume at each container
  start. `/home/user` is a named volume, so auth, repos, and git config
  survive redeploys; running sessions do not.

```sh
cp .env.example .env   # set POCKETTERM_PASSWORD
docker compose up -d --build
```

Configuration, via `.env` or the deploy platform's environment:

| Variable                 | Default  | Purpose                                                       |
| ------------------------ | -------- | ------------------------------------------------------------- |
| `POCKETTERM_PASSWORD`    | required | The one secret: browsers sign in with it (username is always `pocketterm`), and workstations register with it |
| `POCKETTERM_NODE_NAME`   | `server` | The bundled workstation's name in the UI                       |
| `POCKETTERM_TRUST_PROXY` | unset    | Set to `1` when a reverse proxy you control is the only way in: the brute-force lockout then keys on the client IP it appends to `X-Forwarded-For` instead of the proxy's address (see Security notes) |

The hub exposes three WebSocket paths on the same port: `/ws` (browser, token
auth), `/session` and `/launcher` (workstation, node-secret auth). All are
ordinary WebSockets, so a TLS-terminating reverse proxy in front needs no
special config.

### Running the hub non-containerized

```sh
POCKETTERM_PASSWORD='a-long-random-string' bun server.ts
```

The hub reads the variables above, plus:

| Variable          | Default            | Purpose                                   |
| ----------------- | ------------------ | ----------------------------------------- |
| `PORT` / `HOST`   | `8080` / `127.0.0.1` | Listen port / address. Loopback by default — the hub speaks plain HTTP, so set `HOST=0.0.0.0` only with TLS terminating in front |
| `POCKETTERM_DATA` | `./data`           | Where profiles and quick commands persist |

### If using Tailscale, keep the hub private

You can publish it to your tailnet with `tailscale serve`, which adds TLS:

```sh
tailscale serve --bg 27180   # compose hub; bare `bun server.ts`: 8080
```

Use the resulting `https://<machine>.<tailnet>.ts.net` as the hub URL and set
`POCKETTERM_TRUST_PROXY=1`; a bare hub binds `127.0.0.1` by default, so
`serve` is already the only way in.

## Setting up a Windows workstation

MacOS is not implemented yet; support can be added in the future.

The workstation is **one self-contained executable** — `pt.exe` (TypeScript
compiled by Bun, ConPTY) — so the box needs no runtime installed. `pt` in a
terminal hosts a session right there (native Windows Terminal, not a
browser); `pt launcher` is the small logon-task resident that starts sessions
requested from the hub.

Prerequisite: [Bun](https://bun.sh) >= 1.3.14 (build-time only)

From a PowerShell in the repo (no elevation needed):

```powershell
.\windows\install.ps1 -HubUrl https://pocketterminal.example.com
```

It prompts for the hub password, builds `windows\dist\pt.exe`,
persists the config (settings as user
environment variables, the password in **Windows Credential Manager**),
registers a **scheduled task** that runs `pt launcher` at logon, adds
`windows\dist` to your PATH (so `pt` works everywhere), and installs a
Windows Terminal **PocketTerminal profile** that opens a new connected
session in a tab.

To ensure all windows you use are accessible remotely,
set **PocketTerminal profile** as the default Windows Terminal profile.

A session created **remotely** (from the phone) opens as an interactive
window in the workstation's default terminal, already running when you sit
back down. It is the same shared screen as the phone's — and the same
session: closing the window ends it everywhere.

### Workstation configuration

The installer sets these; set them by hand to run `pt` unmanaged.

| Variable               | Default            | Purpose                                            |
| ---------------------- | ------------------ | -------------------------------------------------- |
| `POCKETTERM_HUB_URL`   | unset              | Hub URL (`https://…` / `wss://…`; a bare host means `https`); unset = `pt` is a local-only terminal |
| `POCKETTERM_PASSWORD`  | required for hub   | The hub's password; on Windows prefer `pt set-password` (Credential Manager) over the env var |
| `POCKETTERM_NODE_NAME` | sanitized hostname | This workstation's name in the UI                  |
| `POCKETTERM_SHELL`     | platform default   | Shell each session hosts (default `powershell.exe` on Windows, `$SHELL`/`bash` elsewhere) |

### The `pt` command

```
pt [label] [--cwd DIR] [-- COMMAND ...]       host a session in this terminal
pt launcher                                   the logon-task resident (sessions from the hub)
pt set-password                               store the hub password in Credential Manager
```

Everything after `--` is the command to run, taken verbatim — so
`pt work -- claude --dangerously-skip-permissions` needs no quoting.

`pt` turns the terminal it runs in into a PocketTerminal session: the shell
runs on a pty owned by that process, the hub sees it immediately, and keys go
straight to the shell.

## Security notes

`POCKETTERM_PASSWORD` is the single secret: it signs browsers in (Basic auth,
username fixed to `pocketterm`) and registers workstation sessions and
launchers, and anyone holding it gets a shell on every workstation — make it
long and random. The hub itself speaks plain HTTP, and Basic auth resends the
password with every request, which is why TLS termination in front is
mandatory, especially if hosting over the Internet.
The hub listens on loopback by default: open it with `HOST=0.0.0.0`, paired with
a TLS reverse proxy.

**Planned:** GitHub interactive OAuth (device flow) as an alternative to the
master password — browsers and workstations authenticating with a
GitHub identity instead of the shared secret.

Failed attempts trip a brute-force lockout keyed on client IP.
Set `POCKETTERM_TRUST_PROXY=1` so it keys on the client IP
the proxy — reverse proxy or `tailscale serve` — appends to `X-Forwarded-For`
(only when that proxy is the sole way in — otherwise attackers forge the
header and dodge the lockout).

Isolation of the password from the spawned sessions is best-effort and not
hardened at the moment, but there is room for improvement.

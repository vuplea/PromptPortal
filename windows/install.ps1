#Requires -Version 5.1
<#
.SYNOPSIS
  Install PocketTerminal on this Windows workstation: build the native
  pt.exe, persist its configuration, register the launcher to run at logon,
  and wire up Windows Terminal + the `pt` command. With -InstallHub, also
  build hub.exe and register the hub itself as a background logon task, so
  this machine serves the UI and brokers browsers to workstations.

.DESCRIPTION
  After this runs, `pt` in any terminal hosts a session that is also
  reachable from your hub, and sessions started from the hub open as terminal
  windows here. A session lives exactly as long as its window: closing it
  ends the session everywhere. Re-run any time to change settings or rebuild;
  it is idempotent (at the password prompts, Enter keeps what is stored).

  Each piece is a single self-contained executable built from this repo:
  windows\dist\pt.exe, plus windows\dist\hub.exe (static assets embedded)
  with -InstallHub. Bun (>= 1.3.14, bun.sh) is the only build prerequisite.

.EXAMPLE
  .\install.ps1 -HubUrl https://pocketterminal.example.com -NodeName laptop
  # prompts for the workstation password (hidden); -Password '...' skips the prompt
  # for scripted installs, at the cost of the password landing in shell
  # history and the process command line

.EXAMPLE
  .\install.ps1 -InstallHub
  # hosts the hub here too: builds windows\dist\hub.exe, stores both hub
  # passwords in Credential Manager, registers the 'PocketTerminalHub' logon
  # task, and points this workstation at http://127.0.0.1:8080. The hub
  # listens on loopback; front it with TLS (e.g. tailscale serve) to reach
  # it from other machines.
#>
param(
  [string]$HubUrl,
  [string]$Password,
  [string]$NodeName = ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9_.-]', '-'),
  [switch]$InstallHub,
  [ValidateRange(1, 65535)][int]$HubPort = 8080,
  [string]$WebAccessPassword
)

$ErrorActionPreference = 'Stop'
# Mirrors the node-name rule pt itself enforces (pt/config.ts) — a conscious
# one-line duplication, since PowerShell cannot import it: failing here beats
# a launcher that dies at logon with the error visible only by hand-running it.
if ($NodeName -notmatch '^[A-Za-z0-9_.-]{1,64}$') {
  throw "Invalid -NodeName '$NodeName' (allowed: letters, digits, _ . - ; max 64 chars)"
}
if (-not $HubUrl) {
  if (-not $InstallHub) { throw '-HubUrl is required (or pass -InstallHub to host the hub on this machine)' }
  $HubUrl = "http://127.0.0.1:$HubPort"
}
if ($WebAccessPassword -and -not $InstallHub) {
  throw '-WebAccessPassword configures the hub; it needs -InstallHub'
}
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$dist = "$PSScriptRoot\dist"
$launcherTask = 'PocketTerminalLauncher'
$hubTask = 'PocketTerminalHub'
$null = (Get-Command bun -ErrorAction Stop).Source
# Bun.spawn's `terminal` option (the pty every session runs in) needs 1.3.14.
# Prerelease suffixes (1.3.16-canary.…) are not [version]-castable; strip them.
$bunVersion = [version]((bun --version) -replace '[-+].*$', '')
if ($bunVersion -lt [version]'1.3.14') {
  throw "Bun $bunVersion is too old; pt needs >= 1.3.14 (bun upgrade)"
}

Write-Host "Repo:      $repo"
Write-Host "Node name: $NodeName"
Write-Host "Hub:       $HubUrl$(if ($InstallHub) { ' (installed here)' })"

# --- Helpers -------------------------------------------------------------------

# Compile one self-contained executable to its staging name ($Name-new.exe).
# Staging first: a failed build must tear nothing down.
function New-StagedExecutable([string]$EntryPoint, [string]$Name) {
  Write-Host "`nBuilding $Name.exe..."
  bun build --compile $EntryPoint --outfile "$dist\$Name-new.exe"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$dist\$Name-new.exe")) {
    throw "Build failed; see output above."
  }
}

# Swap a staged build in. Whatever runs the old binary stops only now, once a
# good one exists — it must stop then, since Windows locks a running image
# against overwrite. Stopping the scheduled task is not enough: it terminates
# the conhost it started, which can orphan the child — and a process started
# by hand has no task at all.
function Install-StagedExecutable([string]$Name, [string]$TaskName, [string]$StopNote) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $running = @(Get-Process $Name -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$dist\$Name.exe" })
  if ($running) {
    Write-Host "Stopping running $Name processes$StopNote..."
    $running | Stop-Process -Force
    $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
  }
  # Swap the new binary in via rename-aside: Move-Item -Force does not reliably
  # replace an existing file, and a straggler process would hold the exe locked
  # against deletion anyway — but Windows always allows renaming a running
  # image. Old copies are cleaned up best-effort (next run retries).
  Get-ChildItem "$dist\$Name-old-*.exe" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  if (Test-Path "$dist\$Name.exe") { Move-Item "$dist\$Name.exe" "$dist\$Name-old-$PID.exe" }
  Move-Item "$dist\$Name-new.exe" "$dist\$Name.exe"
  Remove-Item "$dist\$Name-old-$PID.exe" -Force -ErrorAction SilentlyContinue
  Write-Host "Built $dist\$Name.exe"
}

# Register a resident process to run at logon, windowless. conhost --headless
# hosts it in an invisible console: no window exists at any point. (A
# `powershell -WindowStyle Hidden` wrapper would still flash a console at
# logon before hiding it.) It inherits the user env vars this script sets.
# Scoped to this user: it starts at (and runs as) your logon, and a
# user-scoped trigger registers without elevation. ExecutionTimeLimit PT0S
# disables Task Scheduler's default 72-hour limit, which would otherwise kill
# the process after three days.
function Register-HeadlessLogonTask([string]$TaskName, [string]$CommandLine, [string]$Description) {
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
    -Argument "--headless $CommandLine" `
    -WorkingDirectory $dist
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 `
    -ExecutionTimeLimit (New-TimeSpan)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Force -Description $Description | Out-Null
  Write-Host "Registered scheduled task '$TaskName' (runs at logon)."
}

# A hidden prompt that keeps the secret out of shell history and this
# process's command line.
function Read-Secret([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# Pipe lines into a set-password command. The pipe must carry UTF-8: Windows
# PowerShell's default pipeline encoding for native commands is ASCII, which
# would corrupt non-ASCII passwords.
function Invoke-Utf8Pipe([string[]]$Lines, [string]$Exe, [string[]]$ExeArgs) {
  $prevEncoding = $OutputEncoding
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  try { $Lines | & $Exe @ExeArgs } finally { $OutputEncoding = $prevEncoding }
}

# --- Build the executables (to staging names) ----------------------------------
# Builds and password entry both come before anything stops or swaps, so a
# failed build or a cancelled prompt leaves the machine exactly as it was.
if ($InstallHub) {
  # server.ts embeds the @xterm assets out of node_modules, which a fresh
  # clone does not have (bun build does not install; pt.exe needs no packages).
  bun install --frozen-lockfile --cwd $repo
  if ($LASTEXITCODE -ne 0) { throw 'bun install failed; see output above.' }
  New-StagedExecutable "$repo\server.ts" 'hub'
}
New-StagedExecutable "$repo\pt\main.ts" 'pt'

# --- Install the hub -----------------------------------------------------------
# The hub must be serving before the workstation half below, whose
# set-password verifies the workstation password against it.
if ($InstallHub) {
  # Both hub secrets go to Credential Manager. Prompted here rather than by
  # hub.exe so the workstation password is asked for once and reused for the
  # workstation registration below — and stored through the staged binary, so
  # bad input aborts while the old hub still runs untouched.
  if (-not $WebAccessPassword) {
    $WebAccessPassword = Read-Secret 'Web-access password (browsers sign in with it; Enter keeps one stored before)'
  }
  if (-not $Password) {
    $Password = Read-Secret 'Workstation password (workstations register with it; Enter keeps one stored before)'
  }
  Write-Host 'Storing the hub passwords in Credential Manager...'
  Invoke-Utf8Pipe @($WebAccessPassword, $Password) "$dist\hub-new.exe" @('set-password')
  if ($LASTEXITCODE -ne 0) { throw 'Failed to store the hub passwords; see output above.' }

  Install-StagedExecutable 'hub' $hubTask ''

  # Profiles and quick commands persist here (the compose deployment's
  # hub-data volume, as a directory). A scheduled task has no per-process
  # environment channel, so the settings ride the command line — including
  # --host, so a stray user-level HOST variable can never flip this headless
  # plain-HTTP hub onto the network.
  $hubData = "$env:LOCALAPPDATA\PocketTerminal\hub-data"
  New-Item -ItemType Directory -Force -Path $hubData | Out-Null
  $hubCommand = "`"$dist\hub.exe`" --host 127.0.0.1 --port $HubPort --data `"$hubData`""
  Register-HeadlessLogonTask $hubTask $hubCommand 'PocketTerminal hub'

  Start-ScheduledTask -TaskName $hubTask
  # The task runs the hub headless, so a startup error would die invisibly;
  # prove it answers HTTP before the workstation half depends on it. Any
  # status counts — an unauthenticated request earns a 401 from a healthy hub.
  $deadline = (Get-Date).AddSeconds(15)
  $hubUp = $false
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$HubPort/" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $hubUp = $true; break
    } catch {
      if ($_.Exception.Response) { $hubUp = $true; break }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $hubUp) {
    throw "The hub did not come up. Run $hubCommand in a terminal to see the error."
  }
  Write-Host "The hub is up on http://127.0.0.1:$HubPort."
} elseif (Get-ScheduledTask -TaskName $hubTask -ErrorAction SilentlyContinue) {
  Write-Warning ("a '$hubTask' task from an earlier -InstallHub run is still registered and keeps serving at logon; " +
    "remove it with: Unregister-ScheduledTask '$hubTask' -Confirm:`$false")
}

Install-StagedExecutable 'pt' $launcherTask ' (open sessions end with them)'

# --- Persist configuration ------------------------------------------------------
# Non-secret settings go to user environment variables; the scheduled tasks and
# any shell you open inherit them.
Write-Host "`nSetting user environment variables..."
[Environment]::SetEnvironmentVariable('POCKETTERM_HUB_URL',   $HubUrl,   'User')
[Environment]::SetEnvironmentVariable('POCKETTERM_NODE_NAME', $NodeName, 'User')

# The password goes to Windows Credential Manager instead of a user environment
# variable, which would sit in the registry and be inherited by every process
# in the session. set-password verifies it against the hub before storing — a
# mistyped password fails right here instead of leaving a launcher that
# silently redials forever. The user env var persisted above is not part of
# this process's environment yet, so hand the URL over explicitly.
Write-Host "Storing the workstation password in Credential Manager..."
$env:POCKETTERM_HUB_URL = $HubUrl
if ($Password -or $InstallHub) {
  # With -InstallHub the password was already prompted for above (an empty
  # entry pipes through as "keep the stored one") — never ask twice.
  Invoke-Utf8Pipe @($Password) "$dist\pt.exe" @('set-password')
} else {
  # No -Password given: let pt prompt for it hidden.
  & "$dist\pt.exe" set-password
}
if ($LASTEXITCODE -ne 0) { throw "Failed to store the password; see output above." }

# Put dist\ on the user PATH so `pt` resolves everywhere. Split on ';' and
# compare whole entries: -like would treat $dist as a wildcard and match it as
# a substring of an unrelated entry, and concatenating onto an empty PATH would
# prepend a stray separator. Read and write through the registry directly:
# [Environment]::GetEnvironmentVariable expands %VAR% entries on read and
# SetEnvironmentVariable writes plain REG_SZ, so a round-trip through them
# would freeze every REG_EXPAND_SZ entry at its current expansion.
$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
  $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $entries = @($userPath -split ';' | Where-Object { $_ -ne '' })
  if ($entries -notcontains $dist) {
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($envKey.GetValueNames() -contains 'Path') { $kind = $envKey.GetValueKind('Path') }
    $envKey.SetValue('Path', (($entries + $dist) -join ';'), $kind)
    # A raw registry write skips the WM_SETTINGCHANGE broadcast that
    # SetEnvironmentVariable would send; without it, shells opened before the
    # next logon would never see the new PATH.
    Add-Type -Namespace Win32 -Name Env -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
    [UIntPtr]$broadcastResult = [UIntPtr]::Zero
    [void][Win32.Env]::SendMessageTimeoutW([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$broadcastResult)
    Write-Host "Added $dist to user PATH (restart shells to pick up `pt`)."
  }
} finally {
  $envKey.Close()
}

# --- Register the launcher to run at logon (windowless) -----------------------
# The launcher is the workstation's one resident process: it exists so
# sessions can be started from the hub (each opens as a terminal window
# here).
Register-HeadlessLogonTask $launcherTask "`"$dist\pt.exe`" launcher" 'PocketTerminal workstation launcher'

# --- Install the Windows Terminal fragment ------------------------------------
# Adds a "PocketTerminal" profile that opens a new hub-connected session
# (it just runs `pt`).
$fragDir = "$env:LOCALAPPDATA\Microsoft\Windows Terminal\Fragments\PocketTerminal"
New-Item -ItemType Directory -Force -Path $fragDir | Out-Null
# -Encoding UTF8 explicitly: the template holds an em-dash and an emoji icon,
# and Windows PowerShell 5.1 reads ANSI by default, which would mangle both.
$fragment = (Get-Content "$PSScriptRoot\windows-terminal-fragment.template.json" -Raw -Encoding UTF8).
  Replace('__PT__', ("$dist\pt.exe" -replace '\\', '\\'))
Set-Content -Path "$fragDir\pocketterminal.json" -Value $fragment -Encoding UTF8
Write-Host "Installed Windows Terminal fragment (new 'PocketTerminal' profile)."

# --- (Re)start it --------------------------------------------------------------
# Stop first so a re-run picks up the freshly built executable.
Stop-ScheduledTask -TaskName $launcherTask -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $launcherTask

# The task runs the launcher headless, so a startup error (bad config) would
# die invisibly; prove it came up and stayed up before declaring success. The
# password and hub URL were already proven against the hub by set-password
# above, so a launcher that holds is a launcher that registers.
$deadline = (Get-Date).AddSeconds(15)
$up = $false
while ((Get-Date) -lt $deadline) {
  $proc = Get-Process pt -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$dist\pt.exe" } | Select-Object -First 1
  if ($proc) {
    Start-Sleep -Seconds 2   # a config error exits within moments of starting
    if (-not $proc.HasExited) { $up = $true; break }
  }
  Start-Sleep -Milliseconds 500
}
if (-not $up) {
  throw "The launcher did not come up. Run `"$dist\pt.exe`" launcher in a terminal to see the error."
}
Write-Host "`nDone. The launcher is running. Host a session from any terminal with:  pt"
Write-Host "In Windows Terminal, the 'PocketTerminal' profile opens a connected session."
Write-Host "Closing a session's window ends that session everywhere."
if ($InstallHub) {
  Write-Host "The hub is serving on http://127.0.0.1:$HubPort (task '$hubTask', data in $env:LOCALAPPDATA\PocketTerminal\hub-data)."
  Write-Host "It speaks plain HTTP on loopback; to reach it from other machines put TLS in"
  Write-Host "front (e.g. tailscale serve --bg $HubPort) and use that URL from browsers and workstations."
}

#Requires -Version 5.1
<#
.SYNOPSIS
  Install PocketTerminal on this Windows workstation: build the native
  pt.exe, persist its configuration, register the launcher to run at logon,
  and wire up Windows Terminal + the `pt` command.

.DESCRIPTION
  After this runs, `pt` in any terminal hosts a session that is also
  reachable from your hub, and sessions started from the hub open as terminal
  windows here. A session lives exactly as long as its window: closing it
  ends the session everywhere. Re-run any time to change settings or rebuild;
  it is idempotent.

  Everything is a single self-contained executable (windows\dist\pt.exe)
  built from ..\pt; Bun (>= 1.3.14, bun.sh) is the only build prerequisite.

.EXAMPLE
  .\install.ps1 -HubUrl https://pocketterminal.example.com -NodeName laptop
  # prompts for the workstation password (hidden); -Password '...' skips the prompt
  # for scripted installs, at the cost of the password landing in shell
  # history and the process command line
#>
param(
  [Parameter(Mandatory = $true)][string]$HubUrl,
  [string]$Password,
  [string]$NodeName = ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9_.-]', '-')
)

$ErrorActionPreference = 'Stop'
# Mirrors the node-name rule pt itself enforces (pt/config.ts) — a conscious
# one-line duplication, since PowerShell cannot import it: failing here beats
# a launcher that dies at logon with the error visible only by hand-running it.
if ($NodeName -notmatch '^[A-Za-z0-9_.-]{1,64}$') {
  throw "Invalid -NodeName '$NodeName' (allowed: letters, digits, _ . - ; max 64 chars)"
}
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$dist = "$PSScriptRoot\dist"
$null = (Get-Command bun -ErrorAction Stop).Source
# Bun.spawn's `terminal` option (the pty every session runs in) needs 1.3.14.
# Prerelease suffixes (1.3.16-canary.…) are not [version]-castable; strip them.
$bunVersion = [version]((bun --version) -replace '[-+].*$', '')
if ($bunVersion -lt [version]'1.3.14') {
  throw "Bun $bunVersion is too old; pt needs >= 1.3.14 (bun upgrade)"
}

Write-Host "Repo:      $repo"
Write-Host "Node name: $NodeName"

# --- Build the executable ------------------------------------------------------
# Build to a staging name first: a failed build must tear nothing down. The
# running launcher and session hosts stop only once a good binary exists —
# they must stop then, since Windows locks a running image against overwrite.
Write-Host "`nBuilding pt.exe..."
bun build --compile "$repo\pt\main.ts" --outfile "$dist\pt-new.exe"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$dist\pt-new.exe")) {
  throw "Build failed; see output above."
}

# Stop everything running $dist\pt.exe — the launcher and any session hosts.
# Stopping the scheduled task is not enough: it terminates the conhost it
# started, which can orphan the pt.exe child — and a launcher started by hand
# has no task at all.
$taskName = 'PocketTerminalLauncher'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$running = @(Get-Process pt -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$dist\pt.exe" })
if ($running) {
  Write-Host "Stopping running pt processes (open sessions end with them)..."
  $running | Stop-Process -Force
  $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
}
# Swap the new binary in via rename-aside: Move-Item -Force does not reliably
# replace an existing file, and a straggler process would hold pt.exe locked
# against deletion anyway — but Windows always allows renaming a running
# image. Old copies are cleaned up best-effort (next run retries).
Get-ChildItem "$dist\pt-old-*.exe" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
if (Test-Path "$dist\pt.exe") { Move-Item "$dist\pt.exe" "$dist\pt-old-$PID.exe" }
Move-Item "$dist\pt-new.exe" "$dist\pt.exe"
Remove-Item "$dist\pt-old-$PID.exe" -Force -ErrorAction SilentlyContinue
Write-Host "Built $dist\pt.exe"

# --- Persist configuration ------------------------------------------------------
# Non-secret settings go to user environment variables; the scheduled task and
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
if ($Password) {
  # The pipe must carry UTF-8: Windows PowerShell's default pipeline encoding
  # for native commands is ASCII, which would corrupt non-ASCII passwords.
  $prevEncoding = $OutputEncoding
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  try {
    $Password | & "$dist\pt.exe" set-password
  } finally {
    $OutputEncoding = $prevEncoding
  }
} else {
  # No -Password given: let pt prompt for it hidden, keeping the secret out of
  # shell history and this process's command line.
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
# The launcher is the one resident process: it exists so sessions can be
# started from the hub (each opens as a terminal window here). conhost
# --headless hosts it in an invisible console: no window exists at any point.
# (A `powershell -WindowStyle Hidden` wrapper would still flash a console at
# logon before hiding it.) It inherits the user env vars set above.
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
  -Argument "--headless `"$dist\pt.exe`" launcher" `
  -WorkingDirectory $dist
# Scoped to this user: the launcher starts at (and runs as) your logon, and a
# user-scoped trigger registers without elevation.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# ExecutionTimeLimit PT0S disables Task Scheduler's default 72-hour limit,
# which would otherwise kill the launcher after three days (sessions are
# their own processes and would survive, but the hub could no longer start
# new ones).
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3 `
  -ExecutionTimeLimit (New-TimeSpan)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Force -Description 'PocketTerminal workstation launcher' | Out-Null
Write-Host "Registered scheduled task '$taskName' (runs at logon)."

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
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $taskName

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

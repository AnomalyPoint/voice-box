<#
.SYNOPSIS
    Plays an audio file to completion, then exits.

.DESCRIPTION
    Voice Box spawns this script as its Windows audio backend. It is a file
    rather than an inline -Command string because quoting a one-liner through
    cmd and PowerShell is a reliable source of breakage, and because a script
    in the repo can actually be reviewed.

    The contract the caller depends on: the process stays alive for exactly as
    long as audio is playing, and exits 0 when playback finishes normally.
    That lets the parent treat process exit as "playback complete" and treat
    taskkill as "stop now", with no IPC.

    Exit codes:
      0  played to completion
      2  file not found
      3  media could not be opened or has no known duration
#>
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [double]$Volume = 1.0
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
    [Console]::Error.WriteLine("voice-box: file not found: $Path")
    exit 2
}

$resolved = (Resolve-Path -LiteralPath $Path).Path

try {
    Add-Type -AssemblyName presentationCore
} catch {
    [Console]::Error.WriteLine("voice-box: could not load presentationCore: $($_.Exception.Message)")
    exit 3
}

$player = New-Object System.Windows.Media.MediaPlayer

try {
    $clamped = [Math]::Min([Math]::Max($Volume, 0.0), 1.0)
    $player.Volume = $clamped
    $player.Open([Uri]::new($resolved))

    # Open() is asynchronous; NaturalDuration is only populated once the media
    # has been buffered, so poll for it rather than assuming it is ready.
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not $player.NaturalDuration.HasTimeSpan -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 20
    }

    if (-not $player.NaturalDuration.HasTimeSpan) {
        [Console]::Error.WriteLine("voice-box: could not determine duration of $resolved")
        exit 3
    }

    $duration = $player.NaturalDuration.TimeSpan
    $player.Play()

    # Small tail margin so the final samples are not clipped by an early exit.
    $end = [DateTime]::UtcNow.Add($duration).AddMilliseconds(250)
    while ([DateTime]::UtcNow -lt $end) {
        Start-Sleep -Milliseconds 40
    }

    exit 0
} catch {
    [Console]::Error.WriteLine("voice-box: playback failed: $($_.Exception.Message)")
    exit 3
} finally {
    try { $player.Stop() } catch { }
    try { $player.Close() } catch { }
}

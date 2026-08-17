# hexscribe launcher.
#
#   .\hexscribe.ps1 recording.m4a --lang de --format srt --out out\recording.srt
#   .\hexscribe.ps1 --doctor
#   .\hexscribe.ps1 serve --port 9000 [--host 0.0.0.0] [--api-key KEY]
#
# Use this instead of `npm start -- <args>`: PowerShell's npm.ps1 shim splats its
# arguments through $args, which drops the `--` separator, so options never reach
# the app. Invoking the loader directly avoids the shim entirely.

# Deliberately NOT 'Stop': hexscribe writes progress and timings to stderr, and
# with ErrorActionPreference=Stop PowerShell turns a native command's stderr into
# a terminating error -- a successful run would abort the script.
$ErrorActionPreference = 'Continue'
Push-Location $PSScriptRoot
try {
    if ($args.Count -gt 0 -and $args[0] -eq 'serve') {
        # The server is the same composition with a different front-end enabled;
        # scripts/serve.mjs sets the environment cordis.yml gates on.
        $rest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
        & node --import tsx (Join-Path $PSScriptRoot 'scripts/serve.mjs') @rest
    } else {
        & node --import tsx (Join-Path $PSScriptRoot 'node_modules/@deepseek-ai/cordis/bin.js') @args
    }
    exit $LASTEXITCODE
} finally {
    Pop-Location
}

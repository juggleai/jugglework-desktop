# Builds the fixture-only semantic overlay PoC. It is never copied into product resources by default.
param(
    [Parameter(Mandatory = $true)] [string] $OutDir,
    [ValidateSet('x64')] [string] $Architecture = 'x64'
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows build host required' }
if (-not (Test-Path -LiteralPath (Split-Path -Parent $OutDir) -PathType Container)) { throw 'Output parent directory missing' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'x64 .NET Framework C# compiler not found' }
$source = Join-Path $PSScriptRoot '..\native\MeetingSemanticOverlayWindows.cs'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Semantic overlay source missing' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$output = Join-Path $OutDir 'MeetingSemanticOverlayWindows.exe'
& $compiler /nologo /optimize+ /target:exe /platform:x64 /r:System.Web.Extensions.dll "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw 'Windows semantic overlay PoC build failed' }
Write-Output $output

# Experimental helper, built separately until Windows native validation.
param(
    [string] $OutDir = (Join-Path $PSScriptRoot '..\resources\helpers'),
    [ValidateSet('x64', 'arm64')] [string] $Architecture = 'x64',
    [switch] $FixtureNoSendChanging
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows build host required' }
# .NET Framework compiler does not provide an ARM64 native target. Do not mislabel an x64 PE.
if ($Architecture -ne 'x64') { throw 'ARM64 compiler path has not been validated; build refused' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'x64 .NET Framework C# compiler not found' }
$source = Join-Path $PSScriptRoot '..\native\MeetingWindowIdentityWindows.cs'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Native inspector source missing' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$options = @()
$name = 'MeetingWindowIdentityWindows.exe'
if ($FixtureNoSendChanging) {
    if (!$PSBoundParameters.ContainsKey('OutDir')) { throw 'Fixture build requires an explicit output directory' }
    $name = 'MeetingWindowIdentityWindows.FixtureNoSendChanging.exe'
    $options += '/define:FIXTURE_NO_SEND_CHANGING'
}
$output = Join-Path $OutDir $name
& $compiler /nologo /optimize+ /target:exe /platform:x64 @options "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw 'Windows native inspector build failed' }
Write-Output 'Experimental inspector/placement helper built; not signed or enabled in the product.'

# SPDX-License-Identifier: GPL-3.0-only
#requires -Version 7.0
param([string] $Msys2Root = 'C:\msys64')

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$cache = Join-Path $repo '.build/windows'
$codec = Join-Path $cache 'codec'
$dist = Join-Path $repo 'dist'
$desktop = Join-Path $repo 'desktop/windows'
$nodeVersion = '22.23.4'
$webViewVersion = '1.0.4314.35'
$nodeName = "node-v$nodeVersion-win-x64"
$packageName = 'ShortDramaPlayer-win-x64'
$archive = Join-Path $dist "$packageName.zip"
$null = New-Item -ItemType Directory -Force -Path $cache, $codec, $dist

function Get-VerifiedAsset([string] $Path, [string] $Uri, [string] $Sha256) {
    if ((Test-Path -LiteralPath $Path) -and (Get-FileHash -LiteralPath $Path).Hash -eq $Sha256) {
        return
    }
    $download = "$Path.$([guid]::NewGuid().ToString('N')).download"
    try {
        Invoke-WebRequest -Uri $Uri -OutFile $download -TimeoutSec 120
        if ((Get-FileHash -LiteralPath $download).Hash -ne $Sha256) {
            throw "下载文件的 SHA-256 不匹配。$Uri"
        }
        Move-Item -LiteralPath $download -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }
    }
}

function Invoke-Checked([string] $Program, [string[]] $Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "命令失败，退出码 $LASTEXITCODE。$Program" }
}

$nodeZip = Join-Path $cache "$nodeName.zip"
Get-VerifiedAsset $nodeZip "https://nodejs.org/dist/v$nodeVersion/$nodeName.zip" 'CBC74B5E0982C9DBB41525FD8FB5DCD32FBEE237863F7829072F4639A1CE5F20'
$node = Join-Path $cache $nodeName
if (!(Test-Path -LiteralPath (Join-Path $node 'node.exe')) -or !(Test-Path -LiteralPath (Join-Path $node 'npm.cmd'))) {
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $cache -Force
}

$sdkZip = Join-Path $cache "webview2-$webViewVersion.zip"
Get-VerifiedAsset $sdkZip "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$webViewVersion/microsoft.web.webview2.$webViewVersion.nupkg" '90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4'
$sdk = Join-Path $cache "webview2-$webViewVersion"
if (!(Test-Path -LiteralPath (Join-Path $sdk 'runtimes/win-x64/native/WebView2Loader.dll'))) {
    Expand-Archive -LiteralPath $sdkZip -DestinationPath $sdk -Force
}

$ffmpegSource = Join-Path $codec 'ffmpeg.tar.gz'
$x264Source = Join-Path $codec 'x264.tar.gz'
Get-VerifiedAsset $ffmpegSource 'https://codeload.github.com/jellyfin/jellyfin-ffmpeg/tar.gz/f6e945886e17c2cf882143bd98222b1bd66ffe28' '05ED62F673AB735CF798870CD3EB31F3588286194FA4F000F2279E21059FD7D1'
Get-VerifiedAsset $x264Source 'https://codeload.github.com/mirror/x264/tar.gz/b35605ace3ddf7c1a5d67a2eb553f034aef41d55' 'CD71A7515B0E9A012E1AC9B1F8415BEBCAF6FC97D4DB32286642AC4C0FBE24F9'

$codecFiles = @('ffmpeg.exe', 'FFmpeg-LICENSE.txt', 'x264-LICENSE.txt')
$missingCodec = $codecFiles | Where-Object { !(Test-Path -LiteralPath (Join-Path $codec $_)) }
$codecStamp = Join-Path $codec 'build-inputs.txt'
$codecInputs = (Get-FileHash -LiteralPath $ffmpegSource, $x264Source, (Join-Path $repo 'vendor/bytevc2/0001-add-bvc2-decoder.patch'), (Join-Path $PSScriptRoot 'build-bytevc2-windows.sh')).Hash -join ':'
if ($missingCodec -or !(Test-Path -LiteralPath $codecStamp) -or (Get-Content -LiteralPath $codecStamp -Raw).Trim() -ne $codecInputs) {
    $bash = Join-Path $Msys2Root 'usr/bin/bash.exe'
    if (!(Test-Path -LiteralPath $bash)) { throw '构建解码器需要 MSYS2 UCRT64，请通过 -Msys2Root 指定安装目录。' }
    Get-VerifiedAsset (Join-Path $codec 'pkgconf.tar.zst') 'https://repo.msys2.org/msys/x86_64/pkgconf-3.0.9-1-x86_64.pkg.tar.zst' '4A19D76AE6104CA0EC3876036DAB2986CAF516EB8FB9261E46CBEE9F08934F01'
    $originalPath = $env:Path
    $originalMsysSystem = $env:MSYSTEM
    Push-Location -LiteralPath $repo
    try {
        $env:MSYSTEM = 'UCRT64'
        $env:Path = "$(Join-Path $Msys2Root 'ucrt64/bin');$(Join-Path $Msys2Root 'usr/bin');$originalPath"
        Invoke-Checked $bash @('--noprofile', '--norc', './scripts/build-bytevc2-windows.sh', './.build/windows/codec')
        Set-Content -LiteralPath $codecStamp -Value $codecInputs -Encoding ascii
    }
    finally {
        $env:Path = $originalPath
        $env:MSYSTEM = $originalMsysSystem
        Pop-Location
    }
}
$decoders = & (Join-Path $codec 'ffmpeg.exe') -hide_banner -decoders
if ($LASTEXITCODE -ne 0 -or !($decoders -match ' bvc2 ')) { throw '缓存中的 FFmpeg 无法解码 ByteVC2。' }

$stage = Join-Path $cache "package-$([guid]::NewGuid().ToString('N'))"
$package = Join-Path $stage $packageName
$runtime = Join-Path $package 'runtime'
$player = Join-Path $package 'player'
$source = Join-Path $player 'codec-source'
$null = New-Item -ItemType Directory -Path $stage, $package, $runtime, $player, (Join-Path $source 'scripts')
try {
    & (Join-Path $desktop 'build-host.ps1') -WebView2Sdk $sdk -Output (Join-Path $package '摸鱼侠.exe')
    foreach ($library in 'lib/net462/Microsoft.Web.WebView2.Core.dll', 'lib/net462/Microsoft.Web.WebView2.WinForms.dll', 'runtimes/win-x64/native/WebView2Loader.dll') {
        Copy-Item -LiteralPath (Join-Path $sdk $library) -Destination $package
    }
    Copy-Item -LiteralPath (Join-Path $node 'node.exe') -Destination $runtime
    Copy-Item -LiteralPath (Join-Path $node 'LICENSE') -Destination (Join-Path $runtime 'Node-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $runtime 'WebView2-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $sdk 'NOTICE.txt') -Destination (Join-Path $runtime 'WebView2-NOTICE.txt')
    foreach ($file in $codecFiles) {
        Copy-Item -LiteralPath (Join-Path $codec $file) -Destination $runtime
    }

    foreach ($file in 'package.json', 'package-lock.json', 'LICENSE', 'src', 'desktop') {
        Copy-Item -LiteralPath (Join-Path $repo $file) -Destination $player -Recurse
    }
    $iconFolder = New-Item -ItemType Directory -Path (Join-Path $player 'build')
    Copy-Item -LiteralPath (Join-Path $repo 'build/icon.ico') -Destination $iconFolder.FullName
    Copy-Item -LiteralPath (Join-Path $desktop '使用说明.txt') -Destination $package
    Copy-Item -LiteralPath $ffmpegSource, $x264Source -Destination $source
    Copy-Item -LiteralPath (Join-Path $repo 'vendor') -Destination $source -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-bytevc2-windows.sh') -Destination (Join-Path $source 'scripts')
    Copy-Item -LiteralPath (Join-Path $desktop 'codec-build.txt') -Destination (Join-Path $source 'BUILD.txt')

    Push-Location -LiteralPath $player
    try {
        Invoke-Checked (Join-Path $node 'npm.cmd') @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
    }
    finally {
        Pop-Location
    }

    $tempArchive = Join-Path $stage 'release.zip'
    Compress-Archive -LiteralPath $package -DestinationPath $tempArchive -CompressionLevel Optimal
    Move-Item -LiteralPath $tempArchive -Destination $archive -Force
    Get-Item -LiteralPath $archive
}
finally {
    $stagePath = (Resolve-Path -LiteralPath $stage).Path
    $cachePath = (Resolve-Path -LiteralPath $cache).Path.TrimEnd('\') + '\'
    if ($stagePath.StartsWith($cachePath, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $stagePath -Recurse -Force
    }
}

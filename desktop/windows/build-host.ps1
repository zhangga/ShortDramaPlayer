param(
    [Parameter(Mandatory)] [string] $WebView2Sdk,
    [string] $Output = (Join-Path $PSScriptRoot 'ShortDramaPlayer.exe')
)

$ErrorActionPreference = 'Stop'
$assemblies = Join-Path (Resolve-Path -LiteralPath $WebView2Sdk).Path 'lib\net462'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $PSScriptRoot 'PlayerWindow.cs'
$placement = Join-Path $PSScriptRoot 'TaskbarPlacement.cs'
$framework = Join-Path ${env:ProgramFiles(x86)} 'Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8'
$icon = Join-Path $PSScriptRoot '..\..\build\icon.ico'
$outputFile = [IO.Path]::GetFullPath($Output)
& $compiler /nologo /warnaserror /target:winexe /platform:x64 /optimize+ /codepage:65001 `
    "/out:$outputFile" "/win32icon:$icon" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll `
    "/reference:$framework\UIAutomationClient.dll" "/reference:$framework\UIAutomationTypes.dll" "/reference:$framework\WindowsBase.dll" `
    "/reference:$assemblies\Microsoft.Web.WebView2.Core.dll" `
    "/reference:$assemblies\Microsoft.Web.WebView2.WinForms.dll" $source $placement
if ($LASTEXITCODE -ne 0) { throw '播放器编译失败。' }

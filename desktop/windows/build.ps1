$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $scriptDir "XingqiaoDesktop.csproj"
$output = Join-Path $scriptDir "dist"

dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:DebugType=None -o $output
Write-Host "已生成：$output\XingqiaoDesktop.exe"

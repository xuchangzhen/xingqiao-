#!/bin/zsh
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
output_dir="${1:-"$script_dir/dist"}"
app_bundle="$output_dir/星桥.app"

swift build --package-path "$script_dir" -c release
rm -rf "$app_bundle"
mkdir -p "$app_bundle/Contents/MacOS" "$app_bundle/Contents/Resources"
cp "$script_dir/.build/release/XingqiaoDesktop" "$app_bundle/Contents/MacOS/XingqiaoDesktop"
cp "$script_dir/Info.plist" "$app_bundle/Contents/Info.plist"
cp "$script_dir/xingqiao.icns" "$app_bundle/Contents/Resources/xingqiao.icns"
codesign --force --sign - "$app_bundle"

print "已生成：$app_bundle"

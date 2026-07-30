#!/bin/zsh
# 双击此文件即可在 Mac 上启动星桥，并自动打开浏览器。
cd "$(dirname "$0")"
python3 server.py --open

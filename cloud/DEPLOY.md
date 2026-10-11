# VPS 部署

在 Linux VPS 上检出仓库，例如 `/opt/xingqiao`。DNS 中先创建自己的子域名：

`transfer.example.com  A  你的 VPS 公网 IP`

在 Debian 12 上运行：

```bash
git clone https://github.com/xuchangzhen/xingqiao-.git /opt/xingqiao
cd /opt/xingqiao/cloud
cp .env.example .env
nano .env                 # 填入 DOMAIN、TURN_HOST、TURN_PUBLIC_IP、TURN_SECRET
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

`TURN_PUBLIC_IP` 必须是 VPS 的公网 IPv4；即使 VPS 网卡显示的是云平台私网地址，也要填公网地址。`TURN_HOST` 的 A 记录应指向该地址。coturn 使用 Linux 主机网络，避免 Docker 桥接地址被发布为不可达的 ICE 候选。若 VPS 位于额外 NAT 后面，云平台仍须将 3478 和 49160–49200 端口按原端口映射到该机器。

防火墙和云平台安全组需允许：TCP 80、443、3478，UDP 3478、49160–49200。例如使用 UFW：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49160:49200/udp
```

打开 `https://transfer.example.com` 验证。Caddy 会在 DNS 生效后自动申请 HTTPS 证书。若网络屏蔽 TURN，浏览器会在直连尝试失败后自动通过已有的 HTTPS 443 连接中转文件分片；这条路径会消耗 VPS 入站和出站流量，文件只经内存转发而不落盘。页面会显示所用路径。

部署后可检查中继启动和 ICE 配置：

```bash
docker compose logs --tail=80 turn
curl -fsS https://transfer.example.com/api/config | python3 -c 'import json,sys; print([server["urls"] for server in json.load(sys.stdin)["iceServers"]])'
```

使用两台分别位于 Wi-Fi 和移动数据网络的设备传送文件，观察页面显示的“设备点对点直传”“公网中转传输”或“HTTPS 服务器中转传输”。局域网速率还受 Wi-Fi 空口、协调端网口及设备写入速度限制，软件无法保证等于网卡标称速率。

不要提交 `.env`、域名、VPS IP 或 TURN 密钥。若 VPS 已有 Nginx、Caddy 或其他反向代理，请添加一个新的子域名虚拟主机，避免占用或影响既有网站。已有部署请在原有 Git 检出目录升级，保留原 `.env`。

日志：`docker compose logs -f`；升级时先拉取与桌面端相同的提交，再执行（旧版 Docker 可把 `docker compose` 替换为 `docker-compose`）：

```bash
git pull --ff-only origin main
nano .env                 # 首次升级时补入 TURN_PUBLIC_IP=VPS公网IPv4
docker compose config --quiet
docker compose up -d --build
```

macOS 桌面端每次启动/刷新都会无缓存加载这个网页入口，所以部署完成后会自动使用同一版网页逻辑；只有原生悬浮收件箱有改动时才需要重新构建 `.app`。

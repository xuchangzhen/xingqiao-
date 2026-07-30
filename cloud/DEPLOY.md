# VPS 部署

将整个 `cloud/` 目录上传到 VPS 的任意受限目录，例如 `/opt/xingqiao`。DNS 中先创建自己的子域名：

`transfer.example.com  A  你的 VPS 公网 IP`

在 Debian 12 上运行：

```bash
cd /opt/xingqiao
cp .env.example .env
nano .env                 # 填入自己的 DOMAIN、TURN_HOST、TURN_SECRET
docker compose up -d --build
docker compose ps
```

防火墙需允许：TCP 80、443、3478，UDP 3478、49160–49200。打开 `https://transfer.example.com` 验证。Caddy 会在 DNS 生效后自动申请 HTTPS 证书。

不要提交 `.env`、域名、VPS IP 或 TURN 密钥。若 VPS 已有 Nginx、Caddy 或其他反向代理，请添加一个新的子域名虚拟主机，避免占用或影响既有网站。

日志：`docker compose logs -f`；升级：替换目录文件后执行 `docker compose up -d --build`。

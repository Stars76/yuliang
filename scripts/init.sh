#!/usr/bin/env bash
# quota-dashboard 首次初始化（最后一步）：设置主密码 → 绑定 TOTP → 保存恢复码
# 前提：容器已在运行（sudo docker compose up -d）
set -euo pipefail
cd /home/ckx/quota-dashboard

if ! sudo docker compose ps --status running --services 2>/dev/null | grep -qx quota-dashboard; then
  echo "容器未在运行，请先执行: sudo docker compose up -d" >&2
  exit 1
fi

echo "开始初始化：依次设置主密码（≥16 位）、记录 TOTP secret、保存恢复码（仅显示一次）"
exec sudo docker compose exec quota-dashboard node src/server/cli/index.js init

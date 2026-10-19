#!/usr/bin/env bash
# 主力 IDE 发行门禁：静态检查、单测、假靶机 E2E、完整 deb 构建缺一不可。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "== 1/5 lint =="
npm run lint

echo "== 2/5 typecheck =="
npm run typecheck

echo "== 3/5 unit/integration tests =="
npm test

echo "== 4/5 假靶机 E2E =="
npm run e2e

echo "== 5/5 release deb =="
npm run build:deb

echo "发行门禁通过。"

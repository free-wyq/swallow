#!/usr/bin/env bash
# skill/run.sh —— swallow skill 自带入口：自定位 + 懒加载依赖 + exec 透传参数给 orchestrator.ts
#
# 设计：
# - 自定位：无论从仓库跑还是从某 agent 的 skills/swallow-scheduler/ 跑都能定位自身（BASH_SOURCE）。
# - 懒加载依赖：首次运行把 package.json 装进共享缓存 $SWALLOW_DEPS_DIR（默认 ~/.local/share/swallow/deps），
#   再在 skill 目录内 symlink node_modules → 缓存（ESM 解析 bare 导入靠模块文件所在目录的 node_modules，
#   不是 process.cwd——orchestrator.ts 启动后 process.chdir(--cwd) 不影响 import 解析）。
#   幂等：缓存与 symlink 已在则秒过，不重装。
# - exec：替换为 tsx 进程，参数原样透传；--stop 联动杀子进程依赖 exec 让 SIGTERM 干净传递。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWALLOW_DEPS_DIR="${SWALLOW_DEPS_DIR:-$HOME/.local/share/swallow/deps}"
TSX_BIN="$SWALLOW_DEPS_DIR/node_modules/.bin/tsx"
ORCH="$SCRIPT_DIR/orchestrator.ts"
LOCAL_NM="$SCRIPT_DIR/node_modules"

# 依赖未装（tsx 不在缓存）→ 首次拉取
if [ ! -x "$TSX_BIN" ]; then
  echo " swallow: 首次运行，正在准备依赖（~530MB 装到 $SWALLOW_DEPS_DIR，稍候）..." >&2
  mkdir -p "$SWALLOW_DEPS_DIR"
  cp "$SCRIPT_DIR/package.json" "$SWALLOW_DEPS_DIR/package.json"
  cp "$SCRIPT_DIR/package-lock.json" "$SWALLOW_DEPS_DIR/package-lock.json" 2>/dev/null || true
  npm install --prefix "$SWALLOW_DEPS_DIR" --silent
  echo " swallow: 依赖就绪（已缓存到 $SWALLOW_DEPS_DIR，下次秒起）" >&2
fi

# 在 skill 目录内建 node_modules symlink → 共享缓存，让 orchestrator.ts 的 bare 导入解析到缓存。
# 已存在且指向当前缓存则跳过；指向别处（旧缓存/旧版本）则重建。
ensure_nm_link() {
  if [ -L "$LOCAL_NM" ]; then
    local cur; cur="$(readlink "$LOCAL_NM" 2>/dev/null || true)"
    [ "$cur" = "$SWALLOW_DEPS_DIR/node_modules" ] && return 0
    rm -f "$LOCAL_NM"
  elif [ -e "$LOCAL_NM" ] && [ ! -d "$LOCAL_NM" ]; then
    # 占位文件（非目录非 symlink），移走
    rm -f "$LOCAL_NM"
  fi
  # 真目录且非 symlink：保留用户自装的，不覆盖（幂等不破坏）
  [ -d "$LOCAL_NM" ] && [ ! -L "$LOCAL_NM" ] && return 0
  ln -s "$SWALLOW_DEPS_DIR/node_modules" "$LOCAL_NM"
}
ensure_nm_link

exec "$TSX_BIN" "$ORCH" "$@"

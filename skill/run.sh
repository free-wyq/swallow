#!/usr/bin/env bash
# skill/run.sh —— swallow skill 自带入口：自定位 + 懒加载依赖 + exec 透传参数给 orchestrator.ts
#
# 这是 swallow 的唯一执行入口——agent 注册 skill 后直接跑本脚本，不依赖 PATH 里的 swallow 命令：
#   bash <skill目录>/run.sh --cwd <项目> "目标"
# （人想敲短命令 swallow，install.sh 会装个 PATH wrapper 指向这里，但 agent 不靠它。）
#
# 设计：
# - 自定位：无论从仓库跑还是从某 agent 的 skills/swallow-scheduler/ 跑都能定位自身（BASH_SOURCE）。
# - 懒加载依赖：首次运行把 package.json 装进共享缓存 $SWALLOW_DEPS_DIR（默认 ~/.local/share/swallow/deps），
#   再让 orchestrator.ts 的 bare 导入解析到缓存（见下方 resolve_deps_link）。
#   幂等：缓存已在则秒过，不重装。多个 skill 拷贝共享同一缓存（不绑死代码树路径）。
# - exec：替换为 tsx 进程，参数原样透传；--stop 联动杀子进程依赖 exec 让 SIGTERM 干净传递。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWALLOW_DEPS_DIR="${SWALLOW_DEPS_DIR:-$HOME/.local/share/swallow/deps}"
TSX_BIN="$SWALLOW_DEPS_DIR/node_modules/.bin/tsx"
ORCH="$SCRIPT_DIR/orchestrator.ts"
LOCAL_NM="$SCRIPT_DIR/node_modules"

# ---- 前置自检：缺关键前提就给清晰提示，别让 agent 撞到莫名其妙的错 ----
# Node 18+（orchestrator.ts 跑不起来没它不行）
if ! command -v node >/dev/null 2>&1; then
  echo " swallow: 未检测到 Node。请先装 Node 18+（https://nodejs.org）。" >&2
  exit 1
fi
_node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$_node_major" -lt 18 ]; then
  echo " swallow: Node 版本过低（$(node -v)，需 18+），请升级后重跑。" >&2
  exit 1
fi
# orchestrator.ts 在不在（skill 目录拷残了/注册没拷全）
if [ ! -f "$ORCH" ]; then
  echo " swallow: 找不到 orchestrator.ts（$ORCH）。skill 目录不完整，重新 cp -r 注册 skill。" >&2
  exit 1
fi
# 密钥配置在不在（没有也放行——可能用户用已 export 的环境变量，只提醒）
_env_file="${SWALLOW_ENV_FILE:-$HOME/.config/swallow/swallow.env}"
if [ ! -f "$_env_file" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo " swallow: 提示——未找到 $_env_file 且环境无 ANTHROPIC_API_KEY。首次跑会因鉴权失败；" >&2
  echo "         把密钥写进 $_env_file（chmod 600），或 export ANTHROPIC_API_KEY=sk-... 后重跑。" >&2
fi

# ---- 依赖未装（tsx 不在缓存）→ 首次拉取 ----
if [ ! -x "$TSX_BIN" ]; then
  echo " swallow: 首次运行，正在准备依赖（~530MB 装到 $SWALLOW_DEPS_DIR，稍候）..." >&2
  mkdir -p "$SWALLOW_DEPS_DIR"
  cp "$SCRIPT_DIR/package.json" "$SWALLOW_DEPS_DIR/package.json"
  cp "$SCRIPT_DIR/package-lock.json" "$SWALLOW_DEPS_DIR/package-lock.json" 2>/dev/null || true
  if ! npm install --prefix "$SWALLOW_DEPS_DIR" --silent; then
    echo " swallow: 依赖安装失败。清理半成品缓存后重试：rm -rf $SWALLOW_DEPS_DIR" >&2
    exit 1
  fi
  echo " swallow: 依赖就绪（已缓存到 $SWALLOW_DEPS_DIR，下次秒起）" >&2
fi

# ---- 让 orchestrator.ts 的 bare 导入解析到 deps 缓存 ----
# ESM 的 import "@anthropic-ai/..." 靠「模块文件所在目录的 node_modules」向上查找，不是 process.cwd，
# 也不是 NODE_PATH（NODE_PATH 仅对 CJS 生效，ESM 报 ERR_MODULE_NOT_FOUND——实测）。
# 首选：在 skill 目录内建 node_modules symlink → 缓存（0 空间，缓存更新自动生效）。
# Fallback：skill 目录只读建不了 symlink 时，cd 进 skill 目录跑 tsx（orchestrator.ts 启动后会
#   process.chdir(--cwd)，但 import 解析在 chdir 前已完成，不受影响）。
resolve_deps_link() {
  if [ -L "$LOCAL_NM" ]; then
    local cur; cur="$(readlink "$LOCAL_NM" 2>/dev/null || true)"
    [ "$cur" = "$SWALLOW_DEPS_DIR/node_modules" ] && return 0
    rm -f "$LOCAL_NM" || return 1
  elif [ -e "$LOCAL_NM" ] && [ ! -d "$LOCAL_NM" ]; then
    rm -f "$LOCAL_NM" || return 1
  fi
  # 真目录且非 symlink：保留用户自装的，不覆盖（幂等不破坏）
  [ -d "$LOCAL_NM" ] && [ ! -L "$LOCAL_NM" ] && return 0
  ln -s "$SWALLOW_DEPS_DIR/node_modules" "$LOCAL_NM" 2>/dev/null || return 1
  return 0
}
if ! resolve_deps_link 2>/dev/null; then
  # skill 目录只读 / 无法建 symlink → 从 skill 目录起 tsx，import 解析照常
  cd "$SCRIPT_DIR"
fi

exec "$TSX_BIN" "$ORCH" "$@"

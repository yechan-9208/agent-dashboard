#!/usr/bin/env bash
# AAD 플러그인: 대시보드 서버 종료
set -euo pipefail

DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/aad}"
PORT="${AAD_PORT:-4319}"
PIDFILE="$DATA/server.pid"

killed=0

# 이 PID가 우리 aad 서버가 맞는지 확인 (오인 종료 방지)
is_our_server() {
  local pid="$1"
  local args
  args="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$args" in
    *aad.js*serve*) return 0 ;;
    *) return 1 ;;
  esac
}

# 1) PID 파일 우선
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null && is_our_server "$PID"; then
    kill "$PID" 2>/dev/null || true
    # 최대 ~3초 대기 후 강제 종료
    for _ in $(seq 1 15); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
    killed=1
  fi
  rm -f "$PIDFILE"
fi

# 2) PID 파일이 없거나 이미 죽었으면 포트 리스너 확인
if [ "$killed" -eq 0 ] && command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true); do
    if is_our_server "$pid"; then
      kill "$pid" 2>/dev/null || true
      killed=1
    fi
  done
fi

if [ "$killed" -eq 1 ]; then
  echo "AAD 대시보드 서버를 껐습니다."
else
  echo "AAD 대시보드 서버가 실행 중이 아닙니다."
fi

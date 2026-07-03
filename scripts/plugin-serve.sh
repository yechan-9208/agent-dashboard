#!/usr/bin/env bash
# AAD 플러그인: 대시보드 서버 기동 + 브라우저 열기
# - CLAUDE_PLUGIN_ROOT: 설치된 플러그인 캐시(업데이트마다 바뀜 — 상태 저장 금지)
# - CLAUDE_PLUGIN_DATA : 영속 디렉토리(node_modules·canonical·backups·상태는 여기)
set -euo pipefail

# 1) 루트 경로 (개발 repo 직접 실행 시 폴백)
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# 2) 영속 데이터 디렉토리
DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/aad}"
mkdir -p "$DATA"

PORT="${AAD_PORT:-4319}"
URL="http://127.0.0.1:${PORT}"
LOG="$DATA/server.log"
PIDFILE="$DATA/server.pid"

fail() { echo "AAD 실행 실패: $*" >&2; echo "로그: $LOG" >&2; exit 1; }

# 3) 의존성: 번들 package.json과 DATA 사본을 비교해 다르면 npm install
#    (공식 권장 패턴 — 캐시(ROOT)에는 쓰지 않고 영속 DATA에만 설치)
if ! command -v node >/dev/null 2>&1; then
  fail "node 를 찾을 수 없습니다. Node.js가 설치돼 있어야 합니다."
fi

need_install=0
if [ ! -d "$DATA/node_modules" ]; then
  need_install=1
elif [ ! -f "$DATA/package.json" ]; then
  need_install=1
elif ! cmp -s "$ROOT/package.json" "$DATA/package.json"; then
  need_install=1
fi

if [ "$need_install" -eq 1 ]; then
  echo "의존성 설치 중… (최초 1회 또는 업데이트 시)"
  cp "$ROOT/package.json" "$DATA/package.json"
  # package-lock가 있으면 함께 복사(재현성)
  [ -f "$ROOT/package-lock.json" ] && cp "$ROOT/package-lock.json" "$DATA/package-lock.json" || true
  if ! ( cd "$DATA" && npm install --omit=dev --no-audit --no-fund >"$DATA/npm-install.log" 2>&1 ); then
    echo "npm install 실패. 로그: $DATA/npm-install.log" >&2
    # package.json 사본 무효화(다음 실행에서 재시도되도록)
    rm -f "$DATA/package.json"
    fail "의존성 설치에 실패했습니다."
  fi
fi

# require('gray-matter') 등 bare specifier를 DATA의 node_modules에서 찾도록 NODE_PATH 지정.
# (ROOT는 캐시라 쓰기 금지 — 심볼릭 링크 대신 NODE_PATH 사용)
export NODE_PATH="$DATA/node_modules"

# 4) 상태 영속화 (실제 홈이 아닌 DATA 아래로 격리) — 항상 실제 파일 기준(D37, 모드 env 불필요)
export AAD_CANONICAL="$DATA/canonical"
export AAD_BACKUPS="$DATA/backups"
mkdir -p "$AAD_CANONICAL" "$AAD_BACKUPS"
# canonical 이력용 git init (실패해도 계속)
if [ ! -d "$AAD_CANONICAL/.git" ]; then
  ( cd "$AAD_CANONICAL" && git init -q ) >/dev/null 2>&1 || true
fi

# 5) 카탈로그/레지스트리 캐시도 DATA 아래로 (ROOT는 업데이트 시 소실)
#    paths.js가 이미 AAD_REGISTRY_CACHE 오버라이드를 지원한다.
export AAD_REGISTRY_CACHE="$DATA/catalog-cache"
mkdir -p "$AAD_REGISTRY_CACHE"

# 6) 중복 실행 방지 — 포트가 이미 리슨 중이면 그대로 안내 + 브라우저만 열기
port_in_use() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null --max-time 2 "$URL/overview" && return 0
  fi
  # curl 없거나 응답 실패 시 lsof로 리스너 확인
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  return 1
}

open_browser() {
  if [ "$(uname)" = "Darwin" ] && command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
  else
    echo "브라우저에서 열어주세요: $URL"
  fi
}

if port_in_use; then
  echo "AAD 대시보드가 이미 실행 중입니다: $URL"
  open_browser
  exit 0
fi

# 7) 서버 기동
[ -f "$ROOT/bin/aad.js" ] || fail "$ROOT/bin/aad.js 를 찾을 수 없습니다."
: > "$LOG"
nohup node "$ROOT/bin/aad.js" serve --port "$PORT" >"$LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PIDFILE"

# 8) 서버 응답 대기 (최대 ~10초)
ready=0
for _ in $(seq 1 50); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break  # 프로세스가 죽었으면 즉시 중단
  fi
  if command -v curl >/dev/null 2>&1; then
    if curl -s -o /dev/null --max-time 2 "$URL/overview"; then ready=1; break; fi
  else
    if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then ready=1; break; fi
  fi
  sleep 0.2
done

if [ "$ready" -ne 1 ]; then
  rm -f "$PIDFILE"
  fail "서버가 정상적으로 응답하지 않습니다."
fi

echo "AAD 대시보드를 실행했습니다: $URL"
echo "PID: $SERVER_PID (로그: $LOG)"
open_browser

#!/usr/bin/env bash
# #471 AC1 — `wait_http` 소유 판정 프로브 (`local-stack-contract.test.ts` 가 부른다).
#
# ## 왜 프로브가 따로 있나
# 스택 전체를 띄우는 계약은 **1차 방어**(`require_port_free` — 띄우기 전 포트 점유 검사)가 먼저
# 물어서 통과한다. 그러면 **2차 방어**인 `wait_http` 의 소유 판정은 어떤 테스트도 안 태우는
# 코드가 된다. 2차가 막는 것은 *"검사할 땐 비어 있었는데 우리가 바인드하기 전에 남이 잡은"*
# 경주라 스택 전체로는 재현이 어렵다 → 함수를 **직접** 부른다.
#
#   bash tools/local-stack-wait-http-probe.sh
#   → foreign_arm=3   (남이 문 포트: 200 을 받아도 준비완료로 안 읽는다)
#     own_arm=0       (우리가 문 포트: 정상 인식 — 계약이 늘 3 만 뱉는 게 아님을 증명)
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 함수만 로드한다(아무것도 띄우지 않는다).
HMB_LOCAL_LIB_ONLY=1 source scripts/local-stack.sh
set -m

# 포트는 커널이 고르게 한다 — 고정 포트를 잡으면 다른 세션과 충돌한다(데모/배포 포트는 물론이고).
freeport() { node -e 'const n=require("net");const s=n.createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})'; }
listener() { node -e "require('http').createServer((q,s)=>{s.writeHead(200);s.end('{}')}).listen($1)"; }

# ── 팔 1 — 남이 그 포트를 물고 있다. 우리 잡은 살아 있지만 그 포트를 듣지 않는다.
PORT=$(freeport)
( exec node -e "require('http').createServer((q,s)=>{s.writeHead(200);s.end('{}')}).listen($PORT)" ) & FOREIGN=$!
sleep 1
( exec sleep 30 ) & OURS=$!
wait_http "http://localhost:$PORT/health" 3 "$OURS"; echo "foreign_arm=$?"
kill -TERM -- -$OURS 2>/dev/null; kill -TERM -- -$FOREIGN 2>/dev/null; sleep 0.3

# ── 팔 2 — 우리 잡이 진짜 그 포트를 듣는다.
PORT2=$(freeport)
( exec node -e "require('http').createServer((q,s)=>{s.writeHead(200);s.end('{}')}).listen($PORT2)" ) & MINE=$!
wait_http "http://localhost:$PORT2/health" 10 "$MINE"; echo "own_arm=$?"
kill -TERM -- -$MINE 2>/dev/null

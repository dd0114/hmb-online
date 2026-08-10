#!/usr/bin/env bash
# #471 AC3 팔 C — "로그인 안 됨" 을 그대로 재현하는 가짜 claude.
# 실측 출력 형태(ai-mode.ts:114)를 loggedIn=false 로만 바꿨다.
[ "$1 $2" = "auth status" ] && { echo '{"loggedIn":false}'; exit 0; }
echo "fake claude: unsupported $*" >&2; exit 1

#!/usr/bin/env bash
# wrangler 가 `functions/` 를 **어디서** 읽는지 — 소스·헬프로 실증 (#299).
# 동작 실증(대조군 포함)은 deploy-wiring.e2e.sh W1.
set -uo pipefail
WRANGLER="${HMB_WRANGLER:-$(command -v wrangler)}"
CLI="$(dirname "$(dirname "$WRANGLER")")/lib/node_modules/wrangler/wrangler-dist/cli.js"
[ -f "$CLI" ] || CLI="$(node -e 'console.log(require.resolve("wrangler/wrangler-dist/cli.js"))' 2>/dev/null)"
[ -f "$CLI" ] || { echo "cli.js 를 못 찾음 — 소스 실증 생략(동작 실증은 deploy-wiring.e2e.sh W1)"; exit 0; }

echo "# wrangler functions/ 해석 규칙 — 소스 실증 (#299)"
echo
echo "wrangler = $WRANGLER ($("$WRANGLER" --version 2>&1 | tail -1))"
echo "cli.js   = $CLI"
echo
echo "## 1) pages deploy — functionsDirectory 결정"
grep -n 'const functionsDirectory = customFunctionsDirectory' "$CLI"
echo
echo "## 2) pages dev — functionsDirectory"
grep -n 'const functionsDirectory = "./functions"' "$CLI"
echo
echo "## 3) deploy 호출부 인자 — functionsDirectory 키가 **없다** ⇒ 항상 cwd 기준"
CALL=$(grep -n 'await deploy2({' "$CLI" | cut -d: -f1 | head -1)
sed -n "${CALL},$((CALL + 14))p" "$CLI"
echo "   (위 인자 목록에 functionsDirectory 가 있는가: $(sed -n "${CALL},$((CALL + 14))p" "$CLI" | grep -c 'functionsDirectory')건)"
echo
echo "## 4) --functions-directory 플래그 존재 여부 (0 = 없다)"
"$WRANGLER" pages deploy --help 2>&1 | grep -c 'functions-directory'
"$WRANGLER" pages dev --help 2>&1 | grep -c 'functions-directory'

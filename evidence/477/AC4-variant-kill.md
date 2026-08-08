# AC4 변이체 킬 — 읽는 법 (⚠️ 먼저 읽어라)

**`AC4-variant-kill-RAW-gate-disabled.log` 는 "실패해야 정상"인 로그다.** 그 파일만 열어서
`4 failed` 를 보고 "이 기능이 깨졌다"로 읽으면 정확히 거꾸로 읽은 것이다(2R 패널에서 실제로
한 번 그렇게 읽혔다 — 그래서 이 안내를 남긴다).

## 무엇을 한 것인가
계약이 **비어 있지 않음**을 증명하려고, 기제를 일부러 끄고 같은 e2e 를 돌렸다:

```
MaintenanceGate.tsx:  if (health === "outage")  →  if (false as boolean)
$ CI=1 WEB_E2E_PORT=5483 npx playwright test p477-maintenance --config=playwright.config.ts
(실행 후 `git checkout -- apps/web/src/common/MaintenanceGate.tsx` 로 원복,
 `grep -c 'health === "outage"'` → 2 로 원복 확인)
```

## 기대하는 뒤집힘과 실제 결과

| 파일 | 코드 상태 | 기대 | 실제 |
|---|---|---|---|
| `AC4-e2e.log` | **출하 코드 그대로** | 5 passed | **5 passed** |
| `AC4-variant-kill-RAW-gate-disabled.log` | **게이트를 끔(변이체)** | "뜬다" 4건 red · "안 뜬다" 1건 green | **4 failed / 1 passed** |

즉 두 로그는 **같은 코드의 두 실행이 아니라, 서로 반대인 두 코드의 실행**이다. 이 대조가
성립하므로 "뜬다" 계약 4건은 점검 화면의 실제 표시를 검사하고 있고(비어 있지 않고), 오탐
가드는 그것과 독립이다(기제를 꺼도 계속 통과 = 다른 것을 재고 있다).

## 살아남은 1건이 하필 오탐 가드인 이유
그 테스트의 단언은 **부재**("점검 화면이 뜨지 않는다")다. 기제를 끄면 당연히 계속 참이다.
그래서 이 한 건은 변이체 킬로 검정되지 않으며, 그 대신 출하 코드에서 **다운 시나리오 4건이
실제로 뜬다**는 사실이 그 테스트가 무의미하지 않음을 받쳐 준다.

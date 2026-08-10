# #471 로컬 빌드 — Research (R 단계 산출)

> 기준: `feat/471-localbuild` @ `57e91e0`(origin/main). 이슈 #471 첫 코멘트의 실측은 `ef11361`
> 기준이라 **현행 main 에서 재확인**한 것만 아래에 남긴다(메모리 `hand-measured-numbers-go-stale`).

## 재확인 — 첫 코멘트와 일치 (현행 main 에서 그대로 참)

| 사실 | 확인 방법 | 결과 |
|---|---|---|
| `.github/` 없음 = CI 0 | `ls -a .github` | No such file — 일치 |
| README 가 "구현 이전 단계" 문서 | `cat README.md` (18줄) | 빌드·실행·포트 0줄 — 일치 |
| `claudeCodeAuthSelfCheck()` 가 `ANTHROPIC_API_KEY` 유무만 본다 | `claude-code.ts:210-220` | 일치. `which claude`·로그인 확인 없음 |
| `isTransient` = `CAP\|TIMEOUT` 만 | `resilience.ts:15-18` | 일치. `withFallback` 은 `if (!isTransient(e)) throw e`(`:70`) → **AUTH 는 폴백 비대상** |
| `/api/config` 에 실행기 모드 채널 0 | `ConfigController.java` 전문 | 일치 — `currencies/shop/grants` 3필드뿐 |
| 실서버 대상 web e2e = 3개, 없으면 skip | `grep -l HMB_E2E_API_ORIGIN apps/web/e2e` | `match-flow` · `league-season` · `w3-viewer-smoke` 3개 — 일치 |
| `apps/web/playwright.config.ts` webServer = vite 만 | `:25-30` | 일치 — java/runner/executor 자동 기동 없음 |
| 씨앗 `p4-clock-smoke.sh` | 전문 | 28080/28790 · JDK21 자동탐색(`:21-26`) · `trap cleanup` PID-only(`:29-37`) · bootJar → java -jar → executor(stub) → 가입 → 덱 → 매치 → 상태전이 판정 |

## 분해에 필요해서 새로 확인한 것

1. **`/api/config` 는 공개(무인증)** — `apps/web/src/api/client.ts:237` 의 `SESSION_NEUTRAL_PATHS`
   에 들어 있고, 서버에서도 인증 제외다. 즉 **로그인 전 게임 시작 화면에서도 모드를 읽을 수 있다**
   → 요구 3 의 "게임 시작할 때 안내"에 딱 맞는 채널. 소비 배관도 이미 있다
   (`useAppConfig()` + `AppConfigContext`, retry 3 · 포커스 재검증).
2. **Java 는 실행기 모드를 모른다** — 실행기는 TS 서번트라 `AI_EXECUTOR` 는 Java 프로세스 env 가
   아니다. 그래서 "Java 가 env 를 읽어 내려준다"는 **선언값**이 되고, 프리플라이트 강등 결과와
   어긋난다. 보고 경로가 필요하다 → `/internal/**`(`ServantTokenInterceptor` 보호,
   `InternalJobController` 가 `poll`/`complete` 선례) 에 **실행기 자기보고**를 추가하는 형태가
   리포 결에 맞는다.
3. **루트에 `scripts/` 없음** — 쉘 진입점은 `server-java/scripts/`(java 모듈 소유)·`infra/`·
   `tools/`(node) 로 흩어져 있다. 4프로세스를 가로지르는 스크립트는 **루트 `scripts/`** 가 맞다.
4. **루트 게이트 진입점** = `package.json` scripts (`test:t0/t1/t2`·`e2e`·`typecheck`). 전부
   `tools/run-gate.mjs` 슬롯락 경유이고 `e2e` 는 `--exclusive`. 새 로컬 스택 게이트도 같은 결.
5. **전제 버전의 기계 SoT**: node `.nvmrc:1` = `20.19.6` / JDK `server-java/build.gradle.kts:10-14`
   = 21. README 가 이 숫자를 적으면 **드리프트 가능** → parity 계약이 대조해야 할 대상이 이 둘.

## 미해결/리스크 (구현 중 실측으로 결정)

- claude 로그인 dry-probe 의 **판정 신뢰도** — `claude -p` 1회 호출 비용·지연. 미설치(spawn error)와
  미로그인(AUTH)과 정상을 어떻게 가르나. (구현 시 실측)
- 로컬 스택의 web 층: vite dev 를 스크립트가 띄울지, E2E 의 `webServer` 에 맡길지. 후자면 스크립트는
  3프로세스로 남고 E2E 가 4번째를 얹는다 → **중복 기동 방지**가 필요.

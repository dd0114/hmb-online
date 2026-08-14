# 배포 회복력 — 터널 자가복구 설계 (에픽 #183)

> **이 문서 = 접근안 비교·근거.** SoT = 에픽 **#183**. 운영 절차는 [`deploy-playbook.md`](./deploy-playbook.md), 아키텍처 근거는 [`deploy.md`](./deploy.md).
> owned: hmb:infra 세션 (`infra/**` + `apps/web` 런타임 config 배선). 엔진·게임로직 무관.
> **상태: hero 승인 완료(2026-07-26) — 채택 = `C(정적 워치독) + A(런타임 config) + E(클라 재시도)`. 구현 진행.**
> 미채택: **B**(프록시) — KV 토큰 없이는 복구 속도 이득 0인데 API 핫패스에 Functions 표면만 추가. **D**(도메인) — "도메인 없이" 전제 유지.

---

## 1. 문제 — 무엇이 실제로 깨지나

배포된 web(`hmb-online.pages.dev`)은 백엔드 주소를 **빌드타임에 인라인**한다(`VITE_API_BASE`, vite 특성 — `infra/pages/build.sh` 주석). quick tunnel 은 URL 이 고정되지 않는다. 둘이 겹치면 **터널이 죽는 순간 테스터 전원 `Failed to fetch`** 이고, 사람이 `start-tunnel.sh` 를 칠 때까지 복구되지 않는다.

실측된 사망 사례 2건(`docs/deploy-log.md`):

| 일자 | 증상 | 시사점 |
|---|---|---|
| 2026-07-22 | `cloudflared` **프로세스는 살아 있는데** 호스트명이 NXDOMAIN, 로그는 `control stream failure` 재시도 루프 | **PID 생존 = 헬스 아님.** 프로세스 감시(launchd KeepAlive)만으론 못 잡는다 |
| 2026-07-25 | 재배포가 아니라 **유휴 중** 터널 사망 → 배포된 web 이 죽은 URL 을 계속 호출 | 사망은 배포 이벤트와 무관하게 아무 때나 온다 |

추가 제약: **이 머신 ISP DNS(168.126.63.1)가 `*.trycloudflare.com` 을 전부 NXDOMAIN.** 로컬에서 하는 모든 헬스체크·검증은 DNS 를 우회해야 한다(외부 테스터는 정상 — 로컬만의 문제).

---

## 2. 실패 모델 (이걸 다 덮어야 "자가복구")

| # | 실패 | 현재 대응 | 필요한 것 |
|---|---|---|---|
| F1 | cloudflared 프로세스 사망 | 사람이 `start-tunnel.sh` | 감지 + 자동 재기동 |
| F2 | **프로세스 생존 + 터널 등록 만료**(07-22) | 사람이 눈치챌 때까지 없음 | **왕복 기반** 헬스 + 재기동 |
| F3 | 새 URL 을 web 이 모름 | 사람이 `deploy-web.sh <URL>` | **URL 전파 채널** |
| F4 | 로컬 백엔드(java 18080) 사망 | `status.sh` 수동 | 감지 + 로그/경보 (터널 재기동 무의미 — 스래시 금지) |
| F5 | 복구 창(수십 초~수 분) 동안 열려 있던 탭 | 없음 | 클라 재시도(선택) |
| F6 | 로컬 DNS NXDOMAIN | 수동 `--host-resolver-rules` | 헬스체크가 DNS 우회 |

**핵심**: F1·F2 는 *감지·복구*(접근 C), F3 은 *전파*(접근 A/B), D 는 F3 자체를 소멸시킨다. **C 없이 A/B 만으론 아무것도 자동화되지 않고, A/B 없이 C 만으론 새 URL 이 web 에 안 닿는다** — 최소 조합은 `C + (A or B)`.

---

## 3. 접근안

### A. 런타임 config (web 이 부팅 시 backend URL 을 읽는다)
`dist/config.json`(`{"apiBase":"https://xxx.trycloudflare.com"}`)을 Pages 에 두고, `client.ts` 의 `apiBase()` 가 빌드타임 상수 대신 이 값을 쓴다(빌드타임 값은 폴백). URL 이 바뀌면 **config 한 줄만 갱신**.

- 갱신 = **Pages 재배포**. 단 `npm ci`+`vite build` 는 불필요 — 마지막으로 배포한 `dist` 를 그대로 두고 `config.json` 만 바꿔 `wrangler pages deploy` (변경 파일만 업로드) ⇒ 수십 초.
- ⚠️ 함정: Pages 배포는 **디렉토리 전체 교체**다. 캐시된 dist 가 낡았으면 **web 코드가 롤백**된다 → 마지막 배포 dist 를 **머신 전역 캐시**(`~/.cache/hmb/dist-current`, `deploy.env` 와 같은 리포 밖 전역 패턴)에 보존하고 healer 는 거기서만 배포. 워크트리가 여러 개(spider9/10/14)라 리포 안에 두면 안 된다.
- `config.json` 은 반드시 `Cache-Control: no-cache`(`infra/pages/_headers` 추가).

### B. Pages Function 프록시 (same-origin `/api/*`)
web 은 상대경로 `/api/...` 로만 요청하고, Pages Function(`functions/api/[[path]].ts`)이 백엔드로 포워딩.

- **CORS 가 소멸한다.** `WEB_ORIGINS`↔`VITE_API_BASE` 결선(오배선 시 조용히 왕복 실패, 배포 때마다 java `--force-recreate`)이라는 **실패 클래스 하나를 통째로 제거**. `apiBase()` 가 `""` 로 돌아가 dev/데모 경로와 완전 동일해진다.
- ⚠️ `_redirects` 로는 불가능하다 — Pages 200 rewrite 는 외부 오리진을 못 가리킨다(`infra/pages/_redirects` 에 이미 근거 박제). **Functions 여야만 한다.**
- 프록시 타겟을 **어디에 두느냐가 전부**:
  - **B-KV**: Workers KV 바인딩에서 요청 시 읽기 ⇒ 갱신 = **KV write 1회(≈1초, 배포 0)**. 가장 빠른 복구.
    **🔴 실측 차단**: 현 CF API 토큰에 KV 권한이 없다(`wrangler kv namespace list` → `Authentication error [code: 10000]`, 같은 토큰으로 `pages project list` 는 정상). **hero 가 KV Storage:Edit 를 포함한 토큰을 재발급해야 가능**(대시보드 2분).
  - **B-static**: 타겟을 배포물에 둔다 ⇒ 갱신 = 재배포 ⇒ **복구 속도는 A 와 동일**한데 런타임 경로(Functions)만 추가. *A 대비 이득은 CORS 소멸뿐.*
  - **B-외부**: Function 이 외부(gist 등)에서 타겟을 읽음 ⇒ 권한 문제는 없으나 **핫패스에 GitHub 의존**을 넣는다. 비권장.
- 비용/한도: Functions 무료 100k req/day. 현 트래픽(매치 생성 중 3초 폴링 `hooks.ts:167`, 테스터 소수)엔 여유. 지연 +엣지 1홉.

### C. 정적 자가복구 워치독 (launchd, Claude 0호출)
`patrol-static` 패턴 그대로 — **정적 bash + launchd**, Claude 호출 0.

1. **헬스 = 왕복**(PID 아님, F2 때문): `dig +short @1.1.1.1 <host>` 로 **ISP DNS 우회** → `curl --resolve <host>:443:<ip> -H "X-Servant-Token: …" https://<host>/internal/health`.
   - 프로브는 `GET /internal/health`(토큰 보호, 부작용 0)를 쓴다. `status.sh` 가 쓰는 `POST /api/auth/login` 은 매 분 유저를 만드는 셈이라 워치독엔 부적합.
2. 2회 연속 실패 → **치유**: 로컬 백엔드 헬스 확인(죽었으면 F4 — 터널 재기동 안 함, 로그·경보만) → 구 터널 **PID 로만** 종료(`pkill -f` 절대 금지 — 다른 세션 스택을 죽인다) → 새 터널 기동 → URL 캡처 → **글로벌 DNS 등록 대기**(dig @1.1.1.1 폴링) → 왕복 검증 → **URL 전파**(A 또는 B) → Pages→백엔드 최종 검증 → heal 로그 append.
3. 가드레일: `flock` 단일 인스턴스 · 시간당 최대 치유 횟수 초과 시 백오프+DEGRADED 마킹 · 수동 배포 중이면 같은 락으로 양보 · **데모 8080/8790 무접촉**.
4. 설치: 스크립트는 리포(`infra/tunnel-heal.sh`)에 버전관리하되 `infra/install-tunnel-heal.sh` 가 `~/.local/bin/` 로 복사 + plist 등록 — 워크트리 3개 중 어디가 정본인지 흔들리지 않게.
5. launchd 는 최소 env 로 뜬다 → 절대경로 + `~/.config/hmb/deploy.env` 명시 source.

### D. named tunnel (도메인)
CF 존에 DNS 라우트를 만들어 **URL 을 영구 고정**(`deploy.md` §5.2). URL 이 안 바뀌므로 **A·B·F3 전파가 통째로 사라지고 C 는 "프로세스 살아있게 유지" 수준으로 축소**된다. cloudflared 자체 재연결 + launchd KeepAlive 로 끝.
- 유일한 블로커 = **도메인**(CF 등록가 ~$10/yr). 존 없이 named tunnel 은 붙일 hostname 이 없다. `*.workers.dev` 로 우회해도 결국 "현재 quick URL 이 뭔지" 를 알아야 해서 B 와 같은 문제로 되돌아온다.

### E. 클라 재시도 (보조, 어느 조합이든 함께 권장)
네트워크 실패 시 config 를 캐시버스팅 재조회 → 1회 재시도, 실패하면 "재연결 중" 상태 표시(죽은 앱 대신). 복구 창(F5) 동안 **열려 있던 탭이 스스로 살아난다**. apps/web 소량 변경.

---

## 4. 트레이드오프

| | A 런타임 config | B-KV 프록시 | B-static 프록시 | C 워치독 | D named tunnel |
|---|---|---|---|---|---|
| 덮는 실패 | F3 | F3 | F3 | **F1·F2·F4·F6** | **F1·F2·F3 소멸** |
| 단독으로 자가복구? | ❌ | ❌ | ❌ | ❌(전파 필요) | ✅ |
| 복구 시간(MTTR) | ~1.5–2.5분 | **~1–1.5분** | ~1.5–2.5분 | (감지 ≤60s) | **수 초, URL 불변** |
| CORS | 유지(결선 계속 관리) | **소멸** | **소멸** | — | 유지(1회 결선 후 불변) |
| 새 권한/비용 | 없음 | **KV 토큰 재발급(hero)** | 없음 | 없음 | **도메인 ~$10/yr** |
| 새 런타임 경로(장애 표면) | 낮음(정적 JSON) | 중(Functions 핫패스) | 중 | 낮음(격리된 bash) | 없음 |
| 롤백 위험 | dist 캐시 오염 시 web 롤백(⇒ 전역 캐시로 방어) | 동左(코드 배포 시) | 동左 | 스래시(⇒ 레이트리밋으로 방어) | — |
| 구현량 | 소 | 중 | 중 | 중 | 소(+hero 수동 로그인) |

---

## 5. 권장

**기본안 = `C + A + E`** — 도메인 0원·새 권한 0으로 "사람 개입 없는 자가복구" 를 완성하는 최소 조합.
- C 가 F1·F2 를 잡고, A 가 새 URL 을 전파하고, E 가 복구 창의 사용자 체감을 지운다.
- **B-static 을 권하지 않는 이유**: 복구 속도가 A 와 같은데 핫패스에 Functions 를 추가한다. CORS 소멸은 좋지만 그것만으로 런타임 표면을 늘릴 근거가 약하다.

**hero 가 KV 토큰을 발급하면 → `C + B-KV + E` 로 승격**(A 대신). 이때 이득이 둘 다 온다: 복구가 **배포 없이 KV write 1회**로 떨어지고, CORS 결선이라는 실패 클래스가 사라진다. (토큰 재발급 = 대시보드 2분, 이 세션은 대시보드 접근 불가.)

**D 는 "도메인 없이" 라는 전제만 풀면 위 전부를 압도한다** — $10/yr 로 A·B·전파 로직과 그 유지비가 통째로 없어진다. 전제가 진짜 고정인지 한 번은 확인할 가치가 있다(에픽엔 "옵션"으로 적혀 있음).

### hero 결정 포인트 (3개)
1. **어디까지?** — 자가복구만(`C+A+E`) vs 프록시로 CORS 까지 소멸(`C+B-KV+E`)
2. **KV 권한 토큰 재발급**해줄 수 있나 (2번을 고르면 필수, 1번이면 불필요)
3. **도메인(D)** 은 정말 배제인가 — $10/yr 로 이 에픽 대부분이 불필요해진다

---

## 6. 구현 스케치 (승인 후)

```
infra/tunnel-heal.sh          # 정적 워치독 본체 (Claude 0호출)
infra/install-tunnel-heal.sh  # ~/.local/bin 설치 + launchd plist 등록/해제
infra/com.hmb.tunnel-heal.plist
infra/publish-backend-url.sh  # 전파 채널 1개 (A: dist 캐시 config.json + pages deploy / B: KV write)
infra/pages/_headers          # config.json no-cache 추가
apps/web/src/api/client.ts    # (A) 런타임 config 우선·빌드타임 폴백  /  (B) apiBase → "" 복귀
infra/deploy-web.sh           # 배포 시 dist 를 ~/.cache/hmb/dist-current 로 보존 + config.json 기록
docs/plan-v4/deploy-playbook.md  # §자가복구 절 추가(설치·정지·로그 위치)
```

**검증 AC (실측, 사람 개입 0)**
1. 정상 상태 확인 → 터널 **PID 로 강제 kill**
2. 사람이 아무것도 안 한 채로: 워치독이 감지 → 새 터널 → URL 전파 → Pages→백엔드 왕복 200 이 **자동 복구**
3. 실브라우저(Playwright, 로컬 DNS 우회 `--host-resolver-rules`)로 `hmb-online.pages.dev` 게스트 로그인 왕복 성공 = 실패 요청 0
4. **MTTR 실측치 기록**(kill 시각 → 왕복 200 시각), heal 로그에 남는지 확인
5. F2 재현: cloudflared 를 살려둔 채 터널만 무효화한 상황에서도 감지되는지(왕복 기반인지) 확인
6. 스래시 가드: 백엔드를 죽인 상태에서 워치독이 터널을 반복 재기동하지 **않는지**

---

## 7. 실측 결과 (2026-07-26, 구현 후)

> ⚠️ **아래 MTTR 은 "주입한 고장" 의 값이다 — 실장애의 값이 아니다** (#505, 2026-08-14 추가).
> 강제 kill 은 원인이 **이미 사라진 뒤**에 감지가 시작되므로 첫 시도가 곧바로 성공한다. 실장애는
> 그 반대다: 원인(네트워크·DNS)이 아직 살아 있는 시점에 첫 시도가 뛴다 → **첫 시도 4/4 실패**.
>
> | | 주입 고장(F1) | 실장애 자동복구 3건 |
> |---|---|---|
> | MTTR | **98초** | **5분 14초 · 7분 10초 · 9분 31초** |
>
> 여기에 자동복구가 끝내 안 된 1건(2026-08-14, 사람이 13분 39초 만에 수동 복구)이 더 있다.
> 근거 = `docs/deploy-log.md` 의 `2026-08-14T10:00Z 장애 기록` + #505.

### 7.1 자가복구 성립 — 사람 개입 0 (주입 고장 기준)

| 시나리오 | 방법 | MTTR | 결과 |
|---|---|---|---|
| **F1 터널 프로세스 사망** | `kill <pid>` | **98초** | ✅ 감지(≤60s 틱 + 10s 재확인) → 새 터널 → 왕복 확인 → config 전파 → Pages 반영 |
| **F2 프로세스 생존 + 터널 사망**(07-22 실장애 패턴) | `kill -STOP <pid>` | **53초** | ✅ 감지·복구 + **멈춘 프로세스도 정리**(SIGTERM 무시 → SIGKILL 폴백) |
| **F4 백엔드 사망** | 죽은 포트로 격리 실행 | — | ✅ `BACKEND_DOWN` 기록 후 **터널 재기동 안 함**(스래시 방지, 새 cloudflared 0개) |
| **실브라우저 왕복** | Playwright, Pages→치유된 터널 | — | ✅ 게스트 가입 → 스타터팩 **3,000P 지급**까지 왕복, **실패 요청 0건** |
| **전파 단독**(터널 정상 + web 스테일) | 워치독 `PUBLISH_ONLY` | ~10초 | ✅ 터널을 건드리지 않고 config 만 재전파 (실전에서 자동 발동 확인) |

게이트: `npm test` **1126 passed / 0 failed**(결정론 80회 desync 0 포함) · web 계약 `client.test.ts` 36/36.

### 7.2 실측이 아니었으면 못 잡았을 것 — launchd 에서만 터지는 4가지

첫 kill 테스트는 **실패했다**(스래시 루프로 URL 이 4번 바뀜). 원인은 전부 "내 셸에서는 되는데
launchd 에서는 안 되는" 것들이었다. 설계 리뷰로는 절대 안 나온다.

| # | 증상 | 원인 | 수정 |
|---|---|---|---|
| 1 | 새 터널이 만들어지자마자 죽음 → 매 틱 새 터널(스래시) | launchd 는 잡이 끝나면 **같은 프로세스 그룹을 회수**한다(기본값) | plist `AbandonProcessGroup=true` |
| 2 | 전파가 `Missing file or directory: /.wrangler/tmp` 로 3연속 실패 | wrangler 는 **cwd 밑에** 임시 디렉토리를 만드는데 launchd 기본 cwd 는 `/` | 쓰기 가능한 작업 디렉토리로 이동(+`WorkingDirectory`) |
| 3 | 전파가 CF API 첫 요청에서 **6분 넘게 매달림**(같은 명령이 셸에선 2초) | launchd 컨텍스트에서 `$HOME` 보호 디렉토리 접근이 걸림(`.Trash` 경고가 단서) + 메트릭 POST | 작업 디렉토리를 **$HOME 밖**(`/tmp`)으로 + `WRANGLER_SEND_METRICS=false` + **wrangler 타임아웃 150s** |
| 4 | 실패가 반복돼도 상한에 안 걸림 | 치유 **성공**만 카운트해서 "매번 실패하는 치유" 가 무한 반복 | 상한을 **시도** 기준으로 변경 |

추가로 `npx -y wrangler` 가 실행마다 수 분 걸려 MTTR 을 잡아먹어 **wrangler 선설치**로 전환
(전파 4분 → **10초**).

### 7.3 판정 로직에서 실측으로 바로잡은 것

- **1.1.1.1 은 이 네트워크에서 안 뜬다**(`connection timed out`). 설계대로 단일 해석기로 짰으면
  상시 오탐이었다 → 해석기 **순차 폴백**(system → 8.8.8.8 → 9.9.9.9 → 1.1.1.1).
- 해석기가 **전부** 빈손인 순간에도 브라우저는 정상 왕복한 사례가 관측됨 → DNS 실패만으로
  사망 판정하지 않고 **curl 직결로 한 번 더** 확인한 뒤에야 죽었다고 본다.
- 헬스 프로브는 **토큰 없이** `GET /internal/health` → **401** 이면 정상(java 가 응답했다는 증거).
  부작용 0 이라 매분 쳐도 된다.
- 치유 직후 30초 뒤 Pages 엣지가 잠시 옛 값을 보여 **불필요한 재전파**가 한 번 돌았다
  → 전파 후 **쿨다운 180초**.

### 7.4 남는 한계 (정직하게)

- **복구 창은 없앨 수 없다**: 감지 주기(60초) + 재확인(10초) + 터널·전파(≈30초) = 최선 ~40초,
  실측 50~100초. 그동안 새 요청은 실패한다. 열려 있던 탭은 클라 재시도(E)로 자동 회복하지만,
  **그 순간 진행 중이던 요청 1건은 실패로 보인다.**
- quick tunnel 은 실제로 **자주** 죽는다(이 검증 세션 1시간 동안 자발적 사망 2회 관측).
  자가복구가 그걸 흡수하지만, 근본 해결은 여전히 **D(도메인 = URL 고정)** 이다.
- 워치독은 이 머신의 launchd 사용자 세션에 붙는다 — **로그아웃/재부팅 후 자동 재개**되지만
  머신이 꺼져 있으면 당연히 아무것도 못 한다.

---

**미검증 — 구현 전 스파이크(각 30분 이하)**
- `wrangler pages deploy` + `functions/` 디렉토리 인식 경로(리포 루트 cwd 기준인지, `_worker.js` advanced mode 가 나은지) — B 채택 시에만
- KV 바인딩을 대시보드 없이 `wrangler.toml` 로 Pages 에 붙일 수 있는지 — B-KV 채택 시에만
- 새 quick tunnel 호스트가 글로벌 DNS 에 등록되기까지의 실제 지연(전파 대기 상한 산정용)
- `config.json` 변경만 있는 재배포에서 wrangler 가 실제로 변경 파일만 올리는지(소요시간 실측)

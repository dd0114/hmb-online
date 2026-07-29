# 운영 컨텐츠 무배포화 (에픽 #309) — 설계

> **문제**: 공지 텍스트와 유닛 활성/비활성은 이미 무배포로 운영된다(#248 · #207 파트 A). 그런데
> **이미지가 걸린다** — 공지에 새 그림 한 장을 넣으려면 `apps/web/public/notice/` 에 파일을 커밋하고
> **웹을 다시 배포**해야 한다. 유닛도 카탈로그 채번과 아트가 배포에 묶여 있다.
> 이 문서는 그 배포 의존을 끊는 설계다. **W1 = 공지 이미지 업로드**(소형, 이 문서의 §1~§6),
> **W2 = 유닛 등록·아트 핫로드**(중형, §7 에 스코프와 선행 조사만).

---

## 0. 현재 배포 의존 (실사)

| 운영 행위 | 현재 | W |
|---|---|---|
| 공지 텍스트 CRUD·게시·기간·우선순위 | ✅ 무배포 (#248 admin API, DB 가 SoT) | 유지 |
| 공지 **이미지** | ❌ `apps/web/public/notice/*.webp` → **웹 배포** | **W1** |
| 유닛 활성/비활성 | ✅ 무배포 (admin API, `admin_locked`) | 유지 |
| 유닛 **카탈로그 등록**(채번·스탯) | ❌ data 발행물 → 백엔드 재배포(부팅 임포트) | W2 |
| 유닛 **아트**(카드·아이콘·아틀라스) | ❌ `design/characters/dist/**` → `apps/web/public/chars/` 스테이징 → **웹 배포** | W2 |

---

## 1. W1 결정표 — 공지 이미지 업로드

| # | 결정 | 값 | 왜 |
|---|---|---|---|
| D1 | 저장소 | **도커 볼륨**(`hmb-db` = `/var/lib/hmb`) 아래 `notice-assets/` | SQLite 와 **같은 볼륨**이라 백업 대상이 자동으로 하나다. compose 변경 0. economy override 가 이미 같은 디렉토리를 쓴다(선례). |
| D2 | 메타데이터 | **DB 표 `notice_assets`**(V30) | 목록·감사·삭제·참조검사가 필요하다. 파일시스템만 두면 "누가 언제 뭘 올렸나"가 없다. |
| D3 | 공개 서빙 | `GET /api/notices/assets/{id}` — **인증 제외**(AuthInterceptor exclude) | 공지 본문 자체가 이미 공개다(`/api/notices/active`). **점검 공지는 로그인이 안 될 때 가장 필요하다** — 그 본문의 이미지에 401 을 두면 정확히 그 순간에 깨진다. |
| D4 | 본문에 적히는 것 | **상대경로** `/api/notices/assets/{id}` (절대 URL 아님) | ⚠️ **이게 이 설계의 핵심 한 줄이다.** 백엔드는 quick tunnel 뒤에 있고 **URL 이 죽을 때마다 바뀐다**(deploy-log 2026-07-22·07-25 실적). 절대 URL 을 본문에 구우면 **터널이 한 번 죽는 순간 과거 공지의 이미지가 전부 깨지고**, 되살릴 방법이 본문 일괄 수정뿐이다. 상대경로로 두면 web 이 렌더 시점에 `apiUrl()` 로 현재 오리진을 붙이므로 자가복구 워치독(#183)이 갱신한 주소를 그냥 따라간다. |
| D5 | 업로드 인가 | `POST /api/admin/notices/assets` — **admin 게이트 뒤**(구조적) | `/api/admin/**` 접두사에 `AdminInterceptor` 가 걸려 있고 접두사 밖 매핑은 `AdminRouteGuard` 가 **부팅을 막는다**. 컨트롤러에 권한 코드를 쓰지 않는다. |
| D6 | 타입 화이트리스트 | **png · jpeg · webp · gif**, 판정은 **매직바이트** | 파일명 확장자·클라 신고 Content-Type 은 공격자가 정한 값이다. **SVG 는 거부** — SVG 는 스크립트를 담을 수 있어 `<img>` 로도 XSS 표면이 된다(#248 이 본문 파서를 화이트리스트 AST 로 만든 이유와 같은 축). |
| D7 | 저장 파일명 | `{ULID}.{탐지된 확장자}` — **업로드 이름을 경로에 쓰지 않는다** | 경로 탈출(`../../etc/passwd`)이 **구조적으로 불가능**해진다. 차단 규칙을 짜서 막는 게 아니라 사용자 입력이 경로에 도달하지 않는다. 원본 이름은 표시용으로 DB 에만. |
| D8 | 크기 상한 | 기본 **2 MB**(`hmb.notice.asset.max-bytes`) + Spring multipart 상한 동조 | 공지 히어로 이미지 실측이 81 KB 다. 상한은 볼륨 보호이지 기능 제약이 아니다. env 로 무배포 조정 가능. |
| D9 | 내리기 | **삭제가 없다 — 노출 스위치(`active`) 하나뿐** (hero 확정 2026-07-30) | "삭제 없애. 비활성화하면 되잖아." 자산을 내리는 행위는 **되돌릴 수 있어야** 한다. 삭제는 오조작이 곧 영구 소실이고, 참조하던 공지의 그림을 되살릴 방법이 없다. 끄면 서빙이 404, 다시 켜면 그대로 돌아온다 — **파일도 행도 사라지지 않는다**. 공지 자체의 `active` 스위치(#248)와 **같은 어휘**라 운영자가 새 개념을 배우지 않는다. |
| D10 | 캐시 | `Cache-Control: public, max-age=31536000, immutable` | id 당 내용이 불변이다(재업로드 = 새 id). ⚠️ 대가 = **꺼도 이미 캐시된 브라우저에는 한동안 남는다**. 급히 내려야 하는 그림이면 자산을 끄는 것이 아니라 **공지를 내리는 것**이 정답이다(그건 즉시 반영). |
| D11 | 중복 제거 | **안 한다**(같은 파일을 두 번 올리면 두 자산) | sha256 은 기록하되 dedupe 는 하지 않는다. 공유 blob 이 생기면 "하나를 지웠는데 다른 공지 그림이 사라진다"가 되고, 절약되는 용량은 공지 이미지 규모에서 무의미하다. |

---

## 2. 서버 (server-java)

### 2.1 마이그레이션 V30 `notice_assets`

```sql
CREATE TABLE notice_assets (
  id            TEXT PRIMARY KEY,          -- ULID = 서빙 경로의 유일한 식별자
  stored_name   TEXT NOT NULL,             -- {id}.{ext} — 탐지된 타입에서 파생(업로드 이름 무관)
  original_name TEXT,                      -- 표시 전용. 경로에 쓰지 않는다(D7)
  content_type  TEXT NOT NULL,             -- 화이트리스트 확정값(클라 신고값 아님)
  byte_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,             -- 기록만(dedupe 안 함, D11)
  active        INTEGER NOT NULL DEFAULT 1,-- 노출 스위치. 삭제 컬럼은 없다(D9)
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL,             -- ISO-8601 UTC 초 절삭(Notices.normalizeInstant 규약)
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_notice_assets_live ON notice_assets(active, created_at DESC);
```

⚠️ 번호는 **merge-ready 시점에 main 이 배정**한다(현재 V29 까지 사용). 결번·중복은
`FlywayVersionContinuityTest` 가 기계로 막는다 — 사람이 기억하지 않는다(V26 주석의 이력 참조).

### 2.2 빈 구성 — 게이트 오염을 피하는 배치

```
online.hmb.notice.NoticeAssetStorage      경로 계산 + 읽기/쓰기 (공용, admin 타입 참조 0)
online.hmb.notice.NoticeAssetService      공개 읽기 (id → 바이트 + content-type)
online.hmb.notice.NoticeAssetController   GET /api/notices/assets/{id}   ← 게이트 밖(공개)
online.hmb.admin.AdminNoticeAssetService  업로드·목록·삭제 + 감사 기록   ← ADMIN_ONLY_BEANS 에 추가
   (AdminController 에 엔드포인트 3개 추가 — 기존 notices 운영 옆)
```

- ⚠️ **공개 컨트롤러가 admin 서비스에 의존하면 부팅이 죽는다**(`AdminRouteGuard` 의 의존성 판정).
  그래서 읽기 경로는 `NoticeAssetService`, 쓰기 경로는 `AdminNoticeAssetService` 로 **갈라 둔다** —
  `NoticeController`(공개) vs `AdminNoticeService`(운영) 와 정확히 같은 구조다.
- `AdminNoticeAssetService` 를 `ADMIN_ONLY_BEANS` 에 **반드시 추가**한다. 빠뜨리면 가드가 그 서비스를
  "admin 데이터"로 보지 않아 게이트 밖 매핑이 부팅을 통과한다 —
  `AdminGateTest.everyAdminPackageServiceIsSeededIntoTheGuard` 가 누락을 잡는다.

### 2.3 엔드포인트

| 메서드 | 경로 | 인가 | 응답 |
|---|---|---|---|
| POST | `/api/admin/notices/assets` | admin | `201 {id, url, contentType, byteSize, originalName, active, createdAt}` |
| GET | `/api/admin/notices/assets` | admin | `{assets:[…, usedBy:n]}` — `usedBy` = 그 id 를 본문에 담은 **삭제되지 않은 공지 수** |
| POST | `/api/admin/notices/assets/{id}/active` | admin | `{active, reason}` → 갱신된 자산 (D9 — 삭제 엔드포인트는 **없다**) |
| GET | `/api/notices/assets/{id}` | **공개** | 이미지 바이트 (**`active=0` 이면 404**) |

- 업로드는 `multipart/form-data`, 파트명 `file`. 감사 기록은 `admin_ops_audit` 에
  `notice_asset_upload` / `notice_asset_active` — 접두사가 `notice_` 라 **기존 공지 이력 조회
  (`GET /api/admin/notices/history`, `LIKE 'notice\_%'`)에 그대로 섞여 나온다**(의도: 운영자에게
  공지 작업은 한 흐름이다).
- 응답의 `url` 은 **상대경로**(`/api/notices/assets/{id}`) 다 — D4. 서버가 자기 외부 URL 을 알 수 없고
  (터널 뒤), 안다 해도 그 값을 본문에 굽는 순간 D4 가 막으려는 문제가 그대로 생긴다.
- 서빙 응답 헤더: `Content-Type`(저장된 확정값) · `X-Content-Type-Options: nosniff` ·
  `Cache-Control`(D10) · `Content-Length`. `{id}` 는 FS 에 닿기 **전에** ULID 정규식으로 거른다(심층방어).

### 2.4 검증 순서 (업로드)

1. 크기 — 상한 초과면 `413`/`VALIDATION_ERROR`(먼저 판다: 큰 파일을 읽고 나서 거절하지 않는다)
2. **매직바이트** → 허용 4종 중 하나로 확정. 아니면 400. **클라 Content-Type 은 참고도 하지 않는다**
   (`\x89PNG` · `\xFF\xD8\xFF` · `GIF8[79]a` · `RIFF….WEBP`)
3. ULID 채번 → `{id}.{ext}` 로 **temp → ATOMIC_MOVE**(반쯤 쓰인 파일이 서빙되는 창을 없앤다 —
   `AdminEconomyService.writeAtomically` 와 같은 패턴)
4. DB INSERT → 감사 기록. FS 쓰기가 성공하고 DB 가 실패하면 파일을 되돌린다(고아 방지).

⚠️ **정직한 한계**: 매직바이트는 "진짜 이미지인가"의 완전한 증명이 아니다(polyglot 파일). 그러나
서빙이 **고정 Content-Type + nosniff** 이고 HTML/SVG 를 절대 내보내지 않으므로, 브라우저가 그 바이트를
스크립트로 해석할 경로가 없다. 이 조합이 방어이지 매직바이트 단독이 아니다.

---

## 3. 웹 (apps/web)

### 3.1 렌더 — `/api/` 경로만 API 오리진으로 (D4 의 소비 측)

```ts
// NoticeBody 의 이미지/링크 해석 지점 한 곳
resolveNoticeUrl(src) = src.startsWith("/api/") ? apiUrl(src) : src
```

- `/api/notices/assets/…` → 현재 백엔드 오리진(런타임 config #183 > 빌드타임 `VITE_API_BASE` > "")
- `/notice/hero-kyeongnicius.webp` 같은 **기존 정적 에셋은 그대로 웹 오리진** — 공존한다(#309 요구).
- `safeNoticeUrl` 은 **손대지 않는다**. 앱 경로(`/…`)를 이미 통과시키고 있고, 살균 규칙
  (`//host`·`/\host` 거부, `javascript:`·`data:` 강등)이 그대로 유효하다.
- 테스트·dev 에서는 `apiBase()==""` 라 **항등**이다 → 기존 e2e 무영향(§5).

### 3.2 업로드 UI (`admin/NoticesPanel`)

- 공지 편집 폼에 **[이미지 업로드]** — 파일 선택 → 업로드 → **본문 커서 위치에 `![](/api/notices/assets/{id})` 삽입**.
  현재 안내문("이미지는 업로드가 아니라 URL 참조입니다")은 이 웨이브에서 갱신한다.
- **자산 목록**(썸네일 · 원본이름 · 크기 · 업로드 시각 · `usedBy` · [마크업 복사] · **[노출 ON/OFF]**).
  끌 때 `usedBy > 0` 이면 **경고 후 확인**("공지 2건이 이 이미지를 씁니다 — 끄면 그 자리가 빕니다").
  차단하지 않는다: 운영자가 아는 상태에서 내리는 결정이고, **되돌릴 수 있다**(D9).
- 미리보기는 기존 `NoticeBody` 를 그대로 쓴다 — 미리보기와 실화면이 갈라지면 미리보기가 거짓말이 된다(#248 원칙).

### 3.3 `apiFetch` 멀티파트 분기

`apiFetch` 는 지금 body 를 **무조건 `JSON.stringify`** 한다. `body instanceof FormData` 면 그대로
넘기고 **`Content-Type` 을 설정하지 않는다**(브라우저가 boundary 를 붙여야 한다). API base 적용
지점은 계속 `apiFetch` 한 곳이다(#129 불변).

---

## 4. 보안 요약 (한 표)

| 표면 | 막는 것 | 어떻게 |
|---|---|---|
| 업로드 인가 | 아무나 업로드 | `/api/admin/**` + `AdminInterceptor` + `AdminRouteGuard` 부팅 검사 |
| 파일 타입 | SVG/HTML/스크립트 | 매직바이트 화이트리스트 4종 + 고정 Content-Type + `nosniff` |
| 경로 탈출 | `../` 파일명 | 저장 경로에 사용자 입력이 **도달하지 않는다**(ULID 파생명) + 서빙 id ULID 정규식 |
| 용량 | 볼륨 고갈 | 크기 상한(env) + Spring multipart 상한 |
| 본문 살균 | XSS | 기존 `parseNoticeBody` 화이트리스트 AST(무변경) |
| 원장 | "누가 올렸나" 부재 | `admin_ops_audit` 성공·실패 모두 |

---

## 5. 기존 계약 영향 조사 (#309 이 W1 설계에 요구한 항목)

| 대상 | 영향 | 근거 |
|---|---|---|
| `notice-markup.ts` / `.test.ts` | **없음** | 앱 경로 `/…` 는 이미 통과. 파서를 안 바꾼다. |
| `e2e/p248b-notice-ux.spec.ts` (히어로 이미지 계약) | **없음** | `/notice/hero-kyeongnicius.webp` 는 `/api/` 로 시작하지 않아 해석 대상이 아니고, 테스트 환경은 `apiBase()==""` 라 항등. |
| `e2e/p248-notice-admin.spec.ts` | 목 추가 필요 | 자산 목록 조회가 새로 붙으므로 `**/api/admin/notices/assets` 목을 실어야 한다(오리진 앵커 글롭 규칙 준수). |
| `client.test.ts` | 추가만 | FormData 분기 계약 신설. 기존 JSON 경로 단언 무변경. |
| `AdminGateTest` · `AdminRouteGuard` | **추가 필수** | 새 admin 서비스를 `ADMIN_ONLY_BEANS` 에 시드(§2.2). |
| `FlywayVersionContinuityTest` | 번호 배정 | V30(merge-ready 시 main 확정). |
| CORS(`CorsConfig`) | **변경 없음** | 허용 헤더에 `Content-Type` 이 이미 있어 multipart preflight 통과. `<img>` 로딩은 CORS 대상이 아니다. |
| CF Pages `_headers` | **변경 없음** | CSP 를 의도적으로 안 걸어 뒀다(파일 §38 주석) → 교차 오리진 이미지 로드에 제약 없음. ⚠️ 나중에 CSP 를 도입하면 `img-src` 에 API 오리진을 넣어야 한다 — open-checklist 에 적는다. |
| **웹 런타임 매니페스트 전환**(#309 가 지목한 충돌 우려) | **W1 무관 + W2 도 우려보다 작다** | §7.1 |

---

## 6. W1 게이트

1. `./gradlew test --rerun-tasks`(server-java) — UP-TO-DATE 거짓 green 방지
2. `npm run build`(apps/web) — 루트 typecheck 는 web 타입을 안 본다
3. 목킹 e2e **지정 실행**(`CI=1 WEB_E2E_PORT=…`) — 전체 실행 금지(:8080 데모에 붙는다)
4. openapi 갱신(프리즈 절차) — 4개 엔드포인트 + `NoticeAsset` 스키마
5. `docs/plan-v4/deploy-playbook.md` 백업 항목에 `notice-assets/` 명시(같은 볼륨이라 자동 포함이지만 **문서에 없으면 다음 사람이 모른다**)
6. 독립검증(module-verifier, 별도 컨텍스트) — blocker 0

---

## 7. W2 스코프 (착지는 W1 이후)

1. **admin 유닛 등록/수정/회수 API** — 카탈로그 행 채번·스탯, `admin_locked` 정합, #210(삭제 경로 부재) 흡수
2. **아트 업로드** — 로컬 파이프라인(합성·아틀라스)은 **유지**하고 **산출물만** 올린다(재발명 금지)
3. **웹 아트 매니페스트 런타임 로드** — 폴백 = 구운 `/chars`(서버가 죽어도 화면이 성립)
4. **viewer-skins**(경기장 토큰)까지 관통

### 7.1 선행 조사 결과 — "빌드타임 manifest 를 읽는 기존 테스트와 충돌하나"

**우려보다 작다. 아트 매니페스트는 이미 런타임 fetch 다.**

- `char-assets-store.fetchCharAssets(base = CHARS_BASE)` 가 `/chars/**` 를 **런타임에 fetch** 한다
  (번들 import 아님 — 172명 아틀라스를 JS 번들에 넣지 않으려고 처음부터 그렇게 짰다).
  즉 W2 가 바꿔야 하는 것은 **로딩 방식이 아니라 `base` 하나**이고, 그 인자는 **이미 존재한다**.
- 단위 테스트(`char-manifest.test.ts` · `full-art.test.ts` · `FullArtCard.test.ts` · `viewer-skins.test.ts`)는
  **픽스처 manifest** 로 돈다 → base 와 무관, 충돌 0.
- e2e(`p3-card-art` · `p218-legend-arena` · `p285-icon-policy`)는 라우트 매처가
  `url.pathname === "/chars/player-chars.json"` · `url.pathname.startsWith("/chars/")` 처럼
  **pathname 기준 함수**다 → **오리진이 바뀌어도 그대로 매칭된다**. 그래서 W2 가 서빙 경로의
  **pathname 을 `/chars/…` 로 유지**하면(오리진만 API 로 이동) 기존 계약이 손대지 않고 산다.
  ⚠️ 반대로 pathname 을 `/api/chars/…` 로 바꾸면 그 매처들을 전부 갱신해야 한다 — **경로를 바꿀 이유가
  없다면 바꾸지 않는 것이 계약 비용이 0 인 선택**이다.
- 실물 파일을 읽는 곳이 하나 있다: `e2e/p285-fixture.ts` 가
  `apps/web/public/chars/player-chars.json` 을 `readFileSync` 한다 → **구운 폴백이 계속 존재해야**
  이 픽스처가 산다. 폴백 유지(요구 ③)와 방향이 같다.

---

## 부록 — 왜 W1 을 먼저 하나

공지 이미지는 **표면이 작고**(엔드포인트 4개·표 1개·web 2곳) 유닛 아트와 **같은 문제**(파일 업로드 →
볼륨 저장 → 공개 서빙 → 웹이 런타임에 참조)를 푼다. W1 에서 저장·서빙·보안·백업의 뼈대를 세우고
실배포로 검증한 뒤, W2 가 그 뼈대 위에 아트를 얹는다 — 큰 것부터 하면 검증 안 된 저장 계층 위에서
카탈로그 채번까지 동시에 흔들린다.

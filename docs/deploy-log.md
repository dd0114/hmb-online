# 배포 기록 (deploy-log) — append-only

> **정책(P4-D5 / #171)**: 배포할 때마다 이 파일 맨 위(최신순)에 항목을 append 하고 커밋한다.
> "언제 무슨 버전이 배포됐나"의 SoT. AI·사람이 repo에서 바로 조회. `infra/version-manifest.sh` 산출을 여기에 옮겨 적는다.
> 항목 형식: 배포시각(UTC) · git SHA/브랜치 · 모듈별 버전(engine/server-java/web/servants) · 이미지 다이제스트 · tunnel/URL · 배포자 · 결과/비고.

---

## 2026-07-25T09:45Z — E1 게임화면 S1+S2+S3 완료본(뷰어 SoT 수렴) 배포 — web only
- **git**: `39eded4` (main = `p4dep/base`) — `[Spider] feat(dev-viewer): QA 뷰어 캐릭터 스킨 토글 (#169 S3, hero)`
- **모듈 버전**: engine **`@0.17.0`(릴리스 태그 v5.01)** — **직전 배포와 동일, 엔진 변경 0** · server-java `0.1.0` · web `0.0.0`(**P4-E1 S1+S2+S3** 고정 셸·정보 토글 + 재생 컨트롤 web 소유 + **iframe 제거 → web 이 `@hmb/viewer-core` 직접 마운트**) · servants `0.0.1`
- **이미지**: `hmb/server-java:p3` `sha256:522996d8…`(무변경) · `hmb/servants:p3` `sha256:abc37a61…`(무변경) — **도커 재빌드 없음**(엔진 무변경). 컨테이너는 2일 연속 가동분 유지, java 만 CORS 재결선으로 recreate.
- **tunnel/URL**: web=Cloudflare Pages **https://hmb-online.pages.dev** (고정) · backend=quick tunnel **`enhanced-metal-portsmouth-thanks.trycloudflare.com`** (직전 터널 `editors-hopes-…` 이 등록 만료 — cloudflared 프로세스는 살아 있었으나 호스트명이 NXDOMAIN·`control stream failure` 재시도 루프 → PID 로 종료 후 재기동, URL 변경) · CORS `WEB_ORIGINS=towers-flights-…,hmb-online.pages.dev`
- **배포자**: hero(지시) + hmb:p4dep(실행)
- **결과**: ✅ GREEN.
  - 백엔드: runner `engineVersion=engine@0.17.0` · java/runner 둘 다 healthy · **DB 볼륨 `hmb-p3-db` 보존**(`down -v` 미사용, hmb.db 24.8MB — 직전 24.7MB 대비 증가 = 테스터 데이터 유지). 컨테이너는 이 체크아웃(`spider9/…/infra`, compose project `hmb-p3`) 소유로 확인.
  - 왕복(실브라우저 Playwright, Pages→터널): 게스트 로그인 → 로비 지갑 **3,000P** 렌더, **실패 요청 0건** · 터널 직접 `POST /api/auth/login 200`
  - **게임화면 S1+S2+S3**(배포 번들 + /api 목킹 캡처): **iframe 0개**(S3 수렴 확인 — web 이 viewer-core 직접 마운트) · 캔버스 1050×680 실렌더(고유색 307, 빈 픽셀 0 — 피치·선수·트레일·`TACKLE` 자막 육안 확인) · 데스크탑 1280×800 페이지 스크롤 **0**, 정보 시트 **208px**(=26svh) 불변, 토글(통계·로그) 켜도 무대 유지·탭 3개 · 모바일 390×844 스크롤 0, 로그 시트 열어도 무대 유지
  - `https://hmb-online.pages.dev/version.json` = `39eded4` / `engine@0.17.0` / apiUrl=새 터널
- **비고**:
  - 이번 배포는 **web 전용**(엔진·server-java·servants 산출물 무변경). 백엔드는 상태 점검 + 터널 재기동만.
  - 락파일은 이미 동기화돼 있어 `npm ci` 무사통과(직전 배포의 `@hmb/viewer-core` 누락 이슈 재발 없음).
  - AI 실행기(모드 A)는 기존 호스트 프로세스(spider10, pid 13024) 계속 가동 — 이번 스모크 범위엔 라이브 AI 매치 미포함.

---

## 2026-07-22T16:11Z — engine v5.01(시야·파울) + E1 S1 게임화면 개편 배포
- **git**: `d5b55d5` (main = `p4dep/base` ff) — S1 머지 `5853dcd` + 로그 시트 26svh `09bdc04` 포함
- **모듈 버전**: engine **`@0.17.0`(릴리스 태그 v5.01)** — 오프더볼 시야 인지·판단 + 파울/옐로 벤치 복원 · server-java `0.1.0` · web `0.0.0`(**P4-E1 S1** 고정 셸·정보 토글·viewer-core, 정보 시트 26svh) · servants `0.0.1`
- **이미지**: `hmb/server-java:p3` `sha256:522996d8…`(무변경 — 5853dcd~d5b55d5 에 server-java 변경 없음, 캐시 전체 히트) · `hmb/servants:p3` `sha256:abc37a61…`(**신규** — 엔진 0.17.0 반영, runner `/health` 로 확인)
- **tunnel/URL**: web=Cloudflare Pages **https://hmb-online.pages.dev** (고정) · backend=quick tunnel `editors-hopes-chance-dozen.trycloudflare.com` (직전 터널이 죽어 있어 재기동 → URL 변경) · CORS `WEB_ORIGINS=towers-flights-…,hmb-online.pages.dev`
- **배포자**: hero(지시) + hmb:p4dep(실행)
- **결과**: ✅ GREEN.
  - 백엔드: runner `engineVersion=engine@0.17.0`(재빌드 전 0.16.0) · java/runner healthy · **DB 볼륨 `hmb-p3-db` 보존**(`down -v` 미사용, hmb.db 24.7MB — 직전 16.7MB 대비 증가 = 테스터 데이터 유지)
  - 왕복(실브라우저 Playwright, Pages→터널): 게스트 로그인 → 지갑 3,000P 렌더, 실패 요청 0건 · API 직접 `login 200 / me 200 / deck 404`(새 유저 = 정상)
  - **S1 게임화면**: 데스크탑 1280×800 — 페이지 스크롤 **0**, 셸=뷰포트 높이 800, 정보 시트 **208px = 26svh 정확 일치**(로그 토글), 통계 추가 후에도 시트 높이 불변(무대 보호) · 모바일 390×844 — 페이지 스크롤 0, 탭 3개(결과/통계/로그) 정상. 실캡처 확인(무대·자막·토글바 렌더 OK)
  - `https://hmb-online.pages.dev/version.json` = `d5b55d5` / `engine@0.17.0`
- **비고**:
  - ⚠️ **락파일 동기화 커밋 포함**: PR #169 이 `packages/viewer-core` 워크스페이스를 추가하면서 `package-lock.json` 을 갱신하지 않아 `npm ci` 가 `Missing: @hmb/viewer-core@0.1.0` 로 실패 → **Pages 빌드가 막혔다**. 루트 `npm install` 로 동기화(워크스페이스 링크 2개, 8줄, 의존성 버전 변동 0). 워크스페이스 추가 시 락파일 동반 커밋 = apps/web 세션 위생 이슈로 레이즈 필요.
  - 매니페스트 `git.dirty=true` 는 위 락파일 수정분(배포 후 커밋됨).
  - 이 머신의 ISP DNS(168.126.63.1)가 `*.trycloudflare.com` 을 전부 NXDOMAIN — 로컬 curl/브라우저만 영향(외부 테스터 무관). 스모크는 Chromium `--host-resolver-rules` 로 CF IP 고정해 수행.
  - AI 실행기(모드 A)는 기존 호스트 프로세스가 계속 가동 중(spider10, pid 13024) — java 재생성 후에도 동일 토큰/포트라 재연결.

---

## 2026-07-21T17:16Z — web 스킨 재배포 (main 정합)
- **git**: `bfb3b16` (main) — 직후 `8adfaab`(W4 문서)까지 포함 main
- **모듈 버전**: engine `@0.16.0` · server-java `0.1.0` · web `0.0.0`(main 빌드, 스킨 #145·트레이드·matchui 포함) · servants `0.0.1`
- **이미지**: `hmb/server-java:p3` `sha256:bc39c33d…` · `hmb/servants:p3` `sha256:bc249f7e…`
- **tunnel/URL**: web=Cloudflare Pages **https://hmb-online.pages.dev** (고정) · backend=quick tunnel `insured-stakeholders-laid-silicon.trycloudflare.com`
- **배포자**: hero(토큰) + hmb:p3dep(실행)
- **결과**: ✅ GREEN. 스킨 렌더 확인, 로그인→왕복 200, DB 볼륨(hmb-p3-db 16.7MB) 보존.
- **비고**: 초기 배포(2026-07-21T15:53, `8aa1da0` p3dep/base)는 스킨 누락 → main 재빌드로 복구. **미포함**: qa `#147` 엔진 시야(engine/base 미머지, hero sign-off 대기) → 이 배포 엔진은 `@0.16.0`.

---
<!-- 새 배포는 이 줄 위에 최신순으로 추가 -->

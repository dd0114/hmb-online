# PRD v4 — Phase 3 (계정·운영·튜토리얼·배포 오픈)

> Phase 2(태그 없음, main) 위 증분. 목표 = **내부 테스터에게 배포해 실플레이**시킬 수 있는 상태. 이 문서가 Phase 3 요구 SoT.
> 작성: 2026-07-20, hero 요구 9항목 + 확정 답변 반영. **착수 게이트: #106(덱 재설계) 완료 후.**

## 0. 확정 결정 (hero)
| # | 결정 |
|---|---|
| P3-D1 | **배포 = Cloudflare Pages(web 정적) + Cloudflare Tunnel(백엔드=내 머신 도커)**. AI 실행기는 내 머신 구독 claude CLI **라이브**. 테스터는 CF URL 접속 |
| P3-D2 | **자체 로그인 = id/비번 평문 목업**(실서비스 전 해시 전환 백로그). 게스트/OAuth목과 공존, OAuth 실연동 지점 인터페이스 유지 |
| P3-D3 | **#106 먼저 완료 → Phase 3 착수**. Phase 3 계획·에픽은 지금 준비, 구현 웨이브는 #106 머지 후 발동 |
| P3-D4 | admin 인증 = env 하드코딩 자격 또는 특정 계정 플래그(평문 목업 수준) |
| P3-D5 | 충전 탭 = **목업만**(충전 상자 → 누르면 "admin에게 문의하세요" 안내). 실결제 백로그 |
| P3-D6 | 튜토리얼 = 간단 수준 허용. 최소 = 각 탭 진입 시 설명 오버레이(넘기기 가능). 가능하면 신규가입 시 순차 가이드(덱 셋팅→게임 시작 클릭 유도) |
| P3-D7 | 캐릭터 도트(#104) = **최고 등급(LEGEND)에만** 도트 이미지 적용, 나머지 등급은 기본 선수 이미지 |
| P3-D8 | 리그 보상은 서버 기구현(AC-F4) — Phase 3은 **검증 + 시즌 종료 보상 연출/알림**만 |

## 1. 요구별 + AC

### A. 자체 로그인 (server+web) — P3-D2
- R: id+비번 회원가입/로그인. 비번 평문 저장(users에 password 컬럼 additive, auth_provider='local'). 기존 게스트·mock:google/apple과 공존. AuthProvider에 local 분기.
- **AC-A1**: 회원가입(중복 id 409)→로그인(오답 401)→토큰. 기존 provider 플로우 무회귀.
- **AC-A2**: 비번은 응답/로그에 노출 안 됨. OAuth 실구현 교체 지점 주석+테스트 유지(평문은 임시임을 명시).

### B. 튜토리얼 (web 중심) — P3-D6
- R: 신규 유저(isNew 또는 tutorial_done=false) 첫 로그인 시 온보딩. 최소: 각 주요 탭(덱/게임시작/상점/도감) 첫 진입에 코치마크 오버레이(요소 하이라이트+설명+다음/건너뛰기). 이상: 순차 스텝(덱 구성→프리셋 저장→게임 시작까지 클릭 유도). 완료/건너뛰기 시 tutorial_done 저장(재노출 안 함, 설정에서 다시보기 옵션).
- **AC-B1**: 신규 계정 첫 진입 → 튜토리얼 시작, 건너뛰기 동작, 완료 후 재로그인 시 미노출.
- **AC-B2**: 모바일/데스크탑 모두 오버레이가 대상 요소를 정확히 가리킴(가로 오버플로 0).

### C. admin 페이지 (server+web) — P3-D4
- R: 별도 /admin 라우트(admin 계정만). 기능(테스터 운영 최소): 유저 목록·검색, **포인트 지급/차감**(충전 요청 수동 대응), 유저 상태 조회(보유·덱·전적), (선택) 캐릭터/데이터 조회. admin 액션은 원장 기록.
- **AC-C1**: 비admin 접근 403. admin 포인트 지급 → 유저 지갑·원장 반영, 감사 로그.
- **AC-C2**: admin API는 별도 인증 게이트(일반 유저 토큰으로 접근 불가).

### D. 충전 탭 목업 (web) — P3-D5
- R: 상점/지갑 영역에 충전 탭·충전 상자 UI(패키지 카드 몇 종 목업). 클릭 → "결제 준비 중 — 충전은 admin에게 문의하세요" 모달. 실 결제 연동 지점 주석.
- **AC-D1**: 충전 상자 클릭 → 안내 모달만, 어떤 상태 변화도 없음. admin 문의 동선 표시.

### E. 리그 보상 검증·연출 (server확인+web) — P3-D8
- R: 시즌 종료 시 순위별 보상 지급(기구현 AC-F4) — E2E로 **실제 지급 검증** + 결과 화면에 보상 연출(순위·획득 포인트·시즌 요약). 미지급/오류 시 노출.
- **AC-E1**: 리그 시즌 완주(stub 서번트로 18R) → FINISHED → 순위별 보상 지갑 반영 + 시즌 종료 화면에 보상 표시. 멱등(재진입 중복 지급 0).

### F. 캐릭터 도트 적용 (chars#104 연계 + data + web) — P3-D7
- R: #104 파이프라인 산출 도트 이미지를 **LEGEND 등급 선수에만** 매핑. 나머지 등급은 기본 플레이스홀더 이미지. 데이터: players에 image ref(등급/캐릭터 ID) additive. web: 도감·덱·매치 아바타에서 LEGEND는 도트, 그 외 기본.
- **AC-F1**: LEGEND 14명(현 분포) 도트 렌더, 비-LEGEND 기본 이미지. 이미지 부재 시 기본 폴백(깨짐 0).
- **의존**: #104 파일럿 통과 + hero 이미지 입고. 이미지 미확보 시 규격·매핑·폴백까지 준비하고 이미지만 대기.

### G. 배포 준비 (신규 infra) — P3-D1
- R: **web** = vite build → Cloudflare Pages(정적, /api는 Tunnel 백엔드로 프록시/환경변수 API base). **백엔드** = server-java Dockerfile(신규) + packages/server(러너·실행기) 컨테이너 + docker-compose(java+runner+executor+볼륨). Cloudflare Tunnel 설정(cloudflared) 문서. AI 실행기는 호스트 구독 CLI 접근(볼륨 마운트 or 호스트 실행). 시크릿/토큰 관리(SERVANT_TOKEN·admin 자격) env.
- **AC-G1**: `docker compose up` 로 백엔드 3프로세스 기동 + 헬스체크 green. web 빌드 산출 Pages 배포 가능 형태(API base 환경변수화).
- **AC-G2**: Tunnel 통해 외부 URL → web → 백엔드 왕복 1회 스모크(로그인→매치 생성). 배포 런북 문서(docs/plan-v4/deploy.md).

### H. 오픈 전 갭 점검 (전 도메인) — 요구 8
- R: 배포 오픈 체크리스트 — 계정(가입/로그인/로그아웃), 결정론·재현, 에러 처리(빈 상태·네트워크 실패 토스트), 데이터 리셋 정책(테스터 초기화), 동시 접속(SQLite lease 경합 #72), 라이브 AI 부하(동시 매치 큐 지연), 보안 최소(평문 목업 범위 명시·admin 격리), 모바일 반응형 전수, 법적(실선수→판타지 전환 상태·라이선스). 발견은 이슈로.
- **AC-H1**: 체크리스트 문서(docs/plan-v4/open-checklist.md) + 발견 항목 이슈화 + blocker 0 확인 후 오픈 GO.

## 2. 비범위
실 결제·실 OAuth·비번 해시(백로그), 프로덕션 인프라(정식 클라우드 DB·오토스케일), 캐릭터 전등급 도트(LEGEND만), PvP.

## 3. 에픽 분할(안)
| 에픽 | owned-glob | 내용 |
|---|---|---|
| **p3-account** | server-java/** + apps/web/** | A 자체 로그인 + B 튜토리얼 |
| **p3-admin** | server-java/** + apps/web/** | C admin 페이지 + D 충전 목업 |
| **p3-league-polish** | server-java(확인)+apps/web/** | E 보상 검증·연출 |
| **p3-chars-apply** | data/** + apps/web/** + (#104 산출 소비) | F LEGEND 도트 적용 |
| **p3-deploy** | 신규 infra/** + server-java(Dockerfile) | G 배포 + H 갭 점검 |
- 착수 순서: **#106 완료 게이트** → account·admin·league-polish·chars 병렬 → deploy(통합 후) → open-checklist → 테스터 오픈.
- 각 웨이브 module-implementer→verifier PASS→머지(Phase 1·2와 동일 게이트).

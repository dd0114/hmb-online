# #483 R — 실명 잔존 전수 조사 (2026-08-10)

전제: 라이브 소비본 = `players.v2.7`(`server-java/Dockerfile` `HMB_DATA_PLAYERSFILE`), 라이브 DB
`meta_kv.players_version = v2.7`, `players` 182행. 카탈로그 SoT = `data/players/`.

## 1. 사실 (facts)

### F1. ⚠️ **"EPIC 등급"은 존재하지 않는다** — 이슈 제목의 전제 정정

등급은 5단이다: `BRONZE · SILVER · GOLD · DIA · LEGEND`(`apps/web/src/common/grades.ts`
`GRADE_ORDER`, OpenAPI `Grade`). "에픽"은 **잠재 티어 라벨**이다(`POTENTIAL_TIERS = RARE|EPIC|UNIQUE`,
`apps/web/src/growth/growth-config.ts:58`). 코드가 그 사실을 이미 박아 두고 있다 —
`GachaFxPreview.tsx:284` *"현행 등급은 5단(브론즈·실버·골드·다이아·레전드)이고 '에픽'이라는 등급은 없다"*.

⇒ hero 가 본 것은 특정 등급이 아니라 **등급 무관 실명 잔존**이다. 이슈 본문이 이미 지시한
"전 등급 실명 전수 스캔"이 정확한 스코프이고, 아래 F2 가 그 전수다.

### F2. 실명 잔존의 실체 = v2.7 **은퇴 120종**(전 등급)

#450 W1 이 v2.7 에서 **활성 62종만** 가상명으로 바꾸고, 은퇴시킨 120종은 **실명 그대로 `active:false`**
로 발행했다. 이건 사고가 아니라 **#450 의 선언된 경계**다 — 명세 `docs/plan-v5/roster-v27-spec.md`
§주석 9: *"D5=ㄱ(리포 실명 존치) 이므로 `names-ko.ts`·`roster.ts`·`personality.ts` 에는 실명이 계속 있고…"*.

| 등급 | 은퇴(실명) | 활성(가상) |
|---|---:|---:|
| LEGEND | 14 | 10 (패러디 — 보날두·열라도나·춘바페… hero 확정 유지) |
| DIA | 12 | 13 |
| GOLD | 33 | 13 |
| SILVER | 39 | 13 |
| BRONZE | 22 | 13 |
| **계** | **120** | **62** |

120 중 **한국식 실명 24종**(P143 박지성 · P037 손흥민 · P164 조규성 …) + 외국 실명 96종.
전체 목록 = `epics/483-fictional-rename/inactive-120.md`.

### F3. ⚠️ **은퇴시켰는데도 유저의 210명 중 207명이 그 이름을 보고 있다**

`active=0` 은 **획득만** 막는다. 도감/덱 편성은 `WHERE p.active = 1 OR 보유수 > 0`
(`CatalogController.java:44`) — **보유분은 계속 보인다**(#207 U-D7, 의도된 설계).

라이브 실측(읽기 전용 사본, 2026-08-10):

```
총 유저                      210
실명(비활성) 카드 보유 유저   207   ← 98.6%
보유된 실명 종수              106 / 120
보유 행                       726
보유 장수                     798
```

가장 노출이 큰 두 종은 **스타터팩**이라 사실상 전원이 갖고 있다:

```
P092 메이슨 마운트  SILVER  206명
P081 벤 화이트      SILVER  206명
```

⇒ "은퇴시켰으니 안 보인다"는 성립하지 않는다. **표시명을 바꾸는 것 외에 이 노출을 없앨 방법이 없다**
(행 삭제는 구조적으로 불가 — 시드에 prune 이 없고 `AdminCatalogService.purge` 는 참조 1건이라도 있으면 409).

### F4. 노출 경로는 **카탈로그 하나**다 — 클라 번들은 깨끗하다

배포된 프로덕션 번들(`hmb-online.pages.dev/assets/index-iNSwHU8F.js`, 881KB) 전수 grep:
`Yashin` `Maradona` `Pel` `De Bruyne` `van Dijk` `손흥민` `메이슨` `마운트` **전부 0건**
(유일한 `화이트` 히트는 실황 문구 "화이트보드"). 실명이 있는 web 파일
(`design/CardArtPreview.tsx` · `GachaFxPreview.tsx`)은 `import.meta.env.DEV` 게이트 라우트라
프로덕션 빌드에서 제거된다.

⇒ 개명은 **data 카탈로그 발행 → 서버 부팅 임포트 → 라이브 DB** 한 경로로 끝난다.
`upsertPlayers` 의 `ON CONFLICT DO UPDATE … WHERE admin_locked = 0` 이고, 라이브 `admin_locked=1`
행은 **현재 0건**이라 182행 전량이 갱신된다.

### F5. 리포 내부 실명(로마자 축)은 **건드리면 안 된다**

`roster.ts` 의 `name` = 시드 RNG 스트림 순서이자 동결 발행물 v2~v2.5 를 바이트 동일 재현하는 기준
(`data/CLAUDE.md` §표시명 축). `names-ko.ts`·`personality.ts` 도 같은 이유로 실명이 남는다.
#450 D5 가 "리포 실명 존치"로 확정했고 **이번 트랙도 그 결정을 유지**한다 — 유저에게 보이는 축은
발행물의 `name`/`shortName` 뿐이다.

### F6. 표준 경로가 이미 있다 — v2.7 레이어를 그대로 한 칸 더

`generate.ts:buildPlayersV27(playersV26)` = **표시명 + active 레이어**(RNG 미사용 · 행 추가 0 ·
로스터 무접촉). 테이블 `V27_ACTIVE_CARDS[{id, from, to, short}]` 에 `from` 앵커가 있어 입력 발행물의
이름과 다르면 throw. **v2.8 은 같은 모양으로 나머지 120종을 덮으면 된다**(`from` = v2.7 실명).
검증 상수도 그대로 재사용 가능: `V27_MAX_NAME_LEN=14` · `V27_MAX_SHORT_LEN=8`.

### F7. 작명 규칙도 이미 문서화돼 있다 (spec §2-1-a / §2-2)

- 신규명 **모든 토큰**이 v2.6 실명 172종의 어떤 토큰(성·이름·shortName)과도 완전 일치 금지
- `PARODY_REAL_NAME_KO_DENYLIST` 9건 부분문자열 0
- 한국식은 `^[가-힣]{3}$` · `short == name` · v2.6 실명 **성 집합·이름 집합**과 충돌 0
  (테스트가 v2.6 발행물에서 **직접 도출** — 하드코딩 금지)
- ⚠️ **기계가 못 잡는 축**: *"1글자 차이로 실존 선수가 특정되는 형태 금지"* — #450 이 실제로 이 규칙에
  걸려 6건을 교체했다(`모라스`→모리안, `크루셀`→오스텐, `파브레`→페롤 …). **눈 대조가 필수**다.

### F8. 소비자 영향

- `playerId` 불변 → 보유 카드·성★·잠재·`stat_levels`·전적·덱 편성 **전부 무손실**(#450 이 이미 답한 축).
- `bots.v4.json` · `economy.v4.starterTop` 은 **활성 62종만** 참조한다(빌더가 강제) → 120종 개명과 직교.
- `player-chars.v2.json`(아트 매핑)에 실명 문자열 **0건**.

## 2. 관련 경로 (relevant paths)

```
data/players/generate.ts                     # V27_ACTIVE_CARDS 레이어 · buildPlayersV27 (v2.8 원형)
data/players/players.v2.7.json               # 입력(동결)
data/players/data.test.ts                    # 가드 — v2.7 describe 옆에 v2.8 신설
docs/plan-v5/roster-v27-spec.md              # 작명 규칙 SoT(§2-1-a·§2-2) · 은퇴 120 목록(§3)
server-java/src/main/resources/application.yml   # hmb.data.players-file
server-java/Dockerfile                       # HMB_DATA_PLAYERSFILE  ← DataVersionParity 쌍
server-java/src/main/java/online/hmb/catalog/PlayerCatalogService.java  # 부팅 임포트
docs/deploy-log.md                           # 배포 기록 필수(P4-D5 / #171)
```

## 3. 미해결 질문 (open questions)

- **Q1 — 패러디 LEGEND 10종(보날두·열라도나·춘바페·덕브라이너·석신·욱링엄·경니시우스·석다이크)은?**
  hero 가 #406 안 C 에서 **유지**로 확정했고 #450 이 그대로 승계했다. 실존 선수 연상이 남지만
  *패러디는 의도된 게임 컨셉*이라 이 트랙의 스코프 밖으로 둔다 — 뒤집으려면 hero 결정이 필요하다.
  (이름이 **카드 아트에 구워져** 발행됐다는 제약도 있다 — #207 U-D5 "정본은 카드 아트".)
- **Q2 — 공지 필요한가?** #450 은 은퇴+보상이라 공지했다. 이번은 **보유분 손실 0 · 표시명만 변경**이라
  체감은 "내 카드 이름이 바뀌었다"뿐. → 게임 내용 축이라 hero 게이트(계획에 포함).

## 4. 리스크 (risks)

| # | 리스크 | 완화 |
|---|---|---|
| R1 | **엉뚱한 행에 이름이 붙는다** — `from` 앵커는 id 별이라 두 행의 `to` 를 통째로 맞바꿔도 전 가드 통과 (`data/CLAUDE.md` 명시, 독립검증 minor-2) | 매핑표 생성 후 **id·등급·포지션 3축 눈 대조** + 등급/포지션이 이름 톤과 맞는지 확인 |
| R2 | 새 가상명이 **실존 선수를 1글자 차로 특정**(F7) | spec §2-2 의 교체 전례 6건을 그대로 체크리스트로 |
| R3 | v2.6 발행물 **재현 계약 파손** — 로스터/동결 슬라이스를 건드리면 골든이 깨진다 | v2.8 = 레이어 전용(F6). `data.test.ts` 의 v2~v2.7 describe **무접촉** 확인이 AC |
| R4 | `DataVersionParity` 어긋남 (yml ↔ Dockerfile) | 계약 테스트가 이미 있다 — 게이트에 `--rerun-tasks` 필수(메모리 `server-java-rerun-tasks-gate`) |
| R5 | 배포 = Pages 공개 → **미오픈 캐릭터 유출** 프리즈 규칙 | 이번 트랙은 **백엔드 재배포만** 필요(web 번들에 이름 없음, F4) → web 재배포 불요 |

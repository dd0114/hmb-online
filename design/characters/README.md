# design/characters — 캐릭터 인테이크 파이프라인 (#104)

캐릭터 **원화는 hero 가 외부에서 생성**해 제공한다. 이 트랙은 **창작하지 않고** 변환·규격화·검수 게이트만 담당한다.

```
SPEC.md          입고 규격서 — hero 가 이미지 뽑을 때 보는 문서 (P0)
PILOT-P2.md      파일럿 결과 = 자동 도트화 품질 상한 실측 (P2)
contact-sheet.png 대조 시트 증빙 (hero 게이트 제출물)
pipeline/        인제스트 스크립트 (node, 외부 의존 0, 결정론)
  ingest.mjs       incoming/ → out/ 3형태 산출
  sheet.mjs        out/ → contact-sheet.html
  shoot-sheet.mjs  contact-sheet.html → contact-sheet.png (게이트 제출물)
  pilot-crop.mjs   레퍼에서 파일럿 입력 크롭 (파일럿 전용)
  lib/             png(코덱) · img(연산) · quantize(양자화) · card(프레임 합성)
refs/            레퍼 3장 사본 (gitignore — 아래 참조)
incoming/        hero 드롭 지점 (gitignore)
out/             산출물 (gitignore — 재생성 가능)
dist/            **발행물(커밋)** — 게임이 소비하는 디폴트 에셋 + manifest
```

## dist/ — 디폴트(플레이스홀더) 에셋

hero 원화가 없어도 **게임이 플레이 가능**하도록 선수 172명 전원의 임시 에셋을 발행한다.
선수 id 해시로 머리색·피부톤·체형을 정하므로 **선수별로 구분**되고, 포지션 색(GK 금·DF 파랑·MF 초록·FW 빨강)이 키트에 들어간다.

```bash
node design/characters/pipeline/make-defaults.mjs   # data/players/players.v2.json → dist/
```

| 파일 | 내용 |
|---|---|
| `avatars-{64,32,16}.png` | 얼굴 아틀라스(14열 격자) |
| `sprites-{64,32,16,8}.png` | 전신 아틀라스(피치 위 렌더용) |
| `frame-{LEGEND,DIA,GOLD,SILVER,BRONZE}.png` | 등급별 카드 프레임 226×425 |
| `manifest.json` | 선수 id → 타일 좌표(`col`,`row`) + 포지션·등급·이니셜 |

소비법: `manifest.players[playerId]` 의 `col`/`row` × `atlases[x].tile` 로 스프라이트시트 오프셋을 잡는다.
`manifest.source === 'default-placeholder'` 면 아직 실제 원화가 아니다 — 원화 입고 시 `ingest.mjs` 산출물로 대체된다.

### dist/characters/ — 확정 캐릭터 에셋 (#121 소비)

hero 가 레퍼 12캐릭터를 게임 자산으로 확정(2026-07-21). LEGEND 14명 매핑용.

```bash
node design/characters/pipeline/pilot-crop.mjs      # refs → incoming (12캐릭터 크롭)
node design/characters/pipeline/ingest.mjs          # → out/ (3형태 + card-art)
node design/characters/pipeline/make-characters.mjs # → dist/characters/ (아틀라스 + hue변형 + manifest)
```

| 파일 | 내용 |
|---|---|
| `avatars-{64,32,16}.png` · `sprites-{64,32,16,8}.png` | 14종(원본 12 + 변형 2) 아틀라스 |
| `card-<id>.png` | 캐릭터별 카드 226×425 (개별 파일) |
| `manifest.json` | `characters[id]` = `{col,row,position,card}` + 변형은 `{variant:{of,hueDeg}, forPlayer}` |

- 세 축(`dist/` 172명 플레이스홀더 · `dist/characters/` 14종 확정 · `dist/units/` 입고 유닛)은 **별도 manifest** — 충돌 없음.
- #121 은 `characters[id]` 타일 좌표만 소비. **선수↔캐릭터 매핑은 #121(data/) 소유** — 여기서 안 한다.
- 변형(`sail-h150`·`ragna-h210`)은 §4.5 규격. web 은 일반 캐릭터와 동일 렌더(CSS 필터 불필요).

### dist/units/ — hero 입고 유닛 아트 (#207 W3-B, U-D5~U-D9 소비)

hero 가 외부에서 뽑은 **실아트**를 슬라이스·규격화해 발행한 세 번째 축. LEGEND 8종
(보날두·열라도나·춘바페·덕브라이너·욱링엄 + **3차 입고** 경니시우스·석다이크 +
**4차 입고** 오시야스) + **디폴트 유닛 1종**(GOLD/SILVER/BRONZE 공용, U-D8) = 9종.

```bash
python3 design/characters/pipeline/slice-units.py            # 원본(~/Desktop/imageRef) → dist/units/
python3 design/characters/pipeline/slice-units.py --verify    # 발행물 자기검증(manifest ↔ 실파일)
UNITS_SRC=/다른/경로 python3 .../slice-units.py               # 원본 위치 오버라이드
```

| 파일 | 내용 |
|---|---|
| `card-<id>.png` (512×768) | **완성 카드** — 프레임·이름판·포지션뱃지·별·대사가 이미 구워져 있다. **현재 0종**(↓ 2차 입고) |
| `art-<id>.png` (512×768, 디폴트 유닛만 139×201) | **프레임 없는 캐릭터 아트**(투명 배경). 현재 8종 전부 |
| `face-<id>.png` (256², 디폴트 유닛 132²) | 얼굴 마스터(고DPI) |
| `avatars-{64,32,16}.png` | 얼굴 아틀라스(3열 격자, 현재 3×3) — `characters` 축과 동일 계약 |
| `manifest.json` | `units[id]` = `{col,row,name,position,card:{file,kind,w,h},face,iconBackground,forPlayer?,forGrades?,pendingCatalog?}` |

**3차 입고(2026-07-29) — 신규 LEGEND 2종.** `source` = `hero-imageRef-2026-07-29-rev3`.
유닛이 6 → 8 이 되며 아틀라스 격자가 **3×2 → 3×3** 으로 자랐다(소비측은 manifest 의 `cols`/`rows`
를 읽으므로 무변경 — 격자 크기를 리터럴로 박고 있던 계약 2건은 발행물 기준으로 고쳤다).
- `kyeongnicius`(경니시우스·FW) → **P180 매핑 완료.** 시드는 아직 `active:false` 이고 활성화는
  어드민 API 몫이다(#207 파트 A) — 매핑을 미리 붙여 둬야 토글과 동시에 아트가 뜬다.
- `seokdijk`(석다이크·DF) → 입고 당시엔 **`pendingCatalog: true`**(붙일 선수가 카탈로그에 없었다)
  였고, **#256 hero 결정으로 P181 채번되며 해제**됐다. 선언이 사라진 것이 곧 "채번 완료" 신호다.

**4차 입고(2026-07-29, #256) — 신규 LEGEND 1종.** `source` = `hero-imageRef-2026-07-29-rev4`.
유닛 8 → 9. 아틀라스 격자는 3×3 그대로다(9 = 3×3 정확히 채움).
- `osiyas`(오시야스·GK) → **P182 매핑 완료.** 아트 입고와 카탈로그 채번이 동시라
  `pendingCatalog` 를 거치지 않았다. 시드는 `active:false` 이고 활성화는 어드민 API 몫이다.

⚠️ **유닛 추가는 `UNITS` 배열 맨 끝에 append 한다.** index → col/row 라서 중간 삽입하면 기존
유닛의 타일 좌표가 전부 밀리고, 캐시된 구 manifest + 새 아틀라스 조합에서 **얼굴이 뒤바뀐다**.

**소비측 분기 계약 = `units[id].card.kind`**
- `complete` → **그대로 그린다.** `frame-<GRADE>.png` 합성 경로를 타면 안 된다(등급 프레임이 이미 구워져 있다).
- `frameless-art` → 기존 합성 경로 그대로(등급 프레임 위에 아트를 얹기).

**2차 입고(#207 재발행) — `complete` 은 0종이 됐다.** 보날두·욱링엄이 완성 카드에서 프레임리스
아트로 재발행되며 두 문제가 같이 사라졌다: ① 카드에 **구워진 숫자·별이 실데이터와 어긋남**
(욱링엄 `99/MF/LEGENDARY`, 보날두 별 8개 vs 실제 OVR 89.7·성★ 1~4) ② 완성 카드(2:3)와 합성
카드(≈1:1.88)의 **종횡비 불일치로 뽑기 그리드 줄이 안 맞음**. 이제 6종 전부 등급 프레임 합성
경로를 타므로 이름·별·포지션은 **web 이 실제 데이터로** 그린다.
⚠️ 그래도 `complete` 분기·`cardKinds` 선언·`card-*` 파일명 규약은 **지운 게 아니라 남겨 뒀다** —
발행측이 언제든 다시 실을 수 있고, 그게 소비측의 "프레임 두 겹 방지" 계약이다. web 은 픽스처
manifest 로 그 분기를 계속 검증한다(`full-art.test.ts` · `FullArtCard.test.ts`).
욱링엄 **얼굴은 1차 시트 크롭 그대로 유지**한다 — 2차 입고의 `욱링엄-아이콘2.png` 는 112×112
규격 미달이고 유니폼에 레알 크레스트·adidas 로고가 남아 있다(새 카드에서는 지워진 것).

⚠️ `card` 는 **객체**다(`characters` 축은 문자열). 갱신 전 소비자가 문자열로 읽으면 `assetUrl` 이
`null` 을 돌려 폴백으로 떨어진다 — **틀린 그림을 그리는 대신 조용히 폴백**하는 fail-safe 형상이다.

- 크롭 좌표는 전부 `slice-units.py` 의 `CROPS` 에 박혀 있다(수작업 1회성 크롭 금지 — 원본이 갱신되면 다시 돌린다).
  단독 입고분(1024×1536 / 1024²)은 크롭이 없다 — 시트에서 떼어내는 것만 좌표를 갖는다.
- `--verify` 는 manifest↔실파일뿐 아니라 **픽셀 계약**도 본다: `complete` 은 불투명 · `frameless-art`
  는 알파 생존 + 인물 바운딩박스가 `ART_BBOX_BAND` 안 + 세로 점유율 하한. 한 장만 크거나 붕 뜨는
  발행을 그리드에 올리기 전에 잡는다.
- 원본은 **리포 밖·읽기 전용**이다. 이 파이프라인은 원본을 수정·이동하지 않는다.
- 이 단계만 **Pillow + numpy** 를 쓴다(다른 pipeline 스크립트는 외부 의존 0). 이유는 스크립트 헤더 주석.
- `forPlayer`/`forGrades` 는 **발행측 힌트**다. 권위 매핑은 `data/players` 의 `player-chars` 발행물이 소유한다.

## 쓰는 법

```bash
# 1) hero 가 SPEC.md 규격대로 incoming/ 에 이미지 드롭
#    <charId>__portrait.png / <charId>__full.png  (+ 선택 <charId>.json)
node design/characters/pipeline/ingest.mjs      # 3형태 산출 → out/<charId>/
node design/characters/pipeline/sheet.mjs       # 대조 시트 → contact-sheet.html
node design/characters/pipeline/shoot-sheet.mjs # 시트 PNG (playwright 필요, PLAYWRIGHT_PATH 로 경로 지정 가능)
# 2) 시트를 #104 에 올려 hero 승인 게이트
```

## refs/ 확보

레퍼 3장(ref-1 아바타 사다리 · ref-2 카드 프레임 · ref-3 스프라이트 간소화)은 **#103 UI 트랙이 `design/references/` 로 소유**한다.
중복 커밋을 피하려고 여기서는 gitignore 하고 사본만 로컬에 둔다. #103 이 main 에 머지되면 그쪽 경로를 직접 참조하도록 정리한다.

```bash
cp design/references/{ref-1.png,ref-2.png,ref-3-dot.png} design/characters/refs/
cp design/references/analysis/measurements.json design/characters/refs/measurements.ref103.json
```

## 원칙

- **캐릭터 디자인/창작 금지.** 품질 최종 판정 = hero.
- 팔레트·프레임 수치는 **#103 S1 tokens 확정 전 잠정치**(레퍼 실측). 확정되면 동기화.
- 파이프라인은 **결정론** — 난수·시각 의존 없음. 같은 입력 = 바이트 동일 산출.
  (단 **PNG 입력 경로만 보증**한다. jpg/webp 는 macOS 내장 `sips` 로 변환하므로 OS/버전 의존이다.)
- **배경 제거 임계는 자동으로 못 고른다.** 자동 선택을 5회 시도했고 지표마다 반례가 나왔다
  (PILOT-P2 §2). 값은 **사람이 정한다** — `incoming/<id>.json` 의 `bgTol`,
  `report.json` 의 `tolDiagnostic` 표를 보고 골라 대조 시트로 육안 확인.
  미지정이면 보수적으로 처리해 **배경이 남는다**(캐릭터를 먹느니 배경을 남긴다 = 실패가 눈에 보이게).
  투명 배경으로 입고하면 이 경로 자체를 안 탄다(SPEC §2).
- 한글 텍스트(이름/설명)는 파이프라인이 그리지 않는다 — 게임 UI 가 실제 폰트로 오버레이한다.

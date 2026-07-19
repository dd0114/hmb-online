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

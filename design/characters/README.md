# design/characters — 캐릭터 인테이크 파이프라인 (#104)

캐릭터 **원화는 hero 가 외부에서 생성**해 제공한다. 이 트랙은 **창작하지 않고** 변환·규격화·검수 게이트만 담당한다.

```
SPEC.md          입고 규격서 — hero 가 이미지 뽑을 때 보는 문서 (P0)
PILOT-P2.md      파일럿 결과 = 자동 도트화 품질 상한 실측 (P2)
contact-sheet.png 대조 시트 증빙 (hero 게이트 제출물)
pipeline/        인제스트 스크립트 (node, 외부 의존 0, 결정론)
  ingest.mjs       incoming/ → out/ 3형태 산출
  sheet.mjs        out/ → contact-sheet.html
  pilot-crop.mjs   레퍼에서 파일럿 입력 크롭 (파일럿 전용)
  lib/             png(코덱) · img(연산) · quantize(양자화) · card(프레임 합성)
refs/            레퍼 3장 사본 (gitignore — 아래 참조)
incoming/        hero 드롭 지점 (gitignore)
out/             산출물 (gitignore — 재생성 가능)
```

## 쓰는 법

```bash
# 1) hero 가 SPEC.md 규격대로 incoming/ 에 이미지 드롭
#    <charId>__portrait.png / <charId>__full.png  (+ 선택 <charId>.json)
node design/characters/pipeline/ingest.mjs      # 3형태 산출 → out/<charId>/
node design/characters/pipeline/sheet.mjs       # 대조 시트 → contact-sheet.html
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
- 한글 텍스트(이름/설명)는 파이프라인이 그리지 않는다 — 게임 UI 가 실제 폰트로 오버레이한다.

# 캐릭터 입고 규격서 (SPEC) — v0.1 (P0, hero 게이트 대기)

> **대상 = hero**. 외부 이미지 생성 도구(Midjourney / DALL·E / Nano Banana / SD 등)로 캐릭터 원화를 뽑을 때 **이 규격대로 뽑아 `design/characters/incoming/` 에 넣으면** 파이프라인이 3형태(아바타·카드·스프라이트)를 자동 산출한다.
>
> 근거 = 레퍼 3장(`refs/ref-1.png` 아바타 3단계+링 / `ref-2.png` 카드 프레임 / `ref-3-dot.png` 스프라이트 간소화) + #103 실측 팔레트(`refs/measurements.ref103.json`).
> ⚠️ 이 트랙은 **캐릭터를 창작하지 않는다** — 변환·규격화·검수만. 품질 최종 판정 = hero(#104 게이트).
> ⚠️ 팔레트·프레임 수치는 **#103 S1 tokens 확정 전 잠정치**(레퍼 실측). 확정되면 동기화한다.

---

## 0. 한 줄 요약

**PNG, 투명배경, 정사각 얼굴 1장 + 세로 전신 1장, 512px 이상, `<charId>__portrait.png` / `<charId>__full.png`.**
가능하면 **픽셀아트 스타일로 직접 생성**(§4 — 자동 도트화보다 품질 우위).

---

## 1. 산출 3형태 (파이프라인이 만드는 것 = 입고 이미지가 만족해야 할 용도)

| 형태 | 근거 레퍼 | 규격 | 입력 |
|---|---|---|---|
| **아바타** | ref-1 | 64×64 / 32×32 / 16×16 + 팀 링(원형크롭, stroke ≈ 지름의 4.5% → 정수 반올림으로 64:3px / 32:1px / 16:1px) — blue `#3da9f1` / red `#ef4f44` | `__portrait` |
| **카드** | ref-2 | 226×425 (1:1.88), 프레임 인셋 10px(금테 7px — ref-2 재실측), 아트 상단 ~78% + 네임플레이트/별/설명판 | `__full` |
| **스프라이트** | ref-3-dot | 원본 ~64 → 1단계 ~32 → 2단계 ~16 → 3단계 ~8 (픽셀·색 수 동시 축소, 실루엣+핵심컬러로 인식) | `__full` |

> 아바타 3단계(ref-1)와 스프라이트 4단계(ref-3)는 **다른 축**이다. 아바타=얼굴 크롭 사다리, 스프라이트=전신 간소화 사다리. 둘 다 필요 → 입고 이미지도 2장.

---

## 2. 입고 파일 규격 (필수)

| 항목 | 규격 | 이유 |
|---|---|---|
| 포맷 | **PNG 필수에 가깝다.** jpg/webp 도 받지만 macOS `sips` 경유라 결정론·이식성 미보증 | 무손실·알파 |
| 배경 | **완전 투명(알파 0) — 필수.** 불가 시 **캐릭터에 없는 단색**(#FF00FF 마젠타 등) + **경계는 안티에일리어싱 없는 하드 엣지** | 아래 ⚠️ 참조 |
| 최소 해상도 | portrait **512×512 이상 정사각**(정확히 1:1), full **512×1024 이상 세로 1:2**(허용 1:1.6~1:2.4) | 64px 다운스케일 시 8배 이상 확보 |
| 여백 | 캐릭터가 프레임의 **80~90%** 채우고 사방 5~10% 여백 | 크롭·링 적용 시 잘림 방지 |
| 그림자/글로우 | **바닥 그림자·외곽 글로우 없이**. 오라 이펙트는 카드 합성 단계에서 넣는다 | 배경 제거·실루엣 추출 오염 |
| 압축 | 업스케일러/후처리로 인한 뭉개짐·JPEG 아티팩트 금지 | 양자화 노이즈 |

> ⚠️ **왜 투명 배경인가.** 불투명 배경도 파이프라인이 자동 분리하지만, 분리 임계값이 **절벽**이다 —
> 낮으면 배경이 남고 조금만 넘으면 캐릭터의 어두운 머리·의상을 먹는다. 절벽 위치가 **소스마다 달라서**
> (P2 파일럿: 라그나 8, 아우라 6) 파이프라인이 매번 자동 탐색한다. 투명 배경이면 이 위험이 아예 없다.
> 또 AI 생성기는 대부분 경계에 안티에일리어싱을 넣는데, **단색 배경 + AA 는 캐릭터 외곽에 배경색 프린지**를 남긴다.

### 네이밍
```
<charId>__<variant>.png
```
- `charId` = 소문자 ASCII kebab-case, 캐릭터 고유 ID (예: `ragna`, `penguin-king`)
- `variant` ∈ `portrait` | `full`
- 예: `ragna__portrait.png`, `ragna__full.png`, `penguin-king__full.png`
- 구분자는 **언더스코어 2개**(`__`) — charId 안의 `-` 와 충돌 없게.
- 같은 charId 의 portrait/full 은 **같은 캐릭터·같은 의상·같은 색**이어야 한다(파이프라인은 두 장을 대조하지 않는다).

### 함께 넣으면 좋은 것 (선택)
`incoming/<charId>.json` — 없으면 파이프라인이 기본값으로 채운다.
```json
{
  "id": "ragna",
  "name": "라그나",
  "title": "불꽃의 스트라이커",
  "position": "FW",
  "stars": 5,
  "signature": "#f7a051",
  "frame": "#c82813",
  "desc": "차원을 가르는 강슛, 필드 전체에 볼을 지핀다."
}
```
- `position` ∈ `FW`(빨강) `MF`(초록) `DF`(파랑) `GK`(금) — **ref-2 legend 채택**(축구 관례). ref-3 badge 는 MF/DF 가 뒤집혀 있어 conflict, hero 확인 전엔 ref-2 기준.
- `signature`/`frame` 미지정 시 파이프라인이 아트에서 지배색을 추출해 채운다. **다만 자동 추출은 "면적이 가장 넓은 채도색"이라 테마색과 어긋날 수 있다**(파일럿: 펭킹킹→빨간 망토 `#c03025`, 테마는 빙하 `#326e8a`). → **명시 권장**, 자동은 폴백.

---

## 3. 구도 (composition)

### `__portrait` — 얼굴/상반신, 정사각
- **정면**, 시선 정면. 얼굴이 프레임의 **55~70%**.
- 크롭 범위 = 머리 장식(뿔·후광·모자·귀) 위 끝 ~ **가슴 위**. 어깨는 살짝 보이는 정도.
- 목/머리 기울기 최소, 좌우 대칭에 가깝게 → 16×16 에서도 실루엣이 살아남는다.
- **머리 장식이 캐릭터 식별자**(ref-1 에서 뿔/후광/왕관/모자로 구분됨) → 절대 잘리지 않게.

### `__full` — 전신, 세로 1:2
- **정면 액션 포즈 1개** (달리기/슛 준비 — ref-2·3 처럼).
- 발끝~머리끝 전부 포함, 캐릭터가 세로의 **85~90%**.
- **축구공을 발 근처에 1개** 포함(ref-2·3 전 카드 공통). 공이 캐릭터를 가리지 않게.
- 팔다리가 몸통에 붙어 실루엣이 뭉개지지 않게 — 8×8 까지 내려가도 형태가 남아야 한다.

---

## 4. 생성 방식 — **A안(픽셀아트 직접 생성) 권장**

자동 도트화(고해상도 원화 → 다운스케일 + 팔레트 양자화)는 **품질 상한이 있다**: 얼굴 디테일이 뭉개지고, 픽셀 격자가 정렬되지 않아 "저해상도 그림"이 되지 손으로 찍은 도트가 안 된다. 레퍼 3장은 전부 **픽셀아트로 직접 생성된** 결과물이다.

- **A안 (권장)**: 처음부터 픽셀아트 스타일로 생성 → 파이프라인은 **배경정리 + 리사이즈 + 단계별 색 축소**만 담당(변환 손실 최소).
- **B안 (대안)**: 일반 일러스트 생성 → 파이프라인이 도트화.

> **P2 파일럿 실측 결과(`PILOT-P2.md`, 2026-07-20)**: **32px 이상 + 카드는 자동 변환으로 충분**하다.
> **≤16px 은 소스에 따라 갈린다** — 굵은 실루엣·고대비(펭킹킹)는 16px 에서 살아남고, 섬세한 얼굴(아우라)은 무너진다.
> 전신 스프라이트는 ≤16px 에서 실패한다. 결정 변수는 해상도가 아니라 **실루엣 단순성과 색 대비**다.
> → **A안 권장**(저해상까지 신뢰하려면 직접 생성이 안전). 저해상 단계는 hero 손보정 슬롯 검토 중. hero 판정 대기(#104).

### 프롬프트 템플릿 (A안)

```
pixel art character sprite, 64x64 pixel grid, {CHARACTER}, football/soccer player,
front-facing {POSE}, fantasy {THEME} theme, {SIGNATURE_COLOR} accent,
limited palette (16-24 colors), crisp hard pixel edges, no anti-aliasing,
clean silhouette, transparent background, no ground shadow, no glow,
centered, full body visible, game asset sheet style
--no blur, gradient, photorealistic, text, watermark, background scenery
```
- `{POSE}` = portrait 는 `bust portrait, head and shoulders` / full 은 `dynamic running pose with a soccer ball at the feet`
- portrait 은 `64x64 pixel grid` → `48x48 pixel grid, bust portrait` 로 바꾸면 얼굴 밀도가 올라간다.
- 출력이 512px 이상으로 나오게(도구가 업스케일해도 **nearest-neighbor** 여야 함 — 흐릿하게 늘리면 규격 위반).

### 프롬프트 템플릿 (B안 — 일반 일러스트)

```
2D game character illustration, {CHARACTER}, football/soccer player,
front-facing {POSE}, fantasy {THEME} theme, {SIGNATURE_COLOR} accent,
bold flat shapes, high contrast, strong readable silhouette,
few color regions, clean cel shading, transparent background,
no ground shadow, no glow, no background scenery, centered
```
- 도트화 전제이므로 **면 단위 명암·굵은 실루엣**이 핵심. 부드러운 그라디언트·머리카락 한 올·미세 무늬는 64px 에서 전부 사라진다.

### 스타일 앵커 (레퍼 3장 공통)
- 어두운 배경 위에서 읽히는 **채도 높은 캐릭터 컬러** + 골드 악센트.
- 캐릭터당 **시그니처 색 1개**로 통일(프레임·오라·아이콘 전부 같은 hue — ref-2 규칙). 이건 **장식 축이지 게임 속성 축이 아니다**(hero 정정).
- 판타지 스킨: 수인/천사/악마/마녀/펭귄왕 등 — 실선수 이름·얼굴 사용 금지.

---

## 5. 잠정 팔레트 (레퍼 실측 — #103 S1 확정 시 동기화)

| 용도 | hex |
|---|---|
| 배경 root | `#0b1117` |
| 서피스 | `#111a1c` / `#151d1f` / `#1a2023` |
| 골드 hi / 본색 / deep | `#ffdb4a` / `#e4991c` / `#8b6227` |
| 별 채움 / 카드 이름 | `#d9a01e` / `#f8e8a0` |
| 텍스트 primary / secondary / muted | `#e0d8cf` / `#a7a090` / `#7f7e79` |
| 팀 링 blue / red | `#3da9f1` / `#ef4f44` |
| FW / MF / DF / GK | `#f17869` / `#57b775` / `#0b90d8` / `#fce148` |

전체 실측치 = `refs/measurements.ref103.json`.

---

## 6. 체크리스트 (입고 전 hero 자가확인)

- [ ] PNG, 배경 투명(또는 단색 마젠타/화이트)
- [ ] portrait 정사각 512+ / full 세로 512×1024+
- [ ] 머리 장식 안 잘림, 사방 여백 5~10%
- [ ] full 에 축구공 1개, 정면 액션 포즈
- [ ] 바닥 그림자·외곽 글로우 없음
- [ ] 파일명 `<charId>__portrait.png` / `<charId>__full.png`
- [ ] (선택) `<charId>.json` 메타

---

## 7. 입고 후 흐름

```
incoming/ 드롭
  → node design/characters/pipeline/ingest.mjs        (배경정리→도트화→3형태 산출)
  → design/characters/out/<charId>/                    (아바타·카드·스프라이트)
  → design/characters/contact-sheet.html               (원본 vs 산출 대조)
  → #104 에 시트 제출 → hero 승인 게이트
  → 승인분만 players.v3 데이터 웨이브에 캐릭터 ID 매핑 (매니저 발주)
```

## 변경 이력
- v0.1 (2026-07-20) 최초 — 레퍼 3장 + #103 실측 팔레트 기반. hero 게이트 미통과(초안).

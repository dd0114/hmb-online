#!/usr/bin/env python3
"""
slice-units.py — hero 입고 유닛 아트(레전더리 5종 + 디폴트 유닛) 슬라이스·발행 (#207 W3-B)

    python3 design/characters/pipeline/slice-units.py            # → design/characters/dist/units/
    UNITS_SRC=/path/to/imageRef python3 .../slice-units.py       # 원본 위치 오버라이드

왜 python 인가: 기존 pipeline(*.mjs)은 외부 의존 0 원칙이라 자체 PNG 코덱을 쓰는데, 입고분은
1024×1536 풀컬러 일러스트라 리샘플·알파 합성·양자화가 필요하다(자체 코덱엔 없음). 그래서 이
슬라이스 단계만 PIL 을 쓰고, **산출물은 기존 dist 규약(아틀라스 + manifest)에 맞춰** 낸다.

⚠️ 원본은 리포 밖(hero 데스크탑)에 있고 **읽기 전용**이다 — 이 스크립트는 원본을 수정·이동하지
   않는다. 원본이 갱신되면 같은 좌표로 다시 돌린다(수작업 1회성 크롭 금지 = 좌표가 여기 박혀 있다).

결정론: 난수·시각 의존 0(양자화도 MEDIANCUT 고정). 같은 입력 + 같은 Pillow 버전이면 같은 산출.
        리샘플/양자화 커널은 Pillow 구현에 의존하므로 **바이트 동일은 버전 고정 시**에만 보장된다.
"""
import json
import os
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow + numpy 가 필요하다: python3 -m pip install Pillow numpy")

REPO = Path(__file__).resolve().parents[3]
DIST = REPO / "design" / "characters" / "dist" / "units"
SRC = Path(os.environ.get("UNITS_SRC", Path.home() / "Desktop" / "imageRef"))

LEGEND_DIR = SRC / "레전더리"
NORMAL_DIR = SRC / "노말유닛"

# ── 발행 규격 (결정 근거는 README §units) ────────────────────────────────────
CARD_W, CARD_H = 512, 768    # 2:3 — 입고 원본 1024×1536 의 정확히 1/2
CARD_COLORS = 256            # 완성 카드(`complete`)만 팔레트 양자화. 현재 발행 구성엔 complete 가
                             # **0종**이라 이 경로는 안 돌지만, 발행측이 언제든 complete 를 다시
                             # 실을 수 있으므로 지운 게 아니라 남겨 둔다(소비측 분기와 같은 이유).
FACE_MASTER = 256            # 개별 얼굴 마스터(고DPI용). 픽셀아트는 원본 해상도 유지.
AVATAR_SIZES = (64, 32, 16)  # 아틀라스 타일 — 기존 characters 축과 동일 계약
ATLAS_COLS = 3
ICON_BG = (10, 10, 10, 255)  # 레전더리 얼굴 타일 배경(글로우·수염이 어두운 배경 전제로 그려져 있다)

# 프레임리스 아트 정렬 밴드(--verify). 아트 창을 그대로 채우는 축이라 인물 바운딩박스가 튀면
# 한 장만 크거나 붕 떠 보인다 — 그리드에 나란히 놓기 전에 발행기가 스스로 잡는다.
#
# ⚠️ **가로는 절대 가장자리로 재지 않는다**(3차 입고에서 고침). 구 밴드는 `left_max`/`right_min`
#    으로 "팔이 좌우 끝까지 뻗었나"를 봤는데, 그건 정렬이 아니라 **포즈**다. 석다이크(차렷·양손
#    허리)가 L21.7/R79.5 로 걸렸지만 8종을 나란히 렌더해 보면 머리끝·발끝이 남들과 같은 선에
#    있다 — 즉 구 밴드는 "모든 아트는 팔을 벌려야 한다"를 강요하던 오탐이었다(좌표만 보고
#    판정 금지, 루트 CLAUDE.md §2-2 — 실제로 그리드를 눈으로 보고 내린 결론).
#    대신 그리드 정렬을 실제로 지배하는 축만 남긴다:
#      세로  머리끝(top)·발끝(bottom)·세로점유율 → 줄이 맞는지
#      가로  바운딩박스 **중심**(치우쳤는지) + 가로점유율 하한(조각만 남았는지)
#    값은 8종 실측 범위(T 2.7~7.7 · B 84.0~94.8 · cx 49.8~55.7 · vcov 80.1~90.1 · hcov 57.8~83.0)
#    에 여유를 준 것이다. 세로 점유율 하한은 0.55 → 0.72 로 **조인다** — 가로 완화의 반대급부로
#    "축소돼 붕 뜬 아트" 검출력을 오히려 올린다(변이체 킬로 확인).
ART_BBOX_BAND = {"top_max": 10.0, "bottom_min": 83.0, "center_x": 50.0, "center_tol": 8.0}
ART_MIN_COVER = 0.72         # 인물 세로 점유율 하한 — 축소돼 붕 뜬 아트를 잡는다
ART_MIN_HCOVER = 0.45        # 가로 점유율 하한 — 조각만 남은(잘린) 아트를 잡는다

# ── 크롭 좌표 (원본 픽셀 기준, 좌상단 원점, (x0,y0,x1,y1) 반열린 구간) ────────
#
# 시트 2장은 격자가 아니라 손배치라 **실측 좌표**를 박는다. 각 좌표는
# 크롭 → PNG 저장 → 눈으로 확인 → 조정 루프로 확정했다(좌표 추론 금지 규율, 루트 CLAUDE.md §2-2).
CROPS = {
    # 욱링엄 시트 우측 상단 64px 얼굴(고양이 두상). 수염 끝까지 포함하고
    # "64px" 라벨(y132~157)·32px 얼굴(x≥1087) 은 제외. 정사각이 아니라 내용 박스(아래에서 중앙 정사각화).
    "wookringham_face": (809, 162, 1086, 386),
    # 노말유닛 시트(1448×1086) '선정된 기본 스킨' 블록.
    "default_full": (37, 468, 176, 669),   # 전신(공 포함)
    "default_face": (191, 469, 314, 601),  # 64px 얼굴
}

# ── 유닛 정의 ───────────────────────────────────────────────────────────────
# id = 발행 식별자(파일명·manifest 키). forPlayer/forGrades 는 **발행측 힌트**(기존 manifest 의
# variant forPlayer 와 같은 성격) — 권위 매핑은 data/players 의 player-chars 발행물이 소유한다.
UNITS = [
    {
        # 재발행(#207 hero 2차 입고). 구 `보날두-카드.png`(완성 카드)·`보날두-아이콘.png`(시트)는
        # **더 이상 쓰지 않는다** — 구워진 99/★ 가 실데이터(OVR·성★)와 어긋났고 종횡비도 튀었다.
        # 새 입고분은 프레임리스 아트 + 단독 정면 초상(글로우 없음 → 16px 가독성 해소)이다.
        "id": "bonaldo", "name": "보날두", "position": "FW", "forPlayer": "P173",
        "card": {"src": LEGEND_DIR / "보날두2.png", "kind": "frameless-art"},
        "face": {"src": LEGEND_DIR / "보날두-아이콘2.png"},
    },
    {
        "id": "yeoldona", "name": "열라도나", "position": "MF", "forPlayer": "P175",
        "card": {"src": LEGEND_DIR / "열라도나.png", "kind": "frameless-art"},
        "face": {"src": LEGEND_DIR / "열라도나 아이콘.png"},
    },
    {
        "id": "chunbappe", "name": "춘바페", "position": "FW", "forPlayer": "P176",
        "card": {"src": LEGEND_DIR / "춘바페.png", "kind": "frameless-art"},
        "face": {"src": LEGEND_DIR / "춘바페-아이콘.png"},
    },
    {
        "id": "dukbrayner", "name": "덕브라이너", "position": "MF", "forPlayer": "P177",
        "card": {"src": LEGEND_DIR / "덕브라이너.png", "kind": "frameless-art"},
        "face": {"src": LEGEND_DIR / "덕브라이너-아이콘.png"},
    },
    {
        # 카드만 재발행(#207 hero 2차 입고) — 구 시트 좌측의 완성 카드 대신 프레임리스 아트.
        # ⚠️ **얼굴은 시트 크롭 그대로 유지한다.** 2차 입고의 `욱링엄-아이콘2.png` 는 112×112(규격
        #    미달)에다 유니폼에 레알 크레스트·adidas 로고가 남아 있다(새 카드에서는 지워진 것).
        #    기존 발행물이 더 낫다 = 세션이 눈으로 확인하고 내린 결정. 원본을 바꾸지 않는다.
        "id": "wookringham", "name": "욱링엄", "position": "MF", "forPlayer": "P179",
        "card": {"src": LEGEND_DIR / "욱링엄-카드2.png", "kind": "frameless-art"},
        "face": {"src": LEGEND_DIR / "욱링엄 카드, 아이콘.png", "crop": "wookringham_face"},
    },
    {
        # 디폴트 유닛 — GOLD/SILVER/BRONZE 공용(U-D8). 픽셀아트라 **원본 해상도 그대로** 발행한다
        # (업스케일하면 도트가 뭉개진다 — 확대는 CSS image-rendering:pixelated 담당).
        "id": "default-unit", "name": "기본 유닛", "position": None,
        "forGrades": ["GOLD", "SILVER", "BRONZE"],
        "card": {"src": NORMAL_DIR / "노말유닛.png", "crop": "default_full",
                 "kind": "frameless-art", "pixelArt": True, "navyKey": True},
        "face": {"src": NORMAL_DIR / "노말유닛.png", "crop": "default_face",
                 "pixelArt": True, "navyKey": True},
    },
    # ── 3차 입고(2026-07-29) — 신규 LEGEND 2종 ───────────────────────────────
    # ⚠️ **배열 맨 끝에 append 한다**(중간 삽입 금지). index → col/row 라서 중간에 끼우면 기존
    #    유닛의 아틀라스 타일 좌표가 전부 밀린다. 매니페스트가 권위라 기능은 안 깨지지만,
    #    캐시된 구 매니페스트 + 새 아틀라스 조합에서 **얼굴이 뒤바뀐다**. data/roster.ts 의
    #    append 규율(grade-mapping-v2 §9.5)과 같은 이유다.
    {
        # 단독 입고(1024×1536 카드 + 1024² 정면 초상) — 2차 입고 보날두와 동일 규격이라 크롭 없음.
        "id": "kyeongnicius", "name": "경니시우스", "position": "FW", "forPlayer": "P180",
        "card": {"src": LEGEND_DIR / "경니시우스.png", "kind": "frameless-art"},
        "face": {"src": LEGEND_DIR / "경니시우스-아이콘.png"},
    },
    {
        # ⚠️ `forPlayer` 없음 — **카탈로그에 대응 선수가 없다.** hero 원안(#207 AC1)의 석다이크(판
        #    다이크·DF)는 U-D4 확정에서 석신(야신·GK)으로 대체돼 P번호를 못 받았다. 아트는 오렌지
        #    킷 필드플레이어라 GK 인 석신에 붙일 수 없다. 채번은 data 축 결정이라 여기서 안 한다
        #    (발행측 힌트일 뿐 권위는 player-chars — manifest mappingHint). 상세 = 세션 보고.
        #
        #    `pendingCatalog` = **"아직 매핑될 선수가 없다"를 발행물에 명시**하는 선언이다.
        #    매핑측 계약 "놀고 있는 유닛 0"(chars-map.test.ts)은 이 플래그가 붙은 유닛만 면제한다 —
        #    침묵으로 빠져나가는 게 아니라 **의도를 적고 나머지 누락은 계속 잡힌다**(data 측
        #    UNMAPPED_LEGENDS 와 같은 형상). 채번이 끝나면 이 줄을 지우고 forPlayer 를 다는 것이
        #    해제 신호다.
        "id": "seokdijk", "name": "석다이크", "position": "DF", "pendingCatalog": True,
        "card": {"src": LEGEND_DIR / "석다이크.png", "kind": "frameless-art"},
        "face": {"src": LEGEND_DIR / "석다이크-아이콘.png"},
    },
]


# ── 이미지 유틸 ─────────────────────────────────────────────────────────────
def load(path: Path) -> Image.Image:
    if not path.exists():
        sys.exit(f"원본이 없다: {path}\n  UNITS_SRC 로 imageRef 위치를 지정해라.")
    return Image.open(path).convert("RGBA")


def resize_rgba(im: Image.Image, size, resample=Image.LANCZOS) -> Image.Image:
    """
    알파 **프리멀티플라이** 후 리샘플하고 되돌린다.

    왜: 입고분(열라도나·춘바페·덕브라이너)은 alpha=0 픽셀의 RGB 가 검정이 아니라 **회색 비네트**다.
    프리멀티플라이 없이 축소하면 그 회색이 가장자리로 번져 캐릭터 외곽에 회색 후광이 생긴다.
    """
    if im.size == tuple(size):
        return im.copy()
    a = np.asarray(im).astype(np.float64)
    al = a[..., 3:4] / 255.0
    prem = np.concatenate([a[..., :3] * al, a[..., 3:4]], axis=2)
    out = np.asarray(
        Image.fromarray(prem.round().clip(0, 255).astype("uint8"), "RGBA").resize(tuple(size), resample)
    ).astype(np.float64)
    oa = out[..., 3:4]
    rgb = np.where(oa > 0, out[..., :3] * 255.0 / np.maximum(oa, 1e-6), 0)
    return Image.fromarray(np.concatenate([rgb, oa], axis=2).round().clip(0, 255).astype("uint8"), "RGBA")


def navy_key(im: Image.Image, dmin: int = 9, cap: int = 64) -> Image.Image:
    """
    노말유닛 시트의 **남색 패널 배경만** 투명화.

    왜 단순 색키/플러드필이 아닌가: 배경(≈#001320)이 캐릭터의 검은 아웃라인·검은 반바지와
    **명도가 겹친다.** 색거리 임계로는 머리카락이, 플러드필로는 노이즈를 타고 캐릭터 내부까지
    먹힌다(둘 다 실측으로 확인). 대신 배경은 **파랑이 빨강보다 확실히 크고 어둡다**는 성질이
    캐릭터(피부·갈색머리·검정)와 갈린다 — 파란 셔츠/양말은 밝아서 cap 으로 걸러진다.
    """
    a = np.asarray(im).astype(int)
    mask = ((a[..., 2] - a[..., 0]) >= dmin) & (a[..., :3].max(axis=2) <= cap)
    a[..., 3] = np.where(mask, 0, 255)
    return Image.fromarray(a.astype("uint8"), "RGBA")


def on_bg(im: Image.Image, bg=ICON_BG) -> Image.Image:
    base = Image.new("RGBA", im.size, bg)
    base.alpha_composite(im)
    return base


def square(im: Image.Image, bg=(0, 0, 0, 0)) -> Image.Image:
    s = max(im.size)
    out = Image.new("RGBA", (s, s), bg)
    out.paste(im, ((s - im.width) // 2, (s - im.height) // 2))
    return out


def pad_to_aspect(im: Image.Image, ratio: float, bg=(0, 0, 0, 255)) -> Image.Image:
    """종횡비 정규화는 **레터박스로만** — 크롭하면 카드 프레임이 잘린다."""
    w, h = im.size
    tw, th = (w, round(w / ratio)) if w / h > ratio else (round(h * ratio), h)
    if (tw, th) == (w, h):
        return im.copy()
    out = Image.new("RGBA", (tw, th), bg)
    out.paste(im, ((tw - w) // 2, (th - h) // 2))
    return out


def save(path: Path, im: Image.Image, quantize: bool = False) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    if quantize:
        # 완성 카드는 불투명이라 팔레트 양자화가 안전하다(알파가 있는 아트는 tRNS 로 표현이 안 돼 제외).
        im.convert("RGB").quantize(colors=CARD_COLORS, method=Image.MEDIANCUT,
                                   dither=Image.FLOYDSTEINBERG).save(path, "PNG", optimize=True)
    else:
        im.save(path, "PNG", optimize=True)
    return path.stat().st_size


# ── 산출 ────────────────────────────────────────────────────────────────────
def build() -> None:
    if DIST.exists():
        for p in sorted(DIST.iterdir()):
            p.unlink()
    entries, faces, log = {}, [], []

    for i, u in enumerate(UNITS):
        # ── 카드 / 프레임리스 아트 ──
        c = u["card"]
        im = load(c["src"])
        if "crop" in c:
            im = im.crop(CROPS[c["crop"]])
        raw = im.size
        if c.get("navyKey"):
            im = navy_key(im)
        complete = c["kind"] == "complete"
        # 레터박스 배경: 완성 카드는 불투명(양자화 대상)이라 검정, 프레임리스 아트는 **투명**이어야
        # 한다 — 검정으로 깔면 등급 프레임 위에 얹을 때 검은 띠가 남는다. (2:3 입고분은 no-op.)
        pad_bg = (0, 0, 0, 255) if complete else (0, 0, 0, 0)
        card = im if c.get("pixelArt") else resize_rgba(
            pad_to_aspect(im, CARD_W / CARD_H, pad_bg), (CARD_W, CARD_H))
        card_file = f"{'card' if complete else 'art'}-{u['id']}.png"
        n = save(DIST / card_file, card, quantize=complete)
        log.append(f"  {card_file:26s} {raw[0]}×{raw[1]} → {card.size[0]}×{card.size[1]}  {n // 1024:4d}KB  [{c['kind']}]")

        # ── 얼굴 마스터 ──
        f = u["face"]
        fim = load(f["src"])
        if "crop" in f:
            fim = fim.crop(CROPS[f["crop"]])
        fraw = fim.size
        if f.get("navyKey"):
            fim = navy_key(fim)
            fim = square(fim)
            icon_bg = "transparent"
        else:
            fim = on_bg(square(fim, ICON_BG))
            icon_bg = "opaque-dark"
        master = fim if f.get("pixelArt") else resize_rgba(fim, (FACE_MASTER, FACE_MASTER))
        face_file = f"face-{u['id']}.png"
        n = save(DIST / face_file, master)
        log.append(f"  {face_file:26s} {fraw[0]}×{fraw[1]} → {master.size[0]}×{master.size[1]}  {n // 1024:4d}KB  [{icon_bg}]")
        faces.append((master, f.get("pixelArt", False)))

        entries[u["id"]] = {
            "index": i,
            "name": u["name"],
            "position": u["position"],
            # ⚠️ **객체다**(기존 characters 축의 card 는 문자열). 갱신 전 소비자가 문자열로 읽으면
            # assetUrl 이 null 을 돌려 폴백으로 떨어진다 = fail-safe. 신규 소비자는 kind 로 분기한다.
            "card": {
                "file": f"units/{card_file}",
                "kind": c["kind"],
                "w": card.size[0], "h": card.size[1],
                **({"pixelArt": True} if c.get("pixelArt") else {}),
            },
            "face": f"units/{face_file}",
            "faceSize": {"w": master.size[0], "h": master.size[1]},
            "iconBackground": icon_bg,
            **({"forPlayer": u["forPlayer"]} if u.get("forPlayer") else {}),
            **({"forGrades": u["forGrades"]} if u.get("forGrades") else {}),
            # 아트는 발행됐지만 붙일 선수가 아직 카탈로그에 없다(위 주석). 매핑측 면제 선언.
            **({"pendingCatalog": True} if u.get("pendingCatalog") else {}),
        }

    # ── 아틀라스(기존 characters 축과 동일 규약: 정사각 타일 격자) ──
    rows = -(-len(faces) // ATLAS_COLS)
    atlases = {}
    for size in AVATAR_SIZES:
        sheet = Image.new("RGBA", (ATLAS_COLS * size, rows * size), (0, 0, 0, 0))
        for i, (fim, pixel_art) in enumerate(faces):
            tile = resize_rgba(fim, (size, size), Image.BOX if pixel_art else Image.LANCZOS)
            sheet.paste(tile, ((i % ATLAS_COLS) * size, (i // ATLAS_COLS) * size))
        n = save(DIST / f"avatars-{size}.png", sheet)
        atlases[f"avatars-{size}"] = {"file": f"units/avatars-{size}.png", "tile": size,
                                      "cols": ATLAS_COLS, "rows": rows}
        log.append(f"  avatars-{size}.png{'':11s} {ATLAS_COLS * size}×{rows * size}  {n // 1024:4d}KB")
    for e in entries.values():
        e["col"] = e["index"] % ATLAS_COLS
        e["row"] = e["index"] // ATLAS_COLS

    manifest = {
        "version": 1,
        "kind": "units",
        "note": (
            "hero 입고 유닛 아트(#207 U-D5~U-D9). LEGEND 활성 5종 = 유닛별 고유 실아트, "
            "'default-unit' = GOLD/SILVER/BRONZE 공용 기본 스킨. 기존 characters/placeholder 축과 "
            "**합치지 않는다** — 별도 manifest·별도 아틀라스(축 분리는 #121 발행 계약). "
            "2차 입고(#207 재발행): 보날두·욱링엄이 완성 카드 → 프레임리스 아트로 바뀌어 "
            "현재 `complete` 은 **0종**이다(구워진 숫자·별이 실데이터와 어긋나던 문제와 종횡비 "
            "불일치가 같이 사라진다). `cardKinds.complete` 선언은 남는다 — 발행측이 언제든 다시 "
            "실을 수 있고, 그게 소비측의 '프레임 두 겹 방지' 계약이다."
        ),
        "source": "hero-imageRef-2026-07-29-rev3",
        "count": len(entries),
        # 소비측 분기 계약 — units[id].card.kind 로 갈린다.
        "cardKinds": {
            "complete": "프레임·이름판·포지션뱃지·별·대사가 **이미 구워진 완성 카드**. "
                        "frame-<GRADE>.png 합성 경로를 타지 않는다(그대로 그린다).",
            "frameless-art": "프레임 없는 캐릭터 아트(투명 배경). 기존 합성 경로"
                             "(frame-<GRADE>.png 위에 아트를 얹기)를 그대로 쓴다.",
        },
        "mappingHint": (
            "forPlayer/forGrades 는 **발행측 힌트**다(기존 characters 축의 variant forPlayer 와 같은 성격). "
            "권위 매핑은 data/players 의 player-chars 발행물이 소유한다 — 힌트와 어긋나면 매핑이 이긴다. "
            "`pendingCatalog:true` = 아트는 발행됐지만 **붙일 선수가 아직 카탈로그에 없다**(채번 대기). "
            "매핑측의 '놀고 있는 유닛 0' 계약은 이 플래그가 붙은 유닛만 면제한다 — 침묵이 아니라 선언이다."
        ),
        "atlases": atlases,
        "units": entries,
    }
    (DIST / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"✓ 유닛 에셋 {len(entries)}종 → design/characters/dist/units/")
    print("\n".join(log))


def alpha_bbox_pct(im: Image.Image):
    """알파가 있는 픽셀의 바운딩박스를 카드 크기 대비 % 로. 완전 불투명이면 None."""
    a = np.asarray(im.convert("RGBA"))
    if a[..., 3].min() == 255:
        return None
    mask = a[..., 3] > 8
    if not mask.any():
        return (0.0, 0.0, 0.0, 0.0)
    ys, xs = np.where(mask)
    h, w = a.shape[0], a.shape[1]
    return (xs.min() / w * 100, ys.min() / h * 100, (xs.max() + 1) / w * 100, (ys.max() + 1) / h * 100)


def verify_card_pixels(root: Path, uid: str, card: dict) -> list:
    """
    카드 픽셀 자체의 계약 — manifest 가 맞아도 그림이 틀릴 수 있는 부분.

      complete       프레임이 구워진 통짜 = **불투명**이어야 한다(투명하면 합성 우회가 무의미).
      frameless-art  등급 프레임 위에 얹으므로 **투명 배경이 살아 있어야** 하고, 인물이
                     ART_BBOX_BAND 안에 들어와야 한다(한 장만 크거나 붕 뜨는 것 방지).
    픽셀아트(디폴트 유닛)는 원본 해상도 그대로 발행하는 별도 축이라 밴드에서 제외한다.
    """
    p = root / card["file"]
    if not p.exists():
        return []
    im = Image.open(p)
    box = alpha_bbox_pct(im)
    if card["kind"] == "complete":
        return [] if box is None else [f"{uid}: complete 인데 투명 픽셀이 있다(통짜 카드가 아니다)"]
    if box is None:
        return [f"{uid}: frameless-art 인데 알파가 없다(불투명 발행 = 프레임 위에 사각형이 얹힌다)"]
    if card.get("pixelArt"):
        return []
    l, t, r, b = box
    band, errs = ART_BBOX_BAND, []
    # 세로 = 그리드 줄맞춤(머리끝·발끝). 여기가 틀리면 한 장만 위/아래로 떠 보인다.
    if t > band["top_max"] or b < band["bottom_min"]:
        errs.append(f"{uid}: 세로 정렬이 밴드 밖 T{t:.1f} B{b:.1f} "
                    f"(top≤{band['top_max']} · bottom≥{band['bottom_min']})")
    # 가로 = 중심만 본다(폭은 포즈다 — 위 주석 참조).
    cx = (l + r) / 2
    if abs(cx - band["center_x"]) > band["center_tol"]:
        errs.append(f"{uid}: 인물이 가로로 치우쳤다 중심 {cx:.1f}% "
                    f"(기준 {band['center_x']}±{band['center_tol']})")
    if (b - t) / 100 < ART_MIN_COVER:
        errs.append(f"{uid}: 인물 세로 점유율 {(b - t):.1f}% < {ART_MIN_COVER * 100:.0f}%")
    if (r - l) / 100 < ART_MIN_HCOVER:
        errs.append(f"{uid}: 인물 가로 점유율 {(r - l):.1f}% < {ART_MIN_HCOVER * 100:.0f}%")
    return errs


def verify() -> int:
    """
    발행물 자기검증 — manifest 가 실제 파일과 어긋나지 않는지.

    왜 스크립트 안인가: 루트 vitest include 가 `design/**` 을 안 잡는다(= 여기 테스트를 둬도
    게이트에서 안 돈다). 계약을 빈 채로 두느니 발행기가 스스로 검사하게 한다.
        python3 design/characters/pipeline/slice-units.py --verify
    """
    m = json.loads((DIST / "manifest.json").read_text(encoding="utf-8"))
    root = DIST.parent
    errs = []
    if m.get("kind") != "units":
        errs.append(f"kind 가 units 가 아니다: {m.get('kind')}")
    if m.get("count") != len(m["units"]):
        errs.append(f"count({m.get('count')}) != units 수({len(m['units'])})")

    for name, spec in m["atlases"].items():
        p = root / spec["file"]
        if not p.exists():
            errs.append(f"아틀라스 없음: {spec['file']}")
            continue
        want = (spec["cols"] * spec["tile"], spec["rows"] * spec["tile"])
        got = Image.open(p).size
        if got != want:
            errs.append(f"{name} 크기 불일치: {got} != {want}")

    cols = m["atlases"]["avatars-64"]["cols"]
    kinds = set(m["cardKinds"])
    seen = set()
    for uid, u in m["units"].items():
        card = u["card"]
        if not isinstance(card, dict):
            errs.append(f"{uid}: card 는 객체여야 한다(구 소비자 fail-safe 계약)")
            continue
        if card["kind"] not in kinds:
            errs.append(f"{uid}: 미선언 card.kind={card['kind']}")
        # 파일명 접두어가 kind 와 어긋나면 안 된다 — `card-*`(완성) vs `art-*`(프레임리스).
        # 재발행으로 kind 만 바꾸고 파일명을 못 따라간 상태(= 소비측이 이름으로 오해)를 잡는다.
        want_prefix = "card-" if card["kind"] == "complete" else "art-"
        if not Path(card["file"]).name.startswith(want_prefix):
            errs.append(f"{uid}: kind={card['kind']} 인데 파일명이 {want_prefix}* 가 아니다({card['file']})")
        for rel, key in ((card["file"], "card"), (u["face"], "face")):
            p = root / rel
            if not p.exists():
                errs.append(f"{uid}: {key} 파일 없음 {rel}")
                continue
            got = Image.open(p).size
            want = (card["w"], card["h"]) if key == "card" else (u["faceSize"]["w"], u["faceSize"]["h"])
            if got != want:
                errs.append(f"{uid}: {key} 크기 불일치 {got} != {want}")
        # 채번 대기와 채번 완료는 **동시에 참일 수 없다** — 둘 다 붙으면 매핑측 면제와 힌트가
        # 서로 모순되고, 면제가 이겨서 "붙었는데 안 쓰이는" 유닛이 조용히 생긴다.
        if u.get("pendingCatalog") and u.get("forPlayer"):
            errs.append(f"{uid}: pendingCatalog 와 forPlayer 가 동시에 있다(채번이 끝났으면 플래그를 지워라)")
        errs += verify_card_pixels(root, uid, card)
        if (u["col"], u["row"]) != (u["index"] % cols, u["index"] // cols):
            errs.append(f"{uid}: col/row 가 index 와 어긋난다")
        if (u["index"], uid) in seen:
            errs.append(f"{uid}: index 중복")
        seen.add((u["index"], uid))
    referenced = {a["file"] for a in m["atlases"].values()}
    for u in m["units"].values():
        referenced.add(u.get("face"))
        c = u.get("card")
        referenced.add(c["file"] if isinstance(c, dict) else c)
    for p in sorted(DIST.glob("*.png")):
        if f"units/{p.name}" not in referenced:
            errs.append(f"manifest 에 없는 발행 파일: units/{p.name}")

    total = sum(p.stat().st_size for p in DIST.iterdir())
    if errs:
        print("✗ verify FAIL")
        print("\n".join(f"  - {e}" for e in errs))
        return 1
    by_kind = {}
    for u in m["units"].values():
        by_kind[u["card"]["kind"]] = by_kind.get(u["card"]["kind"], 0) + 1
    print(f"✓ verify PASS — 유닛 {len(m['units'])}종 · 아틀라스 {len(m['atlases'])} · "
          f"파일 {len(list(DIST.iterdir()))}개 · {total // 1024}KB")
    print("  kind: " + " · ".join(f"{k}={v}" for k, v in sorted(by_kind.items())))
    for uid, u in m["units"].items():
        box = alpha_bbox_pct(Image.open(root / u["card"]["file"]))
        if box and not u["card"].get("pixelArt"):
            print("  bbox %-14s L%.1f%% T%.1f%% R%.1f%% B%.1f%%" % (uid, *box))
    return 0


if __name__ == "__main__":
    sys.exit(verify() if "--verify" in sys.argv[1:] else (build() or 0))

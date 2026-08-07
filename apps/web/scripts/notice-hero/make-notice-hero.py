#!/usr/bin/env python3
"""
공지용 캐릭터 히어로 이미지 생성기 (#248 후속)

ref1 시안의 "느낌"을 코드로 재현한다 — 어두운 남색 배경 · 중앙 블루 글로우 ·
좌우 금색 셰브론 · 바닥 금색 아크 · 중앙 캐릭터 (+ 선택적으로 구운 헤드라인).

**왜 이미지에 굽나**: 공지 본문 렌더러는 HTML 주입을 막아 서식이 5가지뿐이다
(굵게·기울임·목록·링크·이미지). 색·프레임·타이포는 표현할 방법이 없다.
그래서 디자인을 이미지 안으로 넣고, 캐릭터만 갈아끼우는 **템플릿**으로 만든다.

사용:
  python3 make-notice-hero.py <캐릭터PNG> <출력경로> [--name 경니시우스] [--wordmark herewego.png]
                              [--portrait]

캐릭터 PNG 규격(기본 = 전신 모드): 투명 배경 · 전신 · 세로형 권장(2:3 내외) · 512px 이상

**`--portrait` = 증명사진 모드** (#473, hero 지시 *"전신사진말고 증명사진으로 써"*).
전신 모드는 **투명 배경 컷아웃**을 전제해 배경 위에 세우고 발밑 그림자를 깐다. 증명사진
(`design/characters/**` 의 아이콘 축·아트 파이프라인 원본)은 **자기 배경이 구워진 불투명
정사각**이라 같은 합성을 태우면 베이지 사각형이 남색 위에 그대로 얹힌다. 그래서 세우지 않고
**금색 액자에 넣는다** — 원본을 정사각으로 크롭해 라운드 액자 + 금테 + 드롭섀도로 마운트한다.
바닥 아크·발밑 그림자는 안 그린다(떠 있는 액자 밑의 지면은 거짓말이다).
"""
import sys, os, math, argparse
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1180                      # 폰 폭에서 잘 맞는 비율(≈0.92)
NAVY_TOP  = (10, 18, 32)
NAVY_BOT  = (6, 11, 20)
BLUE_GLOW = (32, 96, 190)
GOLD      = (214, 168, 74)
KR_FONT   = "/System/Library/Fonts/AppleSDGothicNeo.ttc"


def vertical_gradient(size, top, bot):
    w, h = size
    g = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        g.putpixel((0, y), tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return g.resize(size, Image.BILINEAR)


def radial_glow(size, center, radius, color, strength=1.0):
    """중앙 블루 글로우 — 캐릭터를 배경에서 띄운다."""
    w, h = size
    layer = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(layer)
    cx, cy = center
    steps = 42
    for i in range(steps, 0, -1):
        r = radius * i / steps
        v = round(255 * strength * (1 - i / steps) ** 1.7)
        d.ellipse((cx - r, cy - r * 0.82, cx + r, cy + r * 0.82), fill=v)
    layer = layer.filter(ImageFilter.GaussianBlur(radius * 0.10))
    tint = Image.new("RGB", (w, h), color)
    return tint, layer


def chevrons(size, color, alpha=70):
    """좌우 대각 셰브론 — ref1 의 금속/금색 무늬 인상."""
    w, h = size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for side in (-1, 1):
        x0 = w * 0.5 + side * w * 0.30
        for k in range(4):
            off = k * w * 0.075
            thick = max(6, round(w * 0.016))
            top, bot = h * 0.10, h * 0.78
            apex = x0 + side * off
            pts = [(apex, top), (apex + side * w * 0.14, (top + bot) / 2), (apex, bot)]
            a = round(alpha * (1 - k * 0.2))
            d.line(pts, fill=color + (a,), width=thick, joint="curve")
    return layer.filter(ImageFilter.GaussianBlur(1.2))


def ground_arc(size, color):
    """바닥 금색 원호 — 경기장 센터서클 인상."""
    w, h = size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cy = h * 0.885
    rx, ry = w * 0.40, h * 0.075
    for i, a in enumerate((150, 90, 45)):
        e = i * 5
        d.ellipse((w / 2 - rx - e, cy - ry - e, w / 2 + rx + e, cy + ry + e),
                  outline=color + (a,), width=3)
    return layer.filter(ImageFilter.GaussianBlur(1.0))


def square_crop(im):
    """증명사진용 정사각 크롭 — 가로는 중앙, 세로는 **위쪽 기준**.

    얼굴이 위에 있으므로 세로를 중앙에서 자르면 정수리가 날아간다. 이미 정사각이면 항등.
    """
    s = min(im.width, im.height)
    x = (im.width - s) // 2
    y = min((im.height - s) // 2, round(im.height * 0.06))
    return im.crop((x, y, x + s, y + s))


def framed_portrait(im, size, radius, border=7):
    """증명사진을 금테 라운드 액자에 넣는다(그림자 포함 레이어를 돌려준다)."""
    ph = square_crop(im.convert("RGBA")).resize((size, size), Image.LANCZOS)

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius, fill=255)

    pad = round(size * 0.10)                       # 그림자가 잘리지 않을 만큼
    layer = Image.new("RGBA", (size + pad * 2, size + pad * 2), (0, 0, 0, 0))

    sh = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        (pad, pad + round(size * 0.02), pad + size, pad + size + round(size * 0.045)),
        radius, fill=(0, 0, 0, 150))
    layer.alpha_composite(sh.filter(ImageFilter.GaussianBlur(pad * 0.5)))

    layer.paste(ph, (pad, pad), mask)

    d = ImageDraw.Draw(layer)
    for i, (w, a) in enumerate(((border, 235), (2, 90))):   # 금테 + 바깥 얇은 링
        e = 0 if i == 0 else border + 5
        d.rounded_rectangle(
            (pad - e, pad - e, pad + size - 1 + e, pad + size - 1 + e),
            radius + e, outline=GOLD + (a,), width=w)
    return layer


def build(char_path, out_path, name=None, wordmark=None, jpeg_quality=88, portrait=False):
    base = vertical_gradient((W, H), NAVY_TOP, NAVY_BOT).convert("RGBA")

    tint, mask = radial_glow((W, H), (W // 2, round(H * 0.46)), W * 0.46, BLUE_GLOW, 0.85)
    base = Image.composite(Image.alpha_composite(base, tint.convert("RGBA")), base, mask)

    base.alpha_composite(chevrons((W, H), GOLD))
    if not portrait:
        base.alpha_composite(ground_arc((W, H), GOLD))

    ch = Image.open(char_path).convert("RGBA")

    if not portrait:
        ch = ch.crop(ch.getbbox())
        target_h = round(H * (0.615 if name else 0.70))
        ch = ch.resize((round(ch.width * target_h / ch.height), target_h), Image.LANCZOS)

        # 캐릭터 발밑 그림자 — 바닥에 붙어 보이게
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(sh).ellipse(
            (W / 2 - ch.width * 0.42, H * 0.878, W / 2 + ch.width * 0.42, H * 0.912),
            fill=(0, 0, 0, 120))
        base.alpha_composite(sh.filter(ImageFilter.GaussianBlur(9)))
        base.alpha_composite(ch, ((W - ch.width) // 2, round(H * 0.895) - ch.height))

    head_bottom = round(H * 0.035)
    if wordmark and os.path.exists(wordmark):
        wm = Image.open(wordmark).convert("RGBA")
        wm = wm.crop(wm.getbbox())
        ww = round(W * 0.44)                      # 이름과 겹치지 않게 작게
        wm = wm.resize((ww, round(wm.height * ww / wm.width)), Image.LANCZOS)
        base.alpha_composite(wm, ((W - ww) // 2, head_bottom))
        head_bottom += wm.height + round(H * 0.012)   # ← 이름은 항상 이 아래에

    if name:
        d = ImageDraw.Draw(base)
        f = ImageFont.truetype(KR_FONT, round(W * 0.068), index=2)
        txt = f"{name} 합류"
        tw = d.textbbox((0, 0), txt, font=f)[2]
        x, y = (W - tw) // 2, head_bottom
        d.text((x + 2, y + 3), txt, font=f, fill=(0, 0, 0, 170))     # 그림자
        d.text((x, y), txt, font=f, fill=(240, 245, 255, 255))
        d.line((W * 0.32, y + f.size * 1.45, W * 0.68, y + f.size * 1.45),
               fill=GOLD + (150,), width=3)
        head_bottom = round(y + f.size * 1.45)

    if portrait:
        # 액자는 **헤드라인 아래 남은 공간 안에서** 가능한 크게. 헤더가 없으면 그만큼 커진다.
        top = head_bottom + round(H * 0.045)
        avail = min(round(H * 0.955) - top, round(W * 0.66))
        layer = framed_portrait(ch, avail, round(avail * 0.055))
        base.alpha_composite(layer, ((W - layer.width) // 2,
                                     top - round(avail * 0.10)))

    out = base.convert("RGB")                    # 카드 배경과 무관하게 자기 배경을 갖는다
    ext = os.path.splitext(out_path)[1].lower()
    if ext == ".webp":
        out.save(out_path, "WEBP", quality=jpeg_quality, method=6)
    else:
        out.save(out_path, optimize=True)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("char"); ap.add_argument("out")
    ap.add_argument("--name"); ap.add_argument("--wordmark")
    ap.add_argument("--portrait", action="store_true",
                    help="증명사진(불투명 정사각) 을 금테 액자로 마운트 — 전신 컷아웃 대신")
    a = ap.parse_args()
    im = build(a.char, a.out, a.name, a.wordmark, portrait=a.portrait)
    print(f"생성: {a.out} {im.size} {round(os.path.getsize(a.out)/1024,1)}KB")

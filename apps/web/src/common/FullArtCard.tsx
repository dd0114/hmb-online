import { useState } from "react";
import type { CSSProperties } from "react";
import { GRADE_COLORS, GRADE_LABELS, type Grade } from "./grades";
import { CharAvatar } from "./CharAvatar";
import { charRefFor } from "./char-assets-store";
import { useCharAssets } from "./useCharAssets";
import {
  artAspect,
  cardAspect,
  cardLayers,
  FULL_ART_DESIGN,
  fullArtLayout,
  fullArtWidth,
  gradeRingShadow,
  resolveCardGeometry,
  type CardLayers,
  type FullArtSize,
} from "./full-art";
import styles from "./FullArtCard.module.css";

/**
 * 풀아트 카드 — **큰 자리**(뽑기 결과·덱 지시 레일·도감 확장·트레이드 영입 대상)에서 쓰는
 * 캐릭터 전신 일러스트 (#187). 작은 자리(목록·칩·전술보드 슬롯·매치 토큰)는 계속 `CharAvatar`
 * 아이콘이다 — 이 경계는 E2E 계약(`e2e/p3-card-art.spec.ts`)이 지킨다.
 *
 * 층 구성·왜 합성인지·**갈아끼우는 법**은 `full-art.ts` 상단 주석 참조.
 * 폴백 3단(깨짐 0): 풀아트 → 등급 프레임 + 아이콘 → CSS 테두리 + 아이콘.
 * 이미지 **로드 실패**(404·네트워크)도 같은 계단으로 떨어진다(`onError`) — 깨진 <img> 는 0.
 */
export interface FullArtCardProps {
  playerId: string;
  name: string;
  grade: Grade;
  /** 표시용 포지션. 카드 아트에 구워진 뱃지는 **캐릭터의** 포지션이라 선수 것으로 덮는다. */
  position?: string;
  /**
   * 카드 폭 — 시맨틱 토큰(`"grid" | "rail" | "detail" | "sheet" | "hero"`) 권장.
   * 픽셀도 받지만, 토큰을 쓰면 `FULL_ART_SIZES` 한 줄로 전 화면 크기를 조정할 수 있다.
   */
  size?: FullArtSize | number;
  /** 하단 밴드에 이름/등급 텍스트를 얹을지. 카드 밖에 별도 캡션이 있으면 끈다. */
  showLabels?: boolean;
  /** 등급색 링 1겹(D4). 기본 on — LEGEND/GOLD 프레임이 같은 금색이라 이게 등급 구분축이다. */
  ring?: boolean;
  /**
   * `"card"`(기본) = 프레임 통짜 카드(테두리·별·하단 밴드 포함).
   * `"art"` = **아트만** 잘라 쓴다 — 이름·등급·별을 카드 **밖**에서 보여주는 자리용.
   * 프레임 밴드를 안 그리므로 빈 띠가 남지 않고, 등급은 링이 말한다(`full-art.ts artAspect` 주석).
   */
  variant?: "card" | "art";
  className?: string;
  onClick?: () => void;
  testId?: string;
}

export function FullArtCard({
  playerId,
  name,
  grade,
  position,
  size = "detail",
  showLabels = true,
  ring = true,
  variant = "card",
  className,
  onClick,
  testId,
}: FullArtCardProps) {
  const assets = useCharAssets();
  // 로드 실패한 URL 을 기억해 같은 렌더에서 계단을 한 칸 내린다(무한 재시도 방지).
  const [failed, setFailed] = useState<Record<string, true>>({});

  const resolved = cardLayers({
    characters: assets.characters,
    units: assets.units,
    placeholders: assets.placeholders,
    ref: charRefFor(assets, playerId),
    grade,
  });
  const art = resolved.art && !failed[resolved.art] ? resolved.art : null;
  const frame = resolved.frame && !failed[resolved.frame] ? resolved.frame : null;
  /**
   * 로드 실패를 반영한 최종 종류. 완성 카드는 **프레임이 애초에 없는 것이 정상**이라
   * (`frame` 이 null 이어도) 실패로 강등하지 않는다 — 아트가 죽었을 때만 계단을 내린다.
   */
  const kind: CardLayers["kind"] =
    resolved.kind === "unit-complete"
      ? art
        ? "unit-complete"
        : frame
          ? "frame-only"
          : "none"
      : resolved.kind === "unit-art" && art
        ? "unit-art"
        : art && frame
          ? "full-art"
          : frame
            ? "frame-only"
            : "none";
  const whole = kind === "unit-complete";
  // 프레임리스 유닛 아트는 창을 채운다(크롭 오프셋을 쓰면 아트가 잘린다 — full-art.ts `fit` 주석).
  const fillArt = kind === "unit-art";

  // 규격은 발행물이 실어 보내면 그쪽이 이긴다 — 에셋 교체만으로 카드 모양을 바꿀 수 있게(#187 hero).
  const geom = resolveCardGeometry(assets.characters);
  const L = fullArtLayout(geom);
  const width = fullArtWidth(size);
  const D = FULL_ART_DESIGN;
  const color = GRADE_COLORS[grade];
  const Tag = onClick ? "button" : "div";

  const font = (ratio: number, min: number) => Math.max(min, Math.round(width * ratio));
  const artOnly = variant === "art" && !whole;
  /**
   * 완성 카드는 이름·별·포지션뱃지·대사가 **아트에 구워져 있다** → 오버레이를 얹으면 이중 표기다.
   * (그래서 `variant="art"` 도 무시한다 — 잘라낼 프레임 밴드가 따로 없는 통짜 에셋이다.)
   */
  const labels = showLabels && !artOnly && !whole;
  const showBadge = !!position && !whole;

  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={[styles.card, kind === "none" ? styles.bare : "", className].filter(Boolean).join(" ")}
      style={
        {
          /* 폭은 **CSS 변수**로 준다 — 인라인 `width` 로 박으면 소비처가 미디어쿼리로 못 줄인다.
             (모바일 독처럼 세로 예산이 빡빡한 자리에서 실제로 필요했다: `--fa-w` 만 덮으면 된다.) */
          "--fa-w": `${width}px`,
          /* 완성 카드는 **자기 발행 규격**을 따른다(512×768). 226×425 카드 비율에 욱여넣으면
             구워진 프레임이 잘린다 — 통짜 에셋이라 크롭할 여지가 없다. */
          aspectRatio: whole ? resolved.aspect! : artOnly ? artAspect(geom) : cardAspect(geom),
          boxShadow: ring ? gradeRingShadow(grade) : undefined,
          borderColor: kind === "none" ? color : undefined,
        } as CSSProperties
      }
      data-testid={testId ?? `full-art-${playerId}`}
      data-art-kind={kind}
      data-grade={grade}
      onClick={onClick}
      /* 버튼일 때만 라벨을 준다 — 일반 div 의 aria-label 은 접근성 트리에 노출되지 않고
         (역할 없는 제네릭 요소), 카드 안 이름·등급 텍스트가 이미 읽힌다. */
      aria-label={onClick ? `${name} · ${position ?? ""} · ${GRADE_LABELS[grade]}` : undefined}
    >
      {/* 층1 — 등급 프레임(테두리·별·하단 밴드). lazy 라 화면 밖 카드는 안 받는다.
          `variant="art"` 은 프레임을 그리지 않는다 — 아트만 쓰는 자리라 밴드가 필요 없다
          (프레임 이미지 요청도 안 나간다). */}
      {frame && !artOnly && (
        <img
          className={styles.frame}
          src={frame}
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          data-art-layer="frame"
          onError={() => setFailed((f) => ({ ...f, [frame]: true }))}
        />
      )}

      {/* 층2 — 캐릭터 아트.
          `crop`  = 창을 잘라 카드 원본의 아트 영역만 보이게 한다(characters 축).
          `fill`  = 프레임 없는 유닛 아트 → **아트 창** 안에서 비율을 지켜 채운다.
          `whole` = 완성 카드 → 카드 박스 통짜(프레임 층 자체를 안 그린다).

          ⚠️ `fill` 의 컨테이너가 카드 통짜(`artFill`=inset:0)면 안 된다 — 아트는 2:3 인데
          카드는 226×425 라 `contain` 이 세로로 남겨, 아트가 **네임플레이트 아래까지 흘러내려
          이름을 덮는다**(#207 재발행 실화면에서 발·공이 이름을 가렸다. 실측 침범 12~34px).
          프레임을 같이 그리는 경로에서는 창이 **아트 영역**이어야 한다.
          `artOnly`(variant="art")·`whole` 은 카드 박스 자체가 이미 아트 박스라 통짜가 맞다. */}
      {art && (
        <span
          className={[styles.artWindow, artOnly || whole ? styles.artFill : ""]
            .filter(Boolean)
            .join(" ")}
          style={(artOnly || whole ? undefined : L.window) as CSSProperties}
          aria-hidden
        >
          <img
            className={[styles.art, whole || fillArt ? styles.artContain : ""].filter(Boolean).join(" ")}
            style={
              {
                ...(whole || fillArt ? undefined : (L.art as CSSProperties)),
                /* 도트 원본만 nearest-neighbor. 사진형 실아트를 pixelated 로 축소하면 계단이 진다. */
                imageRendering: resolved.pixelArt ? "pixelated" : "auto",
              } as CSSProperties
            }
            src={art}
            alt=""
            loading="lazy"
            decoding="async"
            data-art-layer="art"
            data-art-fit={whole ? "whole" : fillArt ? "fill" : "crop"}
            onError={() => setFailed((f) => ({ ...f, [art]: true }))}
          />
        </span>
      )}

      {/* 폴백 — 풀아트가 없으면 아트 창 자리에 아이콘을 크게 놓는다(빈 칸 0). */}
      {!art && (
        <span
          className={[styles.artWindow, artOnly ? styles.artFill : ""].filter(Boolean).join(" ")}
          style={(artOnly ? undefined : L.window) as CSSProperties}
        >
          <span className={styles.iconWrap}>
            <CharAvatar
              playerId={playerId}
              name={name}
              grade={grade}
              size={Math.round(width * D.fallbackIconRatio)}
            />
          </span>
        </span>
      )}

      {/* 층3 — 텍스트 오버레이. 밴드 자체는 층1(프레임)이 이미 그려놨다. */}
      {/* 포지션 뱃지는 **두 변형 모두** 그린다. 아트 영역 좌상단에는 원본에 구워진 뱃지가
          걸쳐 있는데(원본 (8,8)-(42,26) 중 크롭 안쪽이 보인다) 그건 **캐릭터의** 포지션이라
          교차 매핑 선수(예: FW 선수 ← GK 캐릭터)에서 틀린 값이 노출된다 → 불투명하게 덮는다. */}
      {showBadge && (
        <span
          className={styles.badge}
          style={{
            ...((artOnly ? L.badgeArt : L.badge) as CSSProperties),
            fontSize: font(D.badgeFontRatio, D.minBadgeFont),
          }}
        >
          {position}
        </span>
      )}
      {labels && (
        <>
          <span
            className={styles.name}
            style={{ ...(L.name as CSSProperties), fontSize: font(D.nameFontRatio, D.minNameFont) }}
            /* ⚠️ `full-art-` 로 시작하면 안 된다 — 경계 계약이 `[data-testid^="full-art-"]` 로
               **카드 개수**를 세는데, 카드 안 자식이 같은 접두어면 1장이 2개로 잡힌다
               (실제로 도감 펼침에서 2로 세졌다). 카드 노드만 그 접두어를 갖는다. */
            data-testid={`card-label-${playerId}`}
          >
            {name}
          </span>
          <span
            className={styles.grade}
            style={{ ...(L.desc as CSSProperties), color, fontSize: font(D.gradeFontRatio, D.minGradeFont) }}
          >
            {GRADE_LABELS[grade]}
          </span>
        </>
      )}
    </Tag>
  );
}

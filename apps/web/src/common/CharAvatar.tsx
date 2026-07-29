import type { CSSProperties } from "react";
import { GRADE_COLORS, type Grade } from "./grades";
import { resolveTile, tileStyle, unitIconBackground } from "./char-manifest";
import { showsCharacterArt } from "./icon-policy";
import { charRefFor } from "./char-assets-store";
import { useCharAssets } from "./useCharAssets";
import styles from "./CharAvatar.module.css";

/**
 * 선수 아바타 — **작은 자리**(목록·칩·슬롯·상세 헤더)에서 쓰는 캐릭터 얼굴 타일 (#145).
 * 큰 자리(도감 상세·뽑기 연출)의 풀아트 카드는 별도 컴포넌트가 담당한다.
 *
 * 폴백 3단(깨짐 0, AC-F1):
 *   1) 매핑된 아트 얼굴 — **units 축(입고 실아트) 또는 characters 축**(매핑이 축을 정한다)
 *   → 2) 플레이스홀더 축 얼굴(172명 전원 커버) → 3) CSS 플레이스홀더(등급색 + 이니셜, 외부 요청 0).
 * 에셋 번들 로딩 중에도 3)이 보이므로 레이아웃이 흔들리지 않는다.
 *
 * ⚠️ **그 앞에 정책 게이트가 있다**(#285): 다이아 미만은 매핑이 있어도 얼굴을 그리지 않고 곧장
 * 3)으로 간다. 판정은 `icon-policy` 한 곳 — 여기에 등급 비교를 적지 마라(계약이 그걸 잡는다).
 * 그래서 `grade` 는 **필수**다: 옵셔널이면 등급을 안 넘긴 호출부가 조용히 정책 밖으로 새 나간다
 * (실제로 `PromptFields` 가 그 상태였다). 타입이 호출부를 강제하게 둔다.
 *
 * ⚠️ **원형 마스크는 배경 전제에 따라 갈린다**(#207 U-D8): 유닛 얼굴이 `iconBackground:
 * "opaque-dark"` 면 아트가 **불투명 다크 배경 위에** 그려져 있어서 — 글로우 링·수염선이 그
 * 배경을 전제로 번진다 — 원으로 자르면 그 디테일이 잘려 나간다. 그럴 땐 라운드 사각으로 둔다.
 */
export interface CharAvatarProps {
  playerId: string;
  /** 이니셜 폴백용. */
  name: string;
  /** 노출 정책 판정에 쓴다(#285) — 필수. 모르면 아트를 그리지 않는 쪽으로 닫힌다. */
  grade: Grade;
  /**
   * **아트 검수 전용 예외**(DEV `/design/cards` 프리뷰). 발행물이 실제로 어떻게 생겼는지 보는
   * 도구라 정책으로 가리면 도구가 무의미해진다. 제품 화면에서는 쓰지 마라 —
   * `icon-policy.test.ts` 가 이 prop 의 사용처를 `src/design/**` 로 묶는다.
   */
  artReviewExempt?: boolean;
  /** 픽셀 크기(정사각). 목록 28~40, 상세 64~96 권장. */
  size?: number;
  /** 어떤 아틀라스를 쓸지. 기본 avatars-64(축소해도 디테일 유지). */
  atlas?: string;
  className?: string;
  /** 스크린리더용 — 장식이면 생략(aria-hidden 처리). */
  alt?: string;
}

/** 이름 → 최대 2글자 이니셜. 공백 분절이 없으면 앞 2글자(한글 이름 대응). */
export function initialsOf(name: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

export function CharAvatar({
  playerId,
  name,
  grade,
  artReviewExempt = false,
  size = 36,
  atlas = "avatars-64",
  className,
  alt,
}: CharAvatarProps) {
  const assets = useCharAssets();
  const ref = charRefFor(assets, playerId);
  // #285 정책 게이트 — 아트 해석보다 **먼저** 판정한다. 매핑을 뒤진 뒤 버리면 폴백 경로가
  // 아트 유무에 따라 갈려(placeholder 축 vs CSS) 화면이 등급별로 들쭉날쭉해진다.
  const artHidden = !artReviewExempt && !showsCharacterArt(grade);
  const resolved = artHidden
    ? null
    : resolveTile({
        characters: assets.characters,
        units: assets.units,
        placeholders: assets.placeholders,
        ref,
        playerId,
        atlas,
      });

  // 유닛 얼굴만 배경 전제를 선언한다(다른 두 축은 투명 계약).
  const iconBg =
    resolved?.kind === "unit" ? unitIconBackground(assets.units, ref?.id) : "transparent";
  const cls = [styles.avatar, className].filter(Boolean).join(" ");
  const a11y = alt ? { role: "img" as const, "aria-label": alt } : { "aria-hidden": true as const };

  if (!resolved) {
    // CSS 플레이스홀더 — 외부 요청 0. 등급색 테두리 + 이니셜.
    const color = grade ? GRADE_COLORS[grade] : "#6b7280";
    return (
      <span
        className={[cls, styles.fallback].join(" ")}
        style={{ width: size, height: size, borderColor: color, color, fontSize: Math.round(size * 0.36) }}
        data-testid={`char-avatar-${playerId}`}
        data-avatar-kind="placeholder-css"
        /* 같은 CSS 폴백이라도 **왜** 떨어졌는지는 다르다 — 정책으로 숨긴 것과 아트가 없는 것을
           구분해 두지 않으면, 아트 파이프라인이 통째로 죽어도 정책 계약이 green 으로 덮는다. */
        {...(artHidden ? { "data-art-policy": "hidden" } : {})}
        {...a11y}
      >
        {initialsOf(name)}
      </span>
    );
  }

  return (
    <span
      className={[cls, iconBg === "opaque-dark" ? styles.opaqueBg : ""].filter(Boolean).join(" ")}
      style={tileStyle(resolved.tile, size) as CSSProperties}
      data-testid={`char-avatar-${playerId}`}
      data-avatar-kind={resolved.kind}
      data-icon-bg={iconBg}
      {...a11y}
    />
  );
}

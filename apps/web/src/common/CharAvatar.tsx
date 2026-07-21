import type { CSSProperties } from "react";
import { GRADE_COLORS, type Grade } from "./grades";
import { resolveTile, tileStyle } from "./char-manifest";
import { charIdFor } from "./char-assets-store";
import { useCharAssets } from "./useCharAssets";
import styles from "./CharAvatar.module.css";

/**
 * 선수 아바타 — **작은 자리**(목록·칩·슬롯·상세 헤더)에서 쓰는 캐릭터 얼굴 타일 (#145).
 * 큰 자리(도감 상세·뽑기 연출)의 풀아트 카드는 별도 컴포넌트가 담당한다.
 *
 * 폴백 3단(깨짐 0, AC-F1):
 *   1) 매핑된 확정 캐릭터 얼굴 → 2) 플레이스홀더 축 얼굴(172명 전원 커버)
 *   → 3) CSS 플레이스홀더(등급색 + 이니셜, 외부 요청 0).
 * 에셋 번들 로딩 중에도 3)이 보이므로 레이아웃이 흔들리지 않는다.
 */
export interface CharAvatarProps {
  playerId: string;
  /** 이니셜 폴백용. */
  name: string;
  grade?: Grade;
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
  size = 36,
  atlas = "avatars-64",
  className,
  alt,
}: CharAvatarProps) {
  const assets = useCharAssets();
  const resolved = resolveTile({
    characters: assets.characters,
    placeholders: assets.placeholders,
    charId: charIdFor(assets, playerId),
    playerId,
    atlas,
  });

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
        {...a11y}
      >
        {initialsOf(name)}
      </span>
    );
  }

  return (
    <span
      className={cls}
      style={tileStyle(resolved.tile, size) as CSSProperties}
      data-testid={`char-avatar-${playerId}`}
      data-avatar-kind={resolved.kind}
      {...a11y}
    />
  );
}

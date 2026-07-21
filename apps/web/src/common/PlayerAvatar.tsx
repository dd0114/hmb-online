import { useState } from "react";
import { GRADE_COLORS } from "./grades";
import { avatarInitial, resolvePlayerAvatar, type AvatarPlayer } from "./char-assets";
import styles from "./PlayerAvatar.module.css";

export type AvatarSize = "sm" | "md" | "lg";

interface PlayerAvatarProps {
  player: AvatarPlayer;
  size?: AvatarSize;
  className?: string;
}

/**
 * 재사용 선수 아바타 — PRD-v4 §F (AC-F1). LEGEND + 도트 에셋 있으면 도트, 그 외 placeholder.
 * placeholder(등급색 배경 + 이니셜, inline SVG/CSS — 외부 요청 0)는 항상 배경으로 깔려
 * 로딩 중/폴백 시 레이아웃 시프트·깨진 이미지 아이콘이 없다.
 * data-avatar-kind 는 **실제 렌더 경로**를 반영한다(onError 폴백 시 placeholder 로 바뀜).
 */
export function PlayerAvatar({ player, size = "md", className }: PlayerAvatarProps) {
  const resolved = resolvePlayerAvatar(player);
  const [imgFailed, setImgFailed] = useState(false);

  const dotSrc = resolved.kind === "legend-dot" ? resolved.src : null;
  const useDot = dotSrc !== null && !imgFailed;
  const kind = useDot ? "legend-dot" : "placeholder";
  const color = GRADE_COLORS[player.grade];
  const initial = avatarInitial(player.name);

  return (
    <span
      role="img"
      aria-label={player.name}
      className={[styles.avatar, styles[size], className].filter(Boolean).join(" ")}
      data-testid={`player-avatar-${player.id}`}
      data-avatar-kind={kind}
    >
      {/* placeholder = 항상 배경 레이어(로딩 중에도 보임, 시프트 0). 등급색 그라디언트 + 이니셜. */}
      <span
        className={styles.placeholder}
        aria-hidden="true"
        style={{
          background: `radial-gradient(circle at 50% 35%, ${color} 0%, ${color}99 55%, ${color}55 100%)`,
        }}
      >
        <span className={styles.initial}>{initial}</span>
      </span>

      {dotSrc && !imgFailed && (
        <img
          className={styles.dot}
          src={dotSrc}
          alt=""
          draggable={false}
          onError={() => setImgFailed(true)}
        />
      )}
    </span>
  );
}

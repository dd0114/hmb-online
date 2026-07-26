import { useEffect, useRef, useState } from "react";
import { Modal } from "../common/Modal";
import { ErrorToast } from "../common/ErrorToast";
import { GRADE_COLORS, GRADE_LABELS, type Grade } from "../common/grades";
import { CharAvatar } from "../common/CharAvatar";
import { ApiError } from "../api/client";
import { useCardEffective, useDiceBalance, useDiceRoll, useStarUp } from "../api/growth-hooks";
import { INSUFFICIENT_DICE_CODE, INSUFFICIENT_MATERIALS_CODE, type PotentialTier, type Star } from "../api/growth";
import {
  GRADE_POTENTIAL_LINES,
  STAR_COPY_COST,
  STAT_LABELS,
  TIER_COLORS,
  TIER_LABELS,
  xpToNextLevel,
} from "../growth/growth-config";
import type { CatalogPlayer } from "../api/hooks";
import styles from "./CardGrowthDetail.module.css";

const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R; // ≈ 263.9
const MAX_STAR = 4;
const ROLL_ANIM_MS = 450;
const clampPct = (n: number) => Math.max(0, Math.min(100, n));

interface CardGrowthDetailProps {
  player: CatalogPlayer;
  onClose: () => void;
}

/**
 * 보유 카드 성장 상세(에픽 #179 §V2-6, GM3) — S2/S3/S4/S6:
 * OVR 링 + 완성도 · ★1~4(성 승급) · 스탯 9종(Lv+XP바+현재/천장) · 잠재 3줄(티어색) · 다이스 롤.
 * 프레임 색은 등급(불변, 승급 없음) 고정 — ★는 별도 표시.
 */
export function CardGrowthDetail({ player, onClose }: CardGrowthDetailProps) {
  const { data: card, isLoading, isError } = useCardEffective(player.id);
  const starUp = useStarUp();
  const diceRoll = useDiceRoll();
  const { data: diceBalance } = useDiceBalance();

  const [message, setMessage] = useState<string | null>(null);
  const [rollingKind, setRollingKind] = useState<"NORMAL" | "CASH" | null>(null);
  const [tierUpBanner, setTierUpBanner] = useState<PotentialTier | null>(null);
  const [justUpAttrs, setJustUpAttrs] = useState<Set<string>>(new Set());
  const [justUpLv, setJustUpLv] = useState<Set<string>>(new Set());

  const prevAttrsRef = useRef<Record<string, number> | null>(null);
  const prevLvRef = useRef<Record<string, number> | null>(null);

  // 성장/롤/승급 후 카드가 갱신되면 어떤 스탯이 올랐는지 감지해 +1 델타 플래시(§V2-6, hero 피드백).
  useEffect(() => {
    if (!card) return;
    const attrs = card.attributes as unknown as Record<string, number>;
    const prev = prevAttrsRef.current;
    prevAttrsRef.current = attrs;
    if (!prev) return;
    const up = new Set<string>();
    for (const key of Object.keys(attrs)) {
      const cur = attrs[key] ?? 0;
      const before = prev[key] ?? cur;
      if (cur > before) up.add(key);
    }
    if (up.size === 0) return;
    setJustUpAttrs(up);
    const t = window.setTimeout(() => setJustUpAttrs(new Set()), 900);
    return () => window.clearTimeout(t);
  }, [card]);

  useEffect(() => {
    if (!card) return;
    const lvs = Object.fromEntries(Object.entries(card.statLevels).map(([k, v]) => [k, v.lv]));
    const prev = prevLvRef.current;
    prevLvRef.current = lvs;
    if (!prev) return;
    const up = new Set<string>();
    for (const key of Object.keys(lvs)) {
      const cur = lvs[key] ?? 0;
      const before = prev[key] ?? cur;
      if (cur > before) up.add(key);
    }
    if (up.size === 0) return;
    setJustUpLv(up);
    const t = window.setTimeout(() => setJustUpLv(new Set()), 1400);
    return () => window.clearTimeout(t);
  }, [card]);

  const grade: Grade = card?.grade ?? player.grade;
  const frameColor = GRADE_COLORS[grade];
  const star: Star = card?.star ?? 1;
  const completion = card ? Math.max(0, Math.min(1, card.completion)) : 0;
  const busy = starUp.isPending || diceRoll.isPending || rollingKind !== null;

  const nextStar = (star + 1) as Star;
  const starMaxed = star >= MAX_STAR;
  const starCost = starMaxed ? 0 : STAR_COPY_COST[nextStar as Exclude<Star, 1>];
  const starShort = !starMaxed && player.ownedCount < starCost;

  function handleStarUp() {
    setMessage(null);
    starUp.mutate(player.id, {
      onError: (err) => {
        if (err instanceof ApiError && err.code === INSUFFICIENT_MATERIALS_CODE) {
          setMessage(`중복이 부족합니다 — 보유 ${player.ownedCount} / 필요 ${starCost}`);
        } else {
          setMessage(err instanceof ApiError ? err.message : "성 승급에 실패했습니다");
        }
      },
    });
  }

  function handleRoll(kind: "NORMAL" | "CASH") {
    setMessage(null);
    setRollingKind(kind);
    diceRoll.mutate(
      { playerId: player.id, kind },
      {
        onSuccess: (res) => {
          window.setTimeout(() => {
            setRollingKind(null);
            if (res.tierUp) {
              setTierUpBanner(res.tierAfter);
              window.setTimeout(() => setTierUpBanner(null), 2200);
            }
          }, ROLL_ANIM_MS);
        },
        onError: (err) => {
          setRollingKind(null);
          if (err instanceof ApiError && err.code === INSUFFICIENT_DICE_CODE) {
            setMessage("다이스가 부족합니다");
          } else {
            setMessage(err instanceof ApiError ? err.message : "다이스 롤에 실패했습니다");
          }
        },
      },
    );
  }

  const titleId = `growth-title-${player.id}`;
  const gradeLines = GRADE_POTENTIAL_LINES[grade];

  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      overlayClassName={styles.overlay}
      className={styles.sheet}
      testId="growth-detail"
      overlayTestId="growth-overlay"
    >
      <div
        className={styles.frame}
        data-testid="growth-frame"
        data-grade={grade}
        style={{ borderColor: frameColor, boxShadow: `0 0 0 1.5px ${frameColor}55 inset` }}
      >
        <button type="button" className={styles.close} onClick={onClose} aria-label="닫기">
          ×
        </button>

        <div className={styles.header}>
          <CharAvatar playerId={player.id} name={player.name} grade={grade} size={44} className={styles.avatar} />
          <div className={styles.headText}>
            <span className={styles.gradeTag} style={{ color: frameColor }} data-testid="growth-grade">
              {GRADE_LABELS[grade]}
            </span>
            <h2 id={titleId} className={styles.name}>
              {player.name}
            </h2>
            <span className={styles.pos}>{player.position}</span>
          </div>
          <div className={styles.stars} data-testid="growth-stars" data-star={star}>
            {Array.from({ length: MAX_STAR }).map((_, i) => (
              <span key={i} className={i < star ? styles.star : `${styles.star} ${styles.starOff}`} aria-hidden>
                ★
              </span>
            ))}
          </div>
        </div>

        {isLoading && <p className={styles.loading}>불러오는 중…</p>}
        {isError && <ErrorToast message="성장 정보를 불러오지 못했습니다" />}

        {card && (
          <>
            <div className={styles.starUpRow}>
              <button
                type="button"
                className={styles.starUpBtn}
                data-testid="growth-star-up"
                onClick={handleStarUp}
                disabled={busy || starMaxed || starShort}
              >
                {starUp.isPending ? "승급 중…" : starMaxed ? "★ 최대" : `성 승급 → ${nextStar}★`}
                {!starMaxed && (
                  <span className={styles.costChip} data-testid="growth-star-cost">
                    중복 −{starCost}
                  </span>
                )}
              </button>
              {starShort && (
                <p className={styles.shortNote} data-testid="growth-star-short">
                  중복 부족 (보유 {player.ownedCount} / 필요 {starCost})
                </p>
              )}
            </div>

            <div className={styles.ringWrap}>
              <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden>
                <circle cx="48" cy="48" r={RING_R} fill="none" stroke="#2a313c" strokeWidth="7" />
                <circle
                  cx="48"
                  cy="48"
                  r={RING_R}
                  fill="none"
                  stroke="url(#growthRing)"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={RING_C.toFixed(1)}
                  strokeDashoffset={(RING_C * (1 - completion)).toFixed(1)}
                  transform="rotate(-90 48 48)"
                />
                <defs>
                  <linearGradient id="growthRing" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#38b3c9" />
                    <stop offset="1" stopColor="#5cc98b" />
                  </linearGradient>
                </defs>
              </svg>
              <div className={styles.ringCenter}>
                <div className={styles.ovr} data-testid="growth-ovr">
                  {Math.round(card.ovr)}
                </div>
                <div className={styles.ovrLbl}>OVR</div>
              </div>
            </div>
            <p className={styles.completion} data-testid="growth-completion">
              완성도 {Math.round(completion * 100)}%
            </p>

            <dl className={styles.attrs} data-testid="growth-attrs">
              {STAT_LABELS.map(([key, label]) => {
                const cur = card.attributes[key];
                const cap = card.caps[key];
                const base = card.base[key];
                const sl = card.statLevels[key] ?? { lv: 0, xp: 0 };
                const xpNeed = xpToNextLevel(sl.lv);
                const xpPct = clampPct((sl.xp / Math.max(1, xpNeed)) * 100);
                const lvUp = justUpLv.has(key);
                const attrUp = justUpAttrs.has(key);
                return (
                  <div key={key} className={styles.attrRow} data-testid={`growth-attr-${key}`}>
                    <dt className={styles.attrName}>
                      {label}
                      <span
                        className={lvUp ? `${styles.lvBadge} ${styles.lvBadgeUp}` : styles.lvBadge}
                        data-testid={`growth-lv-${key}`}
                      >
                        Lv.{sl.lv}
                      </span>
                    </dt>
                    <dd className={styles.attrBarCell}>
                      <span className={styles.xpBar} data-testid={`growth-xp-${key}`} data-value={Math.round(xpPct)}>
                        <i className={styles.xpFill} style={{ width: `${xpPct}%` }} />
                      </span>
                      <span className={styles.bar}>
                        <i className={styles.reach} style={{ left: `${clampPct(cur)}%`, width: `${clampPct(cap - cur)}%` }} />
                        <i
                          className={attrUp ? `${styles.fill} ${styles.fillUp}` : styles.fill}
                          data-testid={`growth-fill-${key}`}
                          data-value={Math.round(cur)}
                          style={{ width: `${clampPct(cur)}%` }}
                        />
                        <i className={styles.capLine} style={{ left: `${clampPct(cap)}%` }} />
                        <i className={styles.baseLine} style={{ left: `${clampPct(base)}%` }} />
                      </span>
                    </dd>
                    <span className={styles.attrNum}>
                      {Math.round(cur)}
                      <span className={styles.attrCap}> /{Math.round(cap)}</span>
                    </span>
                  </div>
                );
              })}
            </dl>

            <div className={styles.potentialPanel} data-testid="growth-potential">
              <h3 className={styles.sectionTitle}>잠재능력</h3>
              {!card.potential.unlocked ? (
                <p className={styles.potentialLocked} data-testid="growth-potential-locked">
                  2★에서 해금
                </p>
              ) : (
                <p className={styles.potentialTier} data-testid="growth-potential-tier">
                  현재 티어{" "}
                  <b style={{ color: TIER_COLORS[card.potential.tier] }}>{TIER_LABELS[card.potential.tier]}</b>
                  {card.potential.tier !== card.potential.maxTier && (
                    <span className={styles.ceilingNote} data-testid="growth-dice-ceiling">
                      승급 보장까지 {Math.max(0, card.potential.ceilingAt - card.potential.rollsSinceTierUp)}회
                    </span>
                  )}
                </p>
              )}
              <div
                className={rollingKind ? `${styles.potentialSlots} ${styles.reelShuffle}` : styles.potentialSlots}
                data-rolling={rollingKind ? "true" : "false"}
              >
                {Array.from({ length: 3 }).map((_, i) => {
                  const line = card.potential.lines[i];
                  const state = line ? "filled" : !card.potential.unlocked ? "locked-star" : i >= gradeLines ? "locked-grade" : "locked-star";
                  return (
                    <div
                      key={i}
                      className={styles.potentialSlot}
                      data-testid={`growth-potential-slot-${i + 1}`}
                      data-state={state}
                      data-tier={line?.tier ?? ""}
                      style={line ? { borderColor: TIER_COLORS[line.tier], color: TIER_COLORS[line.tier] } : undefined}
                    >
                      {line ? (
                        <>
                          <span className={styles.slotTier}>{TIER_LABELS[line.tier]}</span>
                          <span className={styles.slotValue}>{formatPotentialLine(line)}</span>
                        </>
                      ) : (
                        <span className={styles.slotLockedLabel}>
                          {state === "locked-grade" ? "등급 상한" : "2★ 해금"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={styles.diceRow}>
              <button
                type="button"
                className={styles.diceBtn}
                data-testid="growth-dice-normal"
                onClick={() => handleRoll("NORMAL")}
                disabled={busy || (diceBalance?.normal ?? 0) < 1}
              >
                노말 다이스 롤
                <span className={styles.costChip}>보유 {diceBalance?.normal ?? 0} · −1</span>
              </button>
              <button
                type="button"
                className={styles.diceBtn}
                data-testid="growth-dice-cash"
                onClick={() => handleRoll("CASH")}
                disabled={busy || (diceBalance?.cash ?? 0) < 1}
              >
                캐시 다이스 롤
                <span className={styles.costChip}>보유 {diceBalance?.cash ?? 0} · −1</span>
              </button>
            </div>
          </>
        )}

        {tierUpBanner && (
          <div className={styles.tierUpBanner} data-testid="growth-tierup-banner" data-tier={tierUpBanner} role="status">
            잠재 {TIER_LABELS[tierUpBanner]} 승급!
          </div>
        )}
        <ErrorToast message={message} onDismiss={() => setMessage(null)} />
      </div>
    </Modal>
  );
}

function formatPotentialLine(line: { type: string; stat?: string; value: number }): string {
  const statLabel = line.stat ? statLabelOf(line.stat) : "";
  switch (line.type) {
    case "STAT_PCT":
      return `${statLabel} +${line.value}%`;
    case "STAT_FLAT":
      return `${statLabel} +${line.value}`;
    case "CONDITION_RECOVERY":
      return `컨디션 회복 +${line.value}%`;
    case "TEAM_MORALE":
      return `팀 사기 +${line.value}%`;
    default:
      return `${statLabel} +${line.value}`;
  }
}

function statLabelOf(key: string): string {
  return STAT_LABELS.find(([k]) => k === key)?.[1] ?? key;
}

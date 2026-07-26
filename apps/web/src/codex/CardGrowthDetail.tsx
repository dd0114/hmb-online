import { useEffect, useRef, useState } from "react";
import { Modal } from "../common/Modal";
import { ErrorToast } from "../common/ErrorToast";
import { CelebrationOverlay } from "../common/CelebrationOverlay";
import { StatRadar } from "../common/StatRadar";
import { GRADE_COLORS, GRADE_LABELS, type Grade } from "../common/grades";
import { FullArtCard } from "../common/FullArtCard";
import { ApiError } from "../api/client";
import { useCardEffective, useDiceBalance, useDiceRoll, useStarUp } from "../api/growth-hooks";
import {
  INSUFFICIENT_DICE_CODE,
  INSUFFICIENT_MATERIALS_CODE,
  type PotentialTier,
  type Star,
  type StarUpResult,
} from "../api/growth";
import {
  GRADE_POTENTIAL_LINES,
  RADAR_CHIP_STATS_BY_POSITION,
  RADAR_GROUPS_BY_POSITION,
  STAR_COPY_COST,
  STAT_LABEL_MAP,
  STAT_LABELS,
  TIER_COLORS,
  TIER_LABELS,
  computeAxisWindow,
  normalizeInWindow,
  radarAxisValue,
  xpToNextLevel,
  type Position,
} from "../growth/growth-config";
import type { CatalogPlayer } from "../api/hooks";
import styles from "./CardGrowthDetail.module.css";

const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R; // ≈ 263.9
const MAX_STAR = 4;
const ROLL_ANIM_MS = 450;
// V2.1-3 / GM7b: 축하 오버레이(CelebrationOverlay) 노출 시간(UI 전용 상수 — 서버 계수 아님).
const TIERUP_OVERLAY_MS = 2400;
const STARUP_OVERLAY_MS = 2000;
// 성★ 승급 오버레이 액센트 — 기존 ★ 아이콘·성 승급 버튼과 같은 금색 토큰(styles.star 참고).
const STARUP_ACCENT = "#e7c24c";
const clampPct = (n: number) => Math.max(0, Math.min(100, n));

/** 2★=잠재 해금, 3★/4★=다음 잠재 티어 개방 — 성★ 승급 오버레이 부제(GM7b). */
function starUpSubtitle(star: Star): string | undefined {
  switch (star) {
    case 2:
      return "잠재능력 해금!";
    case 3:
      return "에픽 개방 가능!";
    case 4:
      return "유니크 개방 가능!";
    default:
      return undefined;
  }
}

interface CardGrowthDetailProps {
  player: CatalogPlayer;
  onClose: () => void;
}

/**
 * 보유 카드 성장 상세(에픽 #179 §V2-6, GM3 + V2.1-3 GM7 + 레이더 후속) — S2/S3/S4/S6:
 * OVR 링 + 완성도 · 능력치 2레이어 토글([레이더(기본)]/[막대], 밴드 앵커 윈도우 정규화 공통 적용) ·
 * ★1~4(성 승급) · 스탯 9종(Lv+XP바) · 잠재 패널(전줄 동일 티어, 패널·프레임 글로우 승격) ·
 * 다이스 롤 + 티어업 전체 오버레이. 성장/잠재 기여는 별도 탭이 아니라 막대의 cap/base 마커 +
 * 레이더의 cap 점선 폴리곤으로 표시(구 "+보너스" 분해 탭은 hero 피드백으로 제거).
 * 프레임 **테두리 색**은 등급(불변, 승급 없음) 고정 — **글로우**는 잠재 티어색(승급 시 전환).
 */
export function CardGrowthDetail({ player, onClose }: CardGrowthDetailProps) {
  const { data: card, isLoading, isError } = useCardEffective(player.id);
  const starUp = useStarUp();
  const diceRoll = useDiceRoll();
  const { data: diceBalance } = useDiceBalance();

  const [message, setMessage] = useState<string | null>(null);
  const [rollingKind, setRollingKind] = useState<"NORMAL" | "CASH" | null>(null);
  const [tierUpOverlay, setTierUpOverlay] = useState<PotentialTier | null>(null);
  // GM7b: 성★ 승급 이펙트 — StarUpResult 자체를 들고 있어 오버레이가 승급된 star/해금 여부를 그대로 쓴다.
  const [starUpOverlay, setStarUpOverlay] = useState<StarUpResult | null>(null);
  const [justUpAttrs, setJustUpAttrs] = useState<Set<string>>(new Set());
  const [justUpLv, setJustUpLv] = useState<Set<string>>(new Set());
  // 레이더 후속(hero 실시간 지시 — "+보너스 탭 잘 안 보여" 제거): 능력치 표시 2레이어 — 레이더(기본) ↔ 막대.
  // 성장/잠재 기여는 별도 탭이 아니라 막대의 cap/base 마커 + 레이더의 cap 점선 폴리곤으로 충분.
  const [layer, setLayer] = useState<"radar" | "total">("radar");

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
  // 밴드 앵커 축 윈도우(hero: "y축 하한 잘라서 드라마틱하게") — 막대·레이더 공통 정규화.
  const axisWindow = computeAxisWindow(grade);
  const pct = (v: number) => normalizeInWindow(v, axisWindow) * 100;
  // 포지션별 6축 매핑(hero 2026-07-26: "FIFA 가 GK 에 다른 6축 쓰는 방식처럼") — 카드 position 으로 선택.
  const position = player.position as Position;
  const radarGroups = RADAR_GROUPS_BY_POSITION[position];
  const chipStats = RADAR_CHIP_STATS_BY_POSITION[position];
  const radarAxes = card
    ? radarGroups.map((g) => ({
        key: g.key,
        label: g.label,
        value: radarAxisValue(g, card.attributes as unknown as Record<string, number>),
        cap: radarAxisValue(g, card.caps as unknown as Record<string, number>),
      }))
    : [];
  const chipAttrs = card?.attributes as unknown as Record<string, number> | undefined;
  const chipCaps = card?.caps as unknown as Record<string, number> | undefined;
  const completion = card ? Math.max(0, Math.min(1, card.completion)) : 0;
  const busy = starUp.isPending || diceRoll.isPending || rollingKind !== null;
  // V2.1-3: 잠재 승급 = 카드 전체 인상을 바꾼다 — 프레임 글로우를 잠재 티어색으로.
  const potentialTier: PotentialTier | null = card?.potential.unlocked ? card.potential.tier : null;
  const frameGlow = potentialTier
    ? `0 0 0 1.5px ${frameColor}55 inset, 0 0 22px 3px ${TIER_COLORS[potentialTier]}66, 0 0 2px 1px ${TIER_COLORS[potentialTier]}`
    : `0 0 0 1.5px ${frameColor}55 inset`;

  const nextStar = (star + 1) as Star;
  const starMaxed = star >= MAX_STAR;
  const starCost = starMaxed ? 0 : STAR_COPY_COST[nextStar as Exclude<Star, 1>];
  const starShort = !starMaxed && player.ownedCount < starCost;

  function handleStarUp() {
    setMessage(null);
    starUp.mutate(player.id, {
      onSuccess: (res) => {
        setStarUpOverlay(res);
      },
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
              // CelebrationOverlay 가 TIERUP_OVERLAY_MS 경과 후 onDone 을 호출해 스스로 정리한다.
              setTierUpOverlay(res.tierAfter);
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
        data-potential-tier={potentialTier ?? ""}
        style={{ borderColor: frameColor, boxShadow: frameGlow }}
      >
        <button type="button" className={styles.close} onClick={onClose} aria-label="닫기">
          ×
        </button>

        <div className={styles.header}>
          {/* #187: 카드 상세/강화 화면이 이 게임에서 **가장 큰 카드 자리**다 — 44px 아바타 대신
              캐릭터 풀아트를 세운다. 이름·등급·별은 바로 옆/아래에 이미 있으므로 `variant="art"`
              (프레임 밴드 없이 아트만) — 안 그러면 빈 네임플레이트 띠가 남는다. 등급은 모달 프레임이
              이미 색으로 말하고 있어 카드 링은 끈다(`ring={false}`) — 테두리가 두 겹이 되면 시끄럽다. */}
          <FullArtCard
            playerId={player.id}
            name={player.name}
            grade={grade}
            position={player.position}
            size="rail"
            variant="art"
            ring={false}
            className={styles.avatar}
          />
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

            <div className={styles.layerToggle} role="tablist" aria-label="능력치 보기" data-testid="growth-attr-layer">
              <button
                type="button"
                role="tab"
                aria-selected={layer === "radar"}
                className={layer === "radar" ? `${styles.layerBtn} ${styles.layerBtnActive}` : styles.layerBtn}
                data-testid="growth-layer-radar"
                onClick={() => setLayer("radar")}
              >
                레이더
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={layer === "total"}
                className={layer === "total" ? `${styles.layerBtn} ${styles.layerBtnActive}` : styles.layerBtn}
                data-testid="growth-layer-total"
                onClick={() => setLayer("total")}
              >
                막대
              </button>
            </div>

            {layer === "radar" && (
              <div className={styles.radarRow} data-testid="growth-radar-row">
                <StatRadar axes={radarAxes} window={axisWindow} size={200} accentColor={frameColor} testId="growth-radar" />
                <div className={styles.sideChips}>
                  {chipStats.map((key) => (
                    <div key={key} className={styles.mentalChip} data-testid={`growth-side-chip-${key}`}>
                      <span className={styles.mentalLabel}>{STAT_LABEL_MAP[key]}</span>
                      <span className={styles.mentalValue}>
                        {Math.round(chipAttrs?.[key] ?? 0)}
                        <span className={styles.mentalCap}> /{Math.round(chipCaps?.[key] ?? 0)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {layer === "total" && (
              <p className={styles.axisWindowLabel} data-testid="growth-attr-window">
                스탯 축 {Math.round(axisWindow.lo)}–{Math.round(axisWindow.hi)}
              </p>
            )}

            {layer === "total" && (
              <dl className={styles.attrs} data-testid="growth-attrs" data-layer={layer}>
                {STAT_LABELS.map(([key, label]) => {
                  const cur = card.attributes[key];
                  const cap = card.caps[key];
                  const base = card.base[key];
                  const sl = card.statLevels[key] ?? { lv: 0, xp: 0 };
                  const xpNeed = xpToNextLevel(sl.lv);
                  const xpPct = clampPct((sl.xp / Math.max(1, xpNeed)) * 100);
                  const lvUp = justUpLv.has(key);
                  const attrUp = justUpAttrs.has(key);
                  // 밴드 앵커 윈도우 정규화 — 막대 width%/left% 는 원시 능력치가 아니라 axisWindow 기준.
                  const curPct = pct(cur);
                  const capPct = pct(cap);
                  const basePct = pct(base);
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
                          <i
                            className={styles.reach}
                            style={{ left: `${curPct}%`, width: `${Math.max(0, capPct - curPct)}%` }}
                          />
                          <i
                            className={attrUp ? `${styles.fill} ${styles.fillUp}` : styles.fill}
                            data-testid={`growth-fill-${key}`}
                            data-value={Math.round(cur)}
                            style={{ width: `${curPct}%` }}
                          />
                          <i className={styles.capLine} style={{ left: `${capPct}%` }} />
                          <i className={styles.baseLine} style={{ left: `${basePct}%` }} />
                        </span>
                      </dd>
                      <span className={`${styles.attrNum} ${styles.attrNumBig}`}>
                        {Math.round(cur)}
                        <span className={styles.attrCap}> /{Math.round(cap)}</span>
                      </span>
                    </div>
                  );
                })}
              </dl>
            )}

            <div
              className={styles.potentialPanel}
              data-testid="growth-potential"
              data-tier={potentialTier ?? "locked"}
              style={potentialTier ? { borderColor: `${TIER_COLORS[potentialTier]}66` } : undefined}
            >
              <div className={styles.potentialHead}>
                <h3 className={styles.sectionTitle}>잠재능력</h3>
                {/* V2.1-3: 전줄 동일 티어라 슬롯별 뱃지 대신 패널 단일 대형 뱃지로 승급을 강조. */}
                {potentialTier && (
                  <span
                    className={styles.tierBadge}
                    data-testid="growth-potential-tier"
                    style={{ color: TIER_COLORS[potentialTier], borderColor: TIER_COLORS[potentialTier] }}
                  >
                    {TIER_LABELS[potentialTier]}
                  </span>
                )}
              </div>
              {!card.potential.unlocked ? (
                <p className={styles.potentialLocked} data-testid="growth-potential-locked">
                  2★에서 해금
                </p>
              ) : (
                card.potential.tier !== card.potential.maxTier && (
                  <div className={styles.ceilingWrap} data-testid="growth-dice-ceiling">
                    <span className={styles.ceilingNote}>
                      승급 보장까지 {Math.max(0, card.potential.ceilingAt - card.potential.rollsSinceTierUp)}회
                    </span>
                    <span className={styles.ceilingBar}>
                      <i
                        style={{
                          width: `${clampPct((card.potential.rollsSinceTierUp / Math.max(1, card.potential.ceilingAt)) * 100)}%`,
                          background: TIER_COLORS[card.potential.tier],
                        }}
                      />
                    </span>
                  </div>
                )
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
                        <span className={styles.slotValue}>{formatPotentialLine(line)}</span>
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
                캐시 다이스 롤 💎
                <span className={styles.costChip} data-testid="growth-dice-cash-owned">
                  보유 {diceBalance?.cash ?? 0} · −1
                </span>
              </button>
            </div>
          </>
        )}

        {tierUpOverlay && (
          // V2.1-3 / GM7b: 티어업 = 전체 오버레이(티어색 플래시 → 전줄 순차 리롤 공개 → 프레임 글로우 전환).
          // 연출 자체는 CelebrationOverlay(재사용 컴포넌트) — 이 파일은 잠재 티어 도메인 값만 채운다.
          <CelebrationOverlay
            variant="tierUp"
            testId="growth-tierup-overlay"
            dataAttrs={{ "data-tier": tierUpOverlay }}
            accentColor={TIER_COLORS[tierUpOverlay]}
            title={TIER_LABELS[tierUpOverlay]}
            subtitle={`잠재 ${TIER_LABELS[tierUpOverlay]} 승급!`}
            durationMs={TIERUP_OVERLAY_MS}
            onDone={() => setTierUpOverlay(null)}
            steps={Array.from({ length: gradeLines }).map((_, i) => (
              <span key={i} className={styles.tierUpDot} />
            ))}
          />
        )}

        {starUpOverlay && (
          // GM7b: 성★ 승급 이펙트(hero 피드백 — "승급에도 이펙트") — ★ 팝(현재 star 수만큼 순차 공개).
          <CelebrationOverlay
            variant="starUp"
            testId="growth-starup-overlay"
            accentColor={STARUP_ACCENT}
            title={`${starUpOverlay.star}★ 달성!`}
            subtitle={starUpSubtitle(starUpOverlay.star)}
            durationMs={STARUP_OVERLAY_MS}
            onDone={() => setStarUpOverlay(null)}
            steps={Array.from({ length: starUpOverlay.star }).map((_, i) => (
              <span key={i} className={styles.starPop}>
                ★
              </span>
            ))}
          />
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

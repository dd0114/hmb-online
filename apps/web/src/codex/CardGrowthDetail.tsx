import { useState } from "react";
import { Modal } from "../common/Modal";
import { ErrorToast } from "../common/ErrorToast";
import { GRADE_COLORS, GRADE_LABELS, GRADE_ORDER, type Grade } from "../common/grades";
import { CharAvatar } from "../common/CharAvatar";
import { ApiError } from "../api/client";
import { useCardEffective, useEnhance, useLimitBreak } from "../api/growth-hooks";
import { ENHANCE_MAX_CODE } from "../api/growth";
import type { CatalogPlayer } from "../api/hooks";
import styles from "./CardGrowthDetail.module.css";

/** 능력치 표시 순서/라벨 — 시안3 목업과 동일(슛 우선, 태클 마지막). */
const ATTRS: Array<[key: keyof CatalogPlayer["attributes"], label: string]> = [
  ["shooting", "슛"],
  ["pace", "스피드"],
  ["positioning", "위치선정"],
  ["technical", "테크닉"],
  ["passing", "패스"],
  ["stamina", "스태미나"],
  ["physical", "피지컬"],
  ["mental", "멘탈"],
  ["tackling", "태클"],
];

const MAX_BREAKTHROUGH = 4; // enhance.maxLimitBreak (시안3 ★ 4칸)
const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R; // ≈ 263.9

/** effectiveGrade − baseGrade = 돌파 단계(0..4). */
function breakthroughSteps(base: Grade, effective: Grade): number {
  const d = GRADE_ORDER.indexOf(effective) - GRADE_ORDER.indexOf(base);
  return Math.max(0, Math.min(MAX_BREAKTHROUGH, d));
}

interface CardGrowthDetailProps {
  player: CatalogPlayer;
  onClose: () => void;
}

/**
 * 보유 카드 성장 상세(시안3 — S2/S3/S4). OVR 원형 링 + 완성도% + 돌파★ + 능력치 막대(현재=green,
 * 천장=노란 마커, 기본=회색 마커). 강화/한계돌파 실행 후 useCardEffective 재조회로 스탯·프레임색 갱신.
 * 바텀시트형 모달(모바일 우선) — 데스크탑에선 중앙 카드.
 */
export function CardGrowthDetail({ player, onClose }: CardGrowthDetailProps) {
  const { data: card, isLoading, isError } = useCardEffective(player.id);
  const enhance = useEnhance();
  const limitBreak = useLimitBreak();

  const [bandMaxed, setBandMaxed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [promotedFlash, setPromotedFlash] = useState(false);

  // effectiveGrade 는 서버 권위 — 로드 전에는 카탈로그 등급으로 프레임을 그린다.
  const effectiveGrade: Grade = card?.effectiveGrade ?? player.grade;
  const baseGrade: Grade = card?.baseGrade ?? player.grade;
  const frameColor = GRADE_COLORS[effectiveGrade];
  const steps = breakthroughSteps(baseGrade, effectiveGrade);
  const completion = card ? Math.max(0, Math.min(1, card.completion)) : 0;
  const busy = enhance.isPending || limitBreak.isPending;

  function handleEnhance() {
    setMessage(null);
    enhance.mutate(player.id, {
      onSuccess: () => {
        setMessage(null);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === ENHANCE_MAX_CODE) {
          setBandMaxed(true);
          setMessage("강화 상한 도달 — 한계돌파로 등급을 올리세요");
        } else {
          setMessage(err instanceof ApiError ? err.message : "강화에 실패했습니다");
        }
      },
    });
  }

  function handleLimitBreak() {
    setMessage(null);
    limitBreak.mutate(player.id, {
      onSuccess: (res) => {
        setBandMaxed(false);
        if (res.promoted) {
          setPromotedFlash(true);
          window.setTimeout(() => setPromotedFlash(false), 1600);
        }
      },
      onError: (err) => {
        setMessage(err instanceof ApiError ? err.message : "한계돌파에 실패했습니다");
      },
    });
  }

  const titleId = `growth-title-${player.id}`;

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
        data-grade={effectiveGrade}
        style={{ borderColor: frameColor, boxShadow: `0 0 0 1.5px ${frameColor}55 inset` }}
      >
        <button type="button" className={styles.close} onClick={onClose} aria-label="닫기">
          ×
        </button>

        <div className={styles.header}>
          <CharAvatar
            playerId={player.id}
            name={player.name}
            grade={effectiveGrade}
            size={44}
            className={styles.avatar}
          />
          <div className={styles.headText}>
            <span className={styles.gradeTag} style={{ color: frameColor }} data-testid="growth-grade">
              {GRADE_LABELS[effectiveGrade]}
            </span>
            <h2 id={titleId} className={styles.name}>
              {player.name}
            </h2>
            <span className={styles.pos}>{player.position}</span>
          </div>
          <div className={styles.stars} data-testid="growth-stars" data-breakthrough={steps}>
            {Array.from({ length: MAX_BREAKTHROUGH }).map((_, i) => (
              <span
                key={i}
                className={i < steps ? styles.star : `${styles.star} ${styles.starOff}`}
                aria-hidden
              >
                ★
              </span>
            ))}
            <span className={styles.tier}>
              돌파 {steps} / {MAX_BREAKTHROUGH}
            </span>
          </div>
        </div>

        {isLoading && <p className={styles.loading}>불러오는 중…</p>}
        {isError && <ErrorToast message="성장 정보를 불러오지 못했습니다" />}

        {card && (
          <>
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
              {ATTRS.map(([key, label]) => {
                const cur = card.attributes[key];
                const cap = card.caps[key];
                const base = card.base[key];
                const clamp = (n: number) => Math.max(0, Math.min(100, n));
                return (
                  <div key={key} className={styles.attrRow} data-testid={`growth-attr-${key}`}>
                    <dt className={styles.attrName}>{label}</dt>
                    <dd className={styles.attrBarCell}>
                      <span className={styles.bar}>
                        <i
                          className={styles.reach}
                          style={{ left: `${clamp(cur)}%`, width: `${clamp(cap - cur)}%` }}
                        />
                        <i
                          className={styles.fill}
                          data-testid={`growth-fill-${key}`}
                          data-value={Math.round(cur)}
                          style={{ width: `${clamp(cur)}%` }}
                        />
                        <i className={styles.capLine} style={{ left: `${clamp(cap)}%` }} />
                        <i className={styles.baseLine} style={{ left: `${clamp(base)}%` }} />
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

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.enhance}
                data-testid="growth-enhance"
                onClick={handleEnhance}
                disabled={busy}
              >
                {enhance.isPending ? "강화 중…" : "강화 (천장↑)"}
              </button>
              <button
                type="button"
                className={bandMaxed ? `${styles.limitBreak} ${styles.limitBreakReady}` : styles.limitBreak}
                data-testid="growth-limitbreak"
                data-ready={bandMaxed ? "true" : "false"}
                onClick={handleLimitBreak}
                disabled={busy}
              >
                {limitBreak.isPending ? "돌파 중…" : "한계돌파 (등급↑)"}
              </button>
            </div>
            {bandMaxed && (
              <p className={styles.readyBadge} data-testid="growth-limitbreak-badge">
                한계돌파 가능 — 다음 등급 밴드를 개방하세요
              </p>
            )}
          </>
        )}

        {promotedFlash && (
          <div className={styles.promoted} data-testid="growth-promoted" role="status">
            등급 승급!
          </div>
        )}
        <ErrorToast message={message} onDismiss={() => setMessage(null)} />
      </div>
    </Modal>
  );
}

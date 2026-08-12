import { useEffect, useRef, useState } from "react";
import { Modal } from "../common/Modal";
import { ErrorToast } from "../common/ErrorToast";
import { CelebrationOverlay } from "../common/CelebrationOverlay";
import { GRADE_COLORS, GRADE_GLOW_COLORS, GRADE_LABELS, type Grade } from "../common/grades";
import { FullArtCard } from "../common/FullArtCard";
import { ApiError } from "../api/client";
import { useCardEffective, useDiceRoll, useStarUp } from "../api/growth-hooks";
import { emitOnRailAction } from "../onrail/onrail-actions";
import { COUPON_FREE_ENHANCE } from "../api/hooks";
import { useMe } from "../api/hooks";
import { useAppConfigValue } from "../common/AppConfigContext";
import {
  INSUFFICIENT_MATERIALS_CODE,
  type PotentialTier,
  type PendingChoice,
  type Star,
  type StarUpResult,
} from "../api/growth";
import {
  GRADE_POTENTIAL_LINES,
  STAR_COPY_COST,
  STAT_LABELS,
  TIER_COLORS,
  TIER_LABELS,
} from "../growth/growth-config";
import { AttributeLayers } from "../growth/AttributeLayers";
import { attributeViewOf } from "../growth/attribute-view";
import { ChoiceCandidates } from "../growth/ChoiceCards";
import type { CatalogPlayer } from "../api/hooks";
import { Amount, useCurrency } from "../common/Amount";
import { balanceFor, CURRENCY_GEM, CURRENCY_POINT } from "../common/currency";
import { clearSkipRollConfirm, persistSkipRollConfirm, rollConfirmSkipped } from "../growth/roll-confirm";
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
  /**
   * 어느 화면에서 열렸나 (#286 W3). 동작은 같다 — **같은 컴포넌트**라는 게 요점이라
   * 분기하지 마라. 계약이 "두 진입점이 같은 시트를 연다"를 확인하는 데만 쓴다.
   */
  source?: "deck" | "players";
}

/**
 * 보유 카드 성장 상세(에픽 #179 §V2-6, GM3 + V2.1-3 GM7 + #405 W2b/W3 성장 개편) — S2/S3/S4/S6:
 * OVR 링 + 완성도 · 카드 레벨/XP · 3지선다 대기 배너 · **능력치 2레이어**(레이더 기본 ↔ 3층 막대) ·
 * ★1~4(성 승급) · 잠재 패널(전줄 동일 티어, 패널·프레임 글로우 승격) · 다이스 롤 + 티어업 오버레이.
 * 프레임 **테두리 색**은 등급(불변, 승급 없음) 고정 — **글로우**는 잠재 티어색(승급 시 전환).
 *
 * ⚠️ **스탯별 `Lv` 뱃지·XP 바는 없다** (#405 W2b) — `statLevels` 는 유효스탯에 관여하지 않는
 * 구 이력이다. 한때 이 자리에 그 설명이 남아 있어 스펙처럼 읽혔다(#403 W3 에서 정정).
 *
 * ⚠️ **능력치 표시는 이 파일이 소유하지 않는다** (#403 W3) — `growth/AttributeLayers` 가 그리고
 * 선수 상세 모달(경기중·상대 포함)이 **같은 컴포넌트**를 쓴다. 여기서 막대를 다시 그리지 마라.
 */
export function CardGrowthDetail({ player, onClose, source = "players" }: CardGrowthDetailProps) {
  // 유상재화 아이콘도 서버 표기 메타에서 (#232) — 이모지를 코드에 박으면 표기 변경이 배포가 된다.
  const gemCurrency = useCurrency(CURRENCY_GEM);
  const { data: card, isLoading, isError } = useCardEffective(player.id);
  const { data: me } = useMe();
  const config = useAppConfigValue();
  const starUp = useStarUp();
  const diceRoll = useDiceRoll();

  const [message, setMessage] = useState<string | null>(null);
  const [rollingKind, setRollingKind] = useState<"NORMAL" | "CASH" | null>(null);
  // #247 확인 단계: 이 상세를 연 뒤 **첫 롤에서만** 묻는다(+ '다시 묻지 않기'는 영구).
  const [pendingRoll, setPendingRoll] = useState<"NORMAL" | "CASH" | null>(null);
  const [confirmedOnce, setConfirmedOnce] = useState(false);
  /** 방금 강화가 **무료 쿠폰으로** 나갔다(서버 `freeByCoupon`) — 지갑이 그대로인 이유를 말한다. */
  const [freeRoll, setFreeRoll] = useState(false);
  /** 남은 무료 강화권 (#493 W6-v3 `/api/me.coupons`). 모르는 서버·구 응답이면 0. */
  const freeEnhanceLeft = Number(
    (me as { coupons?: Record<string, number> } | undefined)?.coupons?.[COUPON_FREE_ENHANCE] ?? 0,
  );
  const [skipConfirm, setSkipConfirm] = useState(() => rollConfirmSkipped());
  const [tierUpOverlay, setTierUpOverlay] = useState<PotentialTier | null>(null);
  // GM7b: 성★ 승급 이펙트 — StarUpResult 자체를 들고 있어 오버레이가 승급된 star/해금 여부를 그대로 쓴다.
  const [starUpOverlay, setStarUpOverlay] = useState<StarUpResult | null>(null);
  const [justUpAttrs, setJustUpAttrs] = useState<Set<string>>(new Set());
  const [pendOpen, setPendOpen] = useState(true);
  /**
   * 배너가 지금 띄우고 있는 선택권 — **카드 응답이 아니라 여기가 소유한다**.
   *
   * ⚠️ 적용에 성공하면 서버가 갱신된 카드를 주고 그 카드의 `pendingChoices` 에서 이 항목이 빠진다.
   * 배너를 `pendingChoices[0]` 로 직접 그리면 그 순간 `ChoiceCandidates` 가 **언마운트되고 축하
   * 오버레이가 같은 프레임에 사라진다**(e2e 가 두 번 잡았다 — 시트에서 한 번, 여기서 한 번).
   * "성공 콜백에서 붙잡기"로는 못 막는다: 캐시 갱신 렌더가 **먼저** 와서 이미 한 번 언마운트되고,
   * 그 뒤 다시 마운트되면서 후보 목록이 되살아난다(실제 실패 스냅샷이 그 모양이었다).
   * 그래서 **처음 대기가 보이는 순간 붙잡고**, 사용자가 [이어서 선택]을 누를 때만 다음으로 넘긴다.
   */
  const [shownChoice, setShownChoice] = useState<PendingChoice | null>(null);

  const prevAttrsRef = useRef<Record<string, number> | null>(null);

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

  /*
   * ⚠️ 구 `statLevels` 델타 플래시(스탯별 Lv 뱃지)는 **제거했다** (#405 W2b). 그 값은 이제
   * 유효스탯에 관여하지 않는다(소급 이관의 입력·롤백 근거로만 남는다) — 안 움직이는 숫자를
   * "성장"으로 계속 띄우면 이 개편이 화면에서 없던 일이 된다.
   */

  const grade: Grade = card?.grade ?? player.grade;
  const frameColor = GRADE_COLORS[grade];
  const star: Star = card?.star ?? 1;
  /** 카드 레벨/XP (#405 W2b additive) — 없으면(구 서버·구 목) 그 블록을 통째로 안 그린다. */
  const cardLevel = card?.cardLevel;
  const maxLevel = card?.maxLevel;
  const cardXp = card?.cardXp ?? 0;
  const xpToNext = card?.xpToNext ?? 0;
  const pendingChoices = Array.isArray(card?.pendingChoices) ? card!.pendingChoices! : [];

  /**
   * 능력치 뷰모델 (#403 W3) — 축·3층·천장 라벨·레이더 축 전부 여기서 나온다.
   * 이 화면은 **내 보유 카드**라 항상 `full` 이다(`base`/`caps` 가 온다). 응답이 손상돼 능력치가
   * 없으면 `null` — 그러면 능력치 블록을 통째로 안 그린다(빈 막대 아홉 줄보다 정직하다).
   */
  const attrView = attributeViewOf(player.position, card ?? undefined);

  const firstPendingId = pendingChoices[0]?.choiceId;

  // 대기가 처음 보이면 붙잡는다(위 주석) — 이미 잡고 있으면 카드가 갱신돼도 놓지 않는다.
  useEffect(() => {
    if (shownChoice || !firstPendingId) return;
    setShownChoice(pendingChoices[0]!);
    // pendingChoices 는 매 렌더 새 배열이라 id 로만 의존한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstPendingId, shownChoice]);

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

  /**
   * #247 리롤 비용 — **서버 config 가 유일한 출처**(`shop.dice`). 여기에 상수를 두면 서버가
   * 가격을 바꿀 때 화면이 조용히 거짓말을 한다(그게 #213 의 형태였다). 미러를 만들지 마라.
   * 키 이름(`dice`)은 계약 안정성을 위해 유지했다 — 의미만 '구매가'에서 '롤 비용'으로 바뀌었다.
   */
  const dicePrice = config?.shop?.dice ?? null;
  const walletPoints = me?.wallet.points ?? 0;
  const walletGems = me?.wallet.gems ?? 0;

  function priceOf(kind: "NORMAL" | "CASH") {
    return kind === "NORMAL" ? dicePrice!.normal : dicePrice!.cash;
  }

  /** 그 결제 재화의 잔액. 모르는 재화면 잠그지 않는다(서버 판정에 맡긴다 — balanceFor 주석). */
  function balanceOfKind(kind: "NORMAL" | "CASH"): number {
    return balanceFor(priceOf(kind).currency, { points: walletPoints, gems: walletGems })
      ?? Number.POSITIVE_INFINITY;
  }

  /**
   * ⚠️ **무료 강화권이 있으면 잔액으로 잠그지 않는다** (#493 W8-v3 blocker-1).
   *
   * 서버는 이 자리를 명시적으로 반대로 정해 놨다 — *"무료면 잔액 검사도 하지 않는다. '공짜인데
   * 잔액이 모자라 못 쓴다'는 쿠폰의 존재 이유를 부정한다"*(`GrowthService`·`TradeService` 머리말).
   * 그런데 화면이 잔액으로 먼저 잠그면 그 규칙이 **유저에게 도달하지 않는다**: 신규 유저 지갑은
   * 3,000 G 인데 노말 다이스는 5,000 G 라, 가입 선물로 받은 무료권을 **한 번도 쓸 수 없다**.
   * 온레일 S5 는 이 버튼을 기다리는 행동형 스텝이라(`skipIfMissing` 없음) 튜토리얼이 거기서 멈춘다.
   *
   * ⚠️ 구 주석("쿠폰 수는 스냅샷이라 서버가 이미 태웠을 수 있다")이 가리킨 위험은 남아 있지만
   * **크기가 다르다** — 낡은 스냅샷으로 열면 402 문구 한 번이고(그 자리에 이미 에러 표시가 있다),
   * 닫아 두면 유저가 튜토리얼에서 갇힌다. 되돌릴 수 있는 실패를 고른다.
   */
  const freeNormalRoll = freeEnhanceLeft > 0;
  const normalShort =
    !!dicePrice && !freeNormalRoll && balanceOfKind("NORMAL") < dicePrice.normal.cost;
  const cashShort = !!dicePrice && balanceOfKind("CASH") < dicePrice.cash.cost;
  /** 잠재 미해금(2★ 미만)이면 롤 자체가 불가 — 서버 `POTENTIAL_LOCKED` 와 같은 조건. */
  const potentialLocked = !card?.potential.unlocked;

  function handleStarUp() {
    setMessage(null);
    starUp.mutate(player.id, {
      onSuccess: (res) => {
        setStarUpOverlay(res);
        // 온레일 S5 — 승급은 **강화(잠재)의 선행 조건**이다(2★ 미만은 서버가 POTENTIAL_LOCKED).
        emitOnRailAction("growth-promote");
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

  /**
   * 롤 요청 진입점 (#247) — 확인이 필요한 상태면 다이얼로그를 띄우고, 아니면 바로 굴린다.
   * "필요한 상태" = 이 상세에서 아직 한 번도 확인하지 않았고 `다시 묻지 않기`도 아닐 때.
   */
  function requestRoll(kind: "NORMAL" | "CASH") {
    if (skipConfirm || confirmedOnce) {
      handleRoll(kind);
      return;
    }
    setMessage(null);
    setPendingRoll(kind);
  }

  function handleRoll(kind: "NORMAL" | "CASH") {
    setMessage(null);
    setRollingKind(kind);
    diceRoll.mutate(
      { playerId: player.id, kind },
      {
        onSuccess: (res) => {
          /* 무료 쿠폰으로 나갔는지는 **서버가 말한다**(#493 W6-v3 `freeByCoupon`). 지갑이 안
             줄어든 이유를 화면이 추측하면(비용 0 을 클라가 계산하면) 쿠폰 규칙이 두 벌이 된다. */
          setFreeRoll(res.freeByCoupon === true);
          emitOnRailAction("growth-enhance"); // 온레일 S5 — 첫 강화
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
          // #247: 부족은 재화 부족이다. 문구는 **서버가 표기 메타로 만든 것**을 그대로 쓴다
          // (#232) — 클라가 "골드가 부족합니다"를 지어내면 표기 변경이 다시 배포가 된다.
          setMessage(err instanceof ApiError ? err.message : "잠재 재설정에 실패했습니다");
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
      dataAttrs={{ "data-growth-source": source }}
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
          {/* #187: 카드 상세/강화 화면 — 44px 아바타 대신 캐릭터 풀아트를 세운다.
              크기는 `detail`(132) — 이 화면이 카드를 **가장 크게** 보여주는 자리여야 하는데
              처음엔 `rail`(88)을 써서 뽑기 그리드(104)·트레이드(132)보다 작았다(독립 검증 minor-1).
              이름·등급·별은 바로 옆에 이미 있으므로 `variant="art"`(프레임 밴드 없이 아트만) —
              안 그러면 빈 네임플레이트 띠가 남는다. 등급은 모달 프레임이 이미 색으로 말하고 있어
              카드 링은 끈다(`ring={false}`) — 테두리가 두 겹이 되면 시끄럽다. */}
          <FullArtCard
            playerId={player.id}
            name={player.name}
            grade={grade}
            position={player.position}
            size="detail"
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

        {/*
          카드 레벨 + XP 진행바 (#405 §2.10, 목업 화면 ⑤ — ★ 아래 한 줄).
          ⚠️ **헤더 플렉스 안에 넣지 마라.** `headText` 는 아트와 ★ 사이에 낀 좁은 칼럼이라
          `Lv 12 / 40` 과 `60 / 346 XP` 가 서로 밀어 두 줄로 접힌다(실화면 캡처로 확인).
          값이 없으면(W2b 이전 서버·구 목) **블록 자체를 안 그린다** — `Lv 0 / 0` 은 거짓이다.
          임계(`xpToNext`)도 서버가 준 값이지 클라 곡선이 아니다.
        */}
        {typeof cardLevel === "number" && (
          <div className={styles.lvBlock} data-testid="growth-card-level" data-level={cardLevel}>
            <div className={styles.lvBlockTop}>
              <span className={styles.lvBig}>Lv {cardLevel}</span>
              {typeof maxLevel === "number" && <span>/ {maxLevel}</span>}
              <span className={styles.lvXpNum} data-testid="growth-card-xp">
                {xpToNext > 0 ? `${cardXp} / ${xpToNext} XP` : "만렙"}
              </span>
            </div>
            <span className={styles.lvBar}>
              <i
                className={styles.lvBarFill}
                style={{ width: `${xpToNext > 0 ? clampPct((cardXp / xpToNext) * 100) : 100}%` }}
              />
            </span>
          </div>
        )}

        {isLoading && <p className={styles.loading}>불러오는 중…</p>}
        {isError && <ErrorToast message="성장 정보를 불러오지 못했습니다" />}

        {card && (
          <>
            {/*
              **미룬 3지선다를 여기서 찍는다** (#405 §2.10). 최상단에 세우는 이유는 유저가 이
              화면에 온 이유가 대부분 그것이기 때문이다(보상 시트에서 [나중에 선택]을 눌렀다).
              후보 카드는 보상 시트와 **같은 컴포넌트**다 — 두 자리에서 모양이 갈리면 안 된다.
              접기가 기본이 아니다: 접힌 채 두면 뱃지만 보이고 할 일이 안 보인다.
            */}
            {shownChoice && (
              <div
                className={styles.pendBanner}
                data-testid="growth-pending-banner"
                data-open={pendOpen ? "true" : "false"}
              >
                <div className={styles.pendBannerTop}>
                  <span>{pendingChoices.length > 0 ? `선택 대기 ${pendingChoices.length}` : "성장 적용 완료"}</span>
                  {/*
                   * **[나중에] → 글로우 버튼** (#457 D, hero 지시: *"유저가 누른다→강화 적용 /
                   * 나중에→강화 가능하다는거 버튼 활성화된상태로 선수 정보"*).
                   *
                   * 미루는 손잡이는 보상 시트의 `reward-pick-later` 와 **같은 성질**이다 — 다만
                   * 여기서는 화면을 닫지 않고 **선수 정보로 내려간다**. 접힌 뒤 남는 것이 회색
                   * "펼치기" 면 hero 가 지적한 *"너무 정적이야 … 정보량이 많아서 안 보여"* 로
                   * 되돌아가므로, 대기가 남아 있는 동안은 **빛나는 버튼**이 그 자리를 지킨다.
                   */}
                  {pendOpen && (
                    <button
                      type="button"
                      className={styles.pendToggle}
                      data-testid="growth-pending-toggle"
                      aria-expanded={pendOpen}
                      onClick={() => setPendOpen(false)}
                    >
                      {pendingChoices.length > 0 ? "나중에" : "접기"}
                    </button>
                  )}
                </div>
                {!pendOpen &&
                  (pendingChoices.length > 0 ? (
                    <button
                      type="button"
                      className={styles.pendGlow}
                      style={{ ["--glow" as string]: GRADE_GLOW_COLORS[grade] }}
                      data-testid="growth-pending-open"
                      aria-expanded={false}
                      onClick={() => setPendOpen(true)}
                    >
                      ✦ 강화 가능 — 선택지 보기
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.pendToggle}
                      data-testid="growth-pending-toggle"
                      aria-expanded={false}
                      onClick={() => setPendOpen(true)}
                    >
                      펼치기
                    </button>
                  ))}
                {pendOpen && (
                  <div className={styles.pendBannerBody}>
                    <ChoiceCandidates
                      key={shownChoice.choiceId}
                      choice={shownChoice}
                      card={card}
                    />
                    {pendingChoices[0] && pendingChoices[0].choiceId !== shownChoice.choiceId && (
                      <button
                        type="button"
                        className={styles.pendNext}
                        data-testid="growth-pending-next"
                        onClick={() => setShownChoice(pendingChoices[0]!)}
                      >
                        이어서 선택 {pendingChoices.length}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

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

            {/*
              능력치 표시 = **공용 컴포넌트**(#403 W3). 선수 상세 모달(경기중·상대 포함)이 같은
              것을 쓴다 — `ChoiceCards` 와 같은 이유로, 호출부가 흉내 내면 한쪽만 낡는다.
              레이어 상태·축·3층 계산은 전부 그쪽이 소유한다. 여기서 다시 그리지 마라.
            */}
            {attrView && (
              <AttributeLayers view={attrView} accentColor={frameColor} highlight={justUpAttrs} />
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

            {/*
              #247: 구매 단계가 사라졌다 — 이 버튼이 곧 결제다. 가격·재화는 서버 config 에서만
              온다(`shop.dice`, #232 — 미러 상수를 만들면 #213 이 재발한다). 잔액 게이팅은
              **결제 재화 기준**이고, 모르는 재화면 잠그지 않고 서버 판정에 맡긴다.

              ⚠️ **잠재 해금(2★)도 같이 잠근다.** 구 UI 는 "보유 다이스 ≥ 1" 이 사실상 이 자리를
              가려 줬지만(신규 유저 재고 0), 게이팅이 재고→잔액으로 바뀌면서 1★ 카드에서도 버튼이
              열려 **"5,000 G 차감" 확인창이 뜨는데 서버는 POTENTIAL_LOCKED 로 거절**했다
              (독립검증 major-2). 재화가 나가진 않지만 실행 불가한 액션에 차감을 약속하면 안 된다 —
              신규 유저 컬렉션은 대부분 1★다.
            */}
            <div className={styles.diceRow}>
              <button
                type="button"
                className={styles.diceBtn}
                data-testid="growth-dice-normal"
                onClick={() => requestRoll("NORMAL")}
                disabled={busy || !dicePrice || potentialLocked || normalShort}
              >
                잠재 재설정
                {dicePrice && (
                  /*
                   * 무료 강화권이 있으면 **값을 지우지 않고 그어서** 보여 준다 (#493 W7-v3).
                   * 지우면 "원래 얼마인가"를 배울 기회가 사라지고, 쿠폰을 다 쓴 다음 화면이
                   * 갑자기 값을 요구하는 것처럼 보인다.
                   *
                   * ⚠️ **이 단락의 구 문장은 철회됐다** (#493 W8-v3, 독립 검증 3R minor-3).
                   * 여기엔 *"잔액 게이팅은 건드리지 않았다"* 고 적혀 있었고 그 근거로 "쿠폰 스냅샷이
                   * 낡았을 수 있다"를 들었다. 그 판단이 **신규 유저에게서 뒤집혔다** — 지갑 3,000 G <
                   * 다이스 5,000 G 라, 잠그면 가입 선물로 받은 무료권을 **한 번도 못 쓴다**(온레일 S5 가
                   * 거기서 멈춘다). 지금은 `freeNormalRoll` 이 잔액 축만 면제한다(위 `:207` 머리말).
                   * 낡은 스냅샷의 대가는 402 문구 한 번이고, 그건 되돌릴 수 있는 실패다.
                   */
                  <span
                    className={freeEnhanceLeft > 0 ? styles.costChipFree : styles.costChip}
                    data-testid="growth-dice-normal-price"
                    data-free={freeEnhanceLeft > 0 ? "true" : "false"}
                  >
                    <Amount code={dicePrice.normal.currency} value={dicePrice.normal.cost} />
                  </span>
                )}
                {freeEnhanceLeft > 0 && (
                  <span className={styles.freeChip} data-testid="growth-dice-free">
                    무료권
                  </span>
                )}
              </button>
              <button
                type="button"
                className={styles.diceBtn}
                data-testid="growth-dice-cash"
                onClick={() => requestRoll("CASH")}
                disabled={busy || !dicePrice || potentialLocked || cashShort}
              >
                고급 재설정 <span aria-hidden="true">{gemCurrency.icon}</span>
                {dicePrice && (
                  <span className={styles.costChip} data-testid="growth-dice-cash-price">
                    <Amount code={dicePrice.cash.currency} value={dicePrice.cash.cost} />
                  </span>
                )}
              </button>
            </div>
            {freeRoll && (
              /* 지갑이 그대로인 **이유**를 말한다 — 서버가 `freeByCoupon` 으로 알려준 사실이지
                 클라가 비용에서 추론한 값이 아니다. */
              <p className={styles.freeNote} data-testid="growth-free-applied">
                무료 강화권을 사용했습니다 — 비용이 나가지 않았어요.
              </p>
            )}
            <p className={styles.walletLine} data-testid="growth-wallet">
              보유 <Amount code={CURRENCY_POINT} value={walletPoints} icon /> ·{" "}
              <Amount code={CURRENCY_GEM} value={walletGems} icon />
            </p>
            <p className={styles.rollHint}>
              {potentialLocked
                ? "잠재 재설정은 2★부터 — 먼저 성 승급이 필요합니다"
                : "고급 재설정 = 상위 옵션 확률 ↑ (승급 판정 없음)"}
            </p>
          </>
        )}

        {/*
          hero 확정(#247): 탭 한 번에 재화가 나가므로 **첫 롤에서만** 확인한다. 매번 물으면
          천장까지 25~84회를 눌러야 하는 흐름에서 방해가 되고, 아예 안 물으면 오조작으로
          한 판 값이 날아간다. `다시 묻지 않기` 는 localStorage 에 남아 다음 세션에도 유지된다.
        */}
        {pendingRoll && dicePrice && (
          <div className={styles.confirmOverlay} data-testid="growth-roll-confirm">
            <div className={styles.confirmBox} role="dialog" aria-modal="true" aria-label="잠재 재설정 확인">
              <p className={styles.confirmTitle}>잠재를 다시 굴릴까요?</p>
              {/*
                ⚠️ **무료권이 걸리는 롤에서는 차감을 약속하지 않는다** (#493 W8-v3).
                확인창이 "5,000 G 차감 · 남은 잔액 0 G"라고 말해 놓고 실제로는 한 푼도 안 나가면
                (서버 `freeByCoupon`) 유저는 다음부터 이 창의 숫자를 믿지 않는다. 잔액이 비용보다
                적을 때는 그 문장이 아예 성립하지도 않는다(신규 유저의 첫 강화가 정확히 그 상태다).
              */}
              {freeNormalRoll && pendingRoll === "NORMAL" ? (
                <p className={styles.confirmCost} data-testid="growth-roll-confirm-free">
                  무료 강화권 사용 · <b data-testid="growth-roll-confirm-after">차감 없음</b>
                </p>
              ) : (
              <p className={styles.confirmCost}>
                <Amount
                  code={priceOf(pendingRoll).currency}
                  value={priceOf(pendingRoll).cost}
                  icon
                />{" "}
                차감 · 남은 잔액{" "}
                <b data-testid="growth-roll-confirm-after">
                  <Amount
                    code={priceOf(pendingRoll).currency}
                    value={Math.max(0, balanceOfKind(pendingRoll) - priceOf(pendingRoll).cost)}
                  />
                </b>
              </p>
              )}
              {/*
                체크하는 즉시 저장한다 — [확인]에 묶어 두면 "다시 묻지 않기를 켜고 이번엔 취소"가
                다음 세션에 잊혀진다(독립검증 minor-8). 체크는 그 자체로 유저의 표명이다.
              */}
              <label className={styles.confirmSkip}>
                <input
                  type="checkbox"
                  data-testid="growth-roll-confirm-skip"
                  checked={skipConfirm}
                  onChange={(e) => {
                    setSkipConfirm(e.target.checked);
                    if (e.target.checked) persistSkipRollConfirm();
                    else clearSkipRollConfirm();
                  }}
                />
                다시 묻지 않기
              </label>
              <div className={styles.confirmActions}>
                <button
                  type="button"
                  className={styles.confirmCancel}
                  data-testid="growth-roll-confirm-cancel"
                  onClick={() => setPendingRoll(null)}
                >
                  취소
                </button>
                <button
                  type="button"
                  className={styles.confirmOk}
                  data-testid="growth-roll-confirm-ok"
                  onClick={() => {
                    const kind = pendingRoll;
                    setPendingRoll(null);
                    setConfirmedOnce(true);
                    handleRoll(kind);
                  }}
                >
                  재설정
                </button>
              </div>
            </div>
          </div>
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

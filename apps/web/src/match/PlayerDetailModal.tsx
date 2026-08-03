import { useState } from "react";
import { Modal } from "../common/Modal";
import { CharAvatar } from "../common/CharAvatar";
import { GRADE_LABELS, type Grade } from "../common/grades";
import { usePlayers, useDeck } from "../api/hooks";
import { useCardEffective } from "../api/growth-hooks";
import { AttributeLayers } from "../growth/AttributeLayers";
import { attributeViewOf, type AttributeSource } from "../growth/attribute-view";
import { findPlayerStat, playerKey } from "./player-stats";
import { coverageLabel, isMotmKey, ratingTier, type PlayerSelection } from "./player-stats-view";
import { categoriesFor, heatDensities, kpiFor } from "./player-detail-view";
import type { MatchPlayerStats } from "./usePlayerStats";
import styles from "./PlayerDetailModal.module.css";

/**
 * **선수 상세 모달** (#403 W3, 목업 화면 ③④) — 두 탭: `[이 경기]` / `[선수 정보]`.
 *
 * 요구 F = "선수 상세 = 스탯 + 성장(승급), 경기중에도, 상대도". 결정 ②(hero) 대로 **기록은
 * 상대도 우리와 완전히 동일**하고, 결정 ③ 대로 **지시(프롬프트)만 비공개**다.
 *
 * ## 여기서 다시 계산하는 것은 없다
 *  · 집계 = `useMatchPlayerStats`(W1/W2) — 셸이 한 번 돌린 **같은 결과**를 받는다(선수 탭과 값이
 *    갈리면 그 자리에서 신뢰를 잃는다).
 *  · 상한·캡션 = `stats.window`(`statsWindow` 단일 출처). **분을 다시 조립하지 마라** — BL-1 이
 *    정확히 그 자리였다("7분까지의 기록" 위에 전 선수 0).
 *  · 능력치 = `growth/AttributeLayers` — 강화탭과 **같은 컴포넌트**(hero 지시 2026-08-02).
 *
 * ## 데이터 경계 — 남의 카드는 **성장 진행도가 없다**
 * `useCardEffective` 는 **보유 카드 전용**이다(`growth-hooks` 명시). 상대·타 유저 선수는
 * 카탈로그 `attributes`(= **발행 기본치**) 뿐이라 `base`/`caps`/`statAdd`/`startLo` 가 없고,
 * 그래서 능력치가 **축소 모드**로 그려진다(3층·천장·레이더 캡 없음). 그 사실을 화면이 말한다 —
 * 없는 층을 0 으로 채우면 "성장분 0"이라는 거짓이 된다.
 *
 * ## 열람 전용이다
 * 강화·리롤·3지선다 버튼을 **넣지 않는다**(목업 ④ 명시). 경기 중에 카드를 강화하게 만드는 것은
 * 이 요구가 아니고, 진행 중 매치에서는 서버가 성장 선택을 거부한다(#217 AC2).
 *
 * ⚠️ 아트는 `CharAvatar` 다 — `FullArtCard` 가 아니다. 이 모달은 **매치 화면 위**에 뜨는데
 * 경계 표(`apps/web/CLAUDE.md`)가 매치 화면을 아이콘으로 못 박았고 `p3-card-art.spec.ts` 의
 * "매치·로비에 풀아트가 없다"가 그 계약이다. `grade` 는 필수 prop 이라 모르면 아예 안 그린다
 * (fail-closed) — 그 자리는 선수 탭과 같은 **팀색 원 + 등번호**로 떨어진다.
 */
export interface PlayerDetailModalProps {
  selection: PlayerSelection;
  stats: MatchPlayerStats;
  /** 그 선수가 선 팀의 표시 이름(사이드 기준 — `homeName`/`awayName`). */
  teamName: string;
  /** 내 팀 선수인가. 모르면 false — 거짓으로 남의 지시를 열지 않는다(fail-closed). */
  mine: boolean;
  onClose: () => void;
}

type DetailTab = "match" | "info";

const TAB_LABELS: Record<DetailTab, string> = { match: "이 경기", info: "선수 정보" };

export function PlayerDetailModal({ selection, stats, teamName, mine, onClose }: PlayerDetailModalProps) {
  const [tab, setTab] = useState<DetailTab>("match");
  const { team, playerId } = selection;
  const { result, roster, coverage, window: win } = stats;

  const meta = roster.get(playerKey(team, playerId));
  const line = result ? findPlayerStat(result, team, playerId) : undefined;

  // ⚠️ `Array.isArray` 가드 — `/api/players` 가 배열이 아닐 수 있다(구 서버·목의 `200 {}`).
  const { data: catalog } = usePlayers();
  const catalogPlayer = Array.isArray(catalog) ? catalog.find((p) => p.id === playerId) : undefined;

  /**
   * 성장 카드는 **내 보유 카드일 때만** 조회한다(`useCardEffective` 는 owned 전용).
   * 보유 여부를 아직 모르면 조회하지 않는다 — 404 를 부르는 대신 축소 모드로 성립시킨다.
   */
  const cardId = mine && catalogPlayer?.owned === true ? playerId : undefined;
  const { data: card } = useCardEffective(cardId);

  /** 내 선수의 지시는 **덱이 소유**한다(매치 시점 덮어쓰기는 조회 API 가 없다 — 지어내지 않는다). */
  const { data: deck } = useDeck();
  const promptText = mine
    ? deck?.slots?.find((s) => s.playerId === playerId)?.promptText?.trim() || null
    : null;

  const position = meta?.position ?? catalogPlayer?.position ?? null;
  const isGk = position === "GK";
  const name = meta?.name ?? catalogPlayer?.name ?? playerId;
  const grade = (catalogPlayer?.grade ?? null) as Grade | null;

  /**
   * 능력치 뷰모델 — 내 카드가 오면 `full`, 아니면 카탈로그로 `reduced`.
   * ⚠️ 카드 응답이 손상되면(`{}`) `attributeViewOf` 가 null 을 주므로 **카탈로그로 떨어진다** —
   * 형태를 믿지 않는다(#245/#251 규율).
   */
  const cardView = attributeViewOf(position, card as AttributeSource | undefined);
  const catalogView = attributeViewOf(
    position,
    catalogPlayer ? { attributes: catalogPlayer.attributes } : undefined,
  );
  const attrView = cardView ?? catalogView;

  const motm = result != null && win.kind === "settled" && isMotmKey(result, playerKey(team, playerId));
  const titleId = `pdetail-title-${team}-${playerId}`;

  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      overlayClassName={styles.overlay}
      className={styles.sheet}
      testId="player-detail"
      dataAttrs={{ "data-team": team, "data-player": playerId, "data-mine": String(mine) }}
      overlayTestId="player-detail-overlay"
    >
      <div className={styles.frame}>
        <button type="button" className={styles.close} onClick={onClose} aria-label="닫기">
          ×
        </button>

        <div className={styles.head}>
          {/* 아트 정책(#285): 등급을 모르면 아예 안 그린다 → 선수 탭과 같은 팀색 원 + 등번호. */}
          {grade ? (
            <CharAvatar playerId={playerId} name={name} grade={grade} size={56} className={styles.avatar} />
          ) : (
            <i
              className={`${styles.num} ${team === "home" ? styles.numHome : styles.numAway}`}
              aria-hidden="true"
            >
              {meta?.num ?? "–"}
            </i>
          )}
          <div className={styles.headText}>
            <h2 id={titleId} className={styles.name}>
              {name}
              {position && <span className={styles.pos}>{position}</span>}
              {meta?.num && <span className={styles.shirt}>#{meta.num}</span>}
            </h2>
            <p className={styles.sub}>
              {teamName}
              {mine && <span className={styles.mineTag}>내 팀</span>}
              {grade && <span> · {GRADE_LABELS[grade]}</span>}
              {typeof card?.star === "number" && <span> ★{card.star}</span>}
            </p>
          </div>
          {line && (
            <div className={styles.ratingWrap}>
              <i
                className={styles.rating}
                data-tier={ratingTier(line.rating, motm)}
                data-testid="pdetail-rating"
              >
                {line.rating.toFixed(1)}
              </i>
              <span className={styles.ratingLbl}>{motm ? "MOTM" : "평점"}</span>
            </div>
          )}
        </div>

        <div className={styles.tabs} role="tablist" aria-label="선수 상세">
          {(["match", "info"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === tab}
              className={t === tab ? `${styles.tab} ${styles.tabOn}` : styles.tab}
              data-testid={`pdetail-tab-${t}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {/*
          ⚠️ **`key={tab}` 가 필요하다 — 없으면 새 탭이 이미 스크롤된 채로 열린다.**
          이 `div` 가 모달의 유일한 스크롤러이고 탭이 바뀌어도 **같은 DOM 노드**라 앞 탭의
          `scrollTop` 을 그대로 물고 간다. [이 경기]는 길어서 유저가 내려 보게 되고, 그 상태로
          [선수 정보]로 넘어가면 **OVR·완성도·레이더가 위로 잘린 채** 시작한다(실화면 캡처로
          확인 — 계약은 전부 green 이었다). `StageShell` 시트가 같은 함정을 먼저 겪었다(#403 W2).
        */}
        <div key={tab} className={styles.body} data-testid={`pdetail-panel-${tab}`}>
          {tab === "match" ? (
            <MatchTab line={line} isGk={isGk} caption={win.caption} coverage={coverage} bins={result?.heatBins} />
          ) : (
            <InfoTab
              attrView={attrView}
              card={card}
              grade={grade}
              mine={mine}
              promptText={promptText}
            />
          )}
        </div>

        <button type="button" className={styles.closeBtn} onClick={onClose} data-testid="pdetail-close">
          닫기
        </button>
      </div>
    </Modal>
  );
}

// ── [이 경기] ─────────────────────────────────────────────────────────────────

function MatchTab({
  line,
  isGk,
  caption,
  coverage,
  bins,
}: {
  line: ReturnType<typeof findPlayerStat>;
  isGk: boolean;
  caption: string | null;
  coverage: number | null;
  bins: { cols: number; rows: number } | undefined;
}) {
  if (!line) {
    return (
      <p className={styles.note} data-testid="pdetail-no-record">
        이 경기 기록이 없습니다
      </p>
    );
  }
  const cats = categoriesFor(line, isGk, coverageLabel(coverage));
  const heat = heatDensities(line.heat);

  return (
    <>
      {/* 라이브면 "N분까지" — 확정된 하프면 이 줄이 아예 없다(`statsWindow` 단일 출처). */}
      {caption && (
        <p className={styles.liveCap} data-testid="pdetail-live-caption">
          ⏱ {caption}
        </p>
      )}

      <div className={styles.kpi} data-testid="pdetail-kpi">
        {kpiFor(line, isGk).map((k) => (
          <div key={k.key} data-testid={`pdetail-kpi-${k.key}`}>
            <b>{k.value}</b>
            <span>{k.label}</span>
          </div>
        ))}
      </div>

      {cats.map((cat) => (
        <section key={cat.key} data-testid={`pdetail-cat-${cat.key}`}>
          <h3 className={styles.cat}>{cat.title}</h3>
          <dl className={styles.slist}>
            {cat.items.map((it) => (
              <div key={it.key} className={it.dim ? styles.dim : undefined} data-testid={`pdetail-stat-${it.key}`}>
                <dt>{it.label}</dt>
                <dd>{it.value}</dd>
              </div>
            ))}
          </dl>
          {cat.bar != null && (
            <span className={styles.bar}>
              <i style={{ width: `${Math.max(0, Math.min(1, cat.bar)) * 100}%` }} />
            </span>
          )}
          {cat.note && (
            <p className={styles.incomplete} data-testid={`pdetail-note-${cat.key}`}>
              {cat.note}
            </p>
          )}
        </section>
      ))}

      {/*
        히트맵 — 매 틱 좌표가 로그에 있어 엔진 무접촉으로 나온다(W0 §1-1). 값이 전부 0 이면
        격자를 안 그린다: 균일한 회색은 "여기저기 다녔다"는 거짓 신호다(`heatDensities`).
      */}
      {heat.length > 0 && bins && (
        <section data-testid="pdetail-cat-heat">
          <h3 className={styles.cat}>히트맵</h3>
          <div
            className={styles.heat}
            data-testid="pdetail-heat"
            data-cols={bins.cols}
            data-rows={bins.rows}
            style={{ gridTemplateColumns: `repeat(${bins.cols}, 1fr)` }}
            aria-hidden="true"
          >
            {heat.map((d, i) => (
              <i key={i} style={{ opacity: d }} />
            ))}
          </div>
          <p className={styles.heatCap}>피치 좌표 그대로 — 위 경기장과 같은 방향</p>
        </section>
      )}
    </>
  );
}

// ── [선수 정보] ───────────────────────────────────────────────────────────────

function InfoTab({
  attrView,
  card,
  grade,
  mine,
  promptText,
}: {
  attrView: ReturnType<typeof attributeViewOf>;
  card: ReturnType<typeof useCardEffective>["data"];
  grade: Grade | null;
  mine: boolean;
  promptText: string | null;
}) {
  return (
    <>
      {/* OVR·완성도는 **내 카드에만** 있다(카탈로그엔 없다) — 없으면 이 줄을 안 그린다. */}
      {card && typeof card.ovr === "number" && (
        <div className={styles.ovrRow} data-testid="pdetail-ovr">
          <b>{Math.round(card.ovr)}</b>
          <span>OVR</span>
          {typeof card.completion === "number" && (
            <span className={styles.completion}>완성도 {Math.round(card.completion * 100)}%</span>
          )}
        </div>
      )}

      <h3 className={styles.cat}>능력치</h3>
      {attrView ? (
        <AttributeLayers view={attrView} radarSize={176} />
      ) : (
        <p className={styles.note} data-testid="pdetail-no-attrs">
          능력치 정보를 불러오지 못했습니다
        </p>
      )}

      {/*
        성장 · 승급은 **자리만**이다(#403 기술노트 · 목업 ④). 형상은 #405 가 정하고, 여기서
        3지선다·강화·리롤 버튼을 끌어오지 않는다 — 경기 중에 카드를 키우게 만드는 것은 이 요구가
        아니다. 값은 **받은 것만** 그린다(카탈로그엔 성·잠재·레벨이 없다).
      */}
      <h3 className={styles.cat}>성장 · 승급</h3>
      <dl className={styles.slist} data-testid="pdetail-growth">
        <div className={grade ? undefined : styles.dim}>
          <dt>등급</dt>
          <dd>{grade ? GRADE_LABELS[grade] : "—"}</dd>
        </div>
        {typeof card?.star === "number" && (
          <div data-testid="pdetail-growth-star">
            <dt>성(★)</dt>
            <dd>★{card.star}</dd>
          </div>
        )}
        {typeof card?.cardLevel === "number" && (
          <div data-testid="pdetail-growth-level">
            <dt>카드 레벨</dt>
            <dd>
              Lv {card.cardLevel}
              {typeof card.maxLevel === "number" ? ` / ${card.maxLevel}` : ""}
            </dd>
          </div>
        )}
        {card?.potential?.unlocked && (
          <div data-testid="pdetail-growth-tier">
            <dt>잠재 티어</dt>
            <dd>{card.potential.tier}</dd>
          </div>
        )}
      </dl>
      <p className={styles.readonly} data-testid="pdetail-readonly">
        열람 전용입니다 — 강화·잠재 재설정은 강화 화면에서 합니다
      </p>

      <h3 className={styles.cat}>지시(프롬프트)</h3>
      {mine ? (
        promptText ? (
          <p className={styles.prompt} data-testid="pdetail-prompt">
            “{promptText}”
          </p>
        ) : (
          <p className={`${styles.note} ${styles.dim}`} data-testid="pdetail-prompt-empty">
            이 선수에게 준 지시가 없습니다
          </p>
        )
      ) : (
        /*
          결정 ③ = 타 유저 공개 범위에서 **지시문은 비공개**다.
          ⚠️ 목업은 `🔒 지시 있음 — 내용 비공개` 인데 그렇게 쓰지 않았다 — **있는지 없는지를 우리가
          모른다**. `MatchDetail.opponent.deck[]` 의 `hasPrompt` 는 `playerId` 가 없어 선수와 이을
          수 없고(W3 실측), 봇 상대는 지시가 아예 없을 수도 있다. 모르는 것을 "있다"고 말하는 것이
          곧 화면의 거짓말이라 **비공개라는 사실만** 말한다.
        */
        <p className={styles.locked} data-testid="pdetail-prompt-locked">
          🔒 지시(프롬프트)는 비공개입니다 — 기록만 공개됩니다
        </p>
      )}
    </>
  );
}

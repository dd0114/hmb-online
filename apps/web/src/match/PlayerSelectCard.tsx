import { useEffect, useRef, useState } from "react";
import {
  CARD_HOME,
  CARD_INSET,
  pickCardPlacement,
  samePlacement,
  type CardPlacement,
  type RingOnStage,
  type TeamSide,
} from "./player-selection";
import { positionKo } from "./position-label";
import styles from "./PlayerSelectCard.module.css";

/**
 * 선택한 선수의 **신원 카드** (#406 W4, 요구 5-2) — 무대 위 오버레이.
 *
 * <h3>이 카드가 하지 않는 일</h3>
 * <ul>
 *   <li><b>얼굴 아트를 그리지 않는다</b> — 경기장 자리의 노출 정책(#285)은 "등급 임계 아래는 팀색
 *       원 + 등번호"다. 카드가 아트를 그리면 하이라이트가 그 정책의 우회로가 된다. 그래서 여긴
 *       <b>등급을 조회하지도 않고</b>(조회하면 다음 사람이 "다이아면 얼굴을"이라고 붙인다)
 *       피치 토큰과 같은 그림 — 팀색 디스크 + 등번호 — 만 쓴다.</li>
 *   <li><b>기록·스탯 탭을 만들지 않는다</b> — 그건 #403(선수 기록·상세 모달)이 소유한다. 그 진입점이
 *       확정되면 {@link PlayerSelectCardProps.onOpenDetail} 에 배선한다. 프롭이 없으면 버튼도
 *       없다(반쪽 버튼을 화면에 남기지 않는다).</li>
 *   <li><b>지시 입력칸을 두지 않는다</b> — 지시 대상 선택의 SoT 는 `후반 지시`/`감독` 패널이다
 *       (`player-selection.ts` 머리말의 두 축 표). 여기에 칸을 하나 더 만들면 같은 문장을 고치는
 *       자리가 둘이 되고, 그건 #284 가 정확히 없앤 상태다.</li>
 * </ul>
 */
export interface PlayerSelectCardProps {
  team: TeamSide;
  playerId: string;
  /** 넓은 자리라 **풀네임**(#406 요구 6 의 두 축). 못 찾았으면 부모가 폴백 문구를 넣어 준다. */
  name: string;
  /** 등번호 — 피치 토큰이 실제로 그린 값. 없으면 디스크에 아무것도 안 찍는다. */
  num?: string | null;
  position?: string | null;
  teamName?: string | null;
  /** 내 팀 선수인가. **`null` = 모른다** → 뱃지를 달지 않는다(거짓 표식 금지, #322 규율). */
  mine: boolean | null;
  onClose: () => void;
  /** #403 선수 상세 진입점(확정되면 배선). 없으면 버튼을 그리지 않는다. */
  onOpenDetail?: (playerId: string, team: TeamSide) => void;
  /**
   * **지금 그려진 선택 링 전부**(무대 상대 CSS 좌표). 카드가 그 링들을 하나도 덮지 않는 자리로
   * 비킨다 (#406 W6 MAJOR-A — 규칙은 `player-selection.pickCardPlacement`).
   *
   * <p>⚠️ **카드가 보여주는 그 선수의 링 하나가 아니다.** 이 화면은 팀당 1명씩 **동시 2명**을
   * 지원하는데, W6 은 마지막에 누른 선수의 링만 피해 **먼저 고른 선수의 링을 100% 덮었다**
   * (W7 BLOCKER-1). 카드가 무엇을 보여주든 **화면에 켜진 링은 전부** 살아 있어야 한다.
   *
   * <p>왜 값이 아니라 **게터**인가: 선수는 재생 중에 계속 움직인다. 값으로 받으면 부모가
   * 프레임마다 리렌더돼야 하고(무대는 초당 60프레임이다 — `VisualPlayback` 이 시계·스크럽을
   * ref 로 미는 것과 같은 이유), 선택 시점에 한 번만 받으면 그 뒤로 낡는다. 카드가 자기 리듬으로
   * 물어보고 <b>자리가 실제로 바뀔 때만</b> 자기 자신을 다시 그린다.
   *
   * <p>안 주면 종전 그대로 왼쪽 위 고정이다(코어 없는 스토리·단위 테스트 경로).
   */
  ringsAt?: () => readonly RingOnStage[];
}

/** 링 위치를 다시 물어보는 주기(ms). 초당 5회 — 사람 눈에 즉각이고 리렌더는 무시할 만하다. */
const PLACE_POLL_MS = 200;

export function PlayerSelectCard({
  team,
  playerId,
  name,
  num = null,
  position = null,
  teamName = null,
  mine,
  onClose,
  onOpenDetail,
  ringsAt,
}: PlayerSelectCardProps) {
  // 포지션은 **표기만** 한글로 — enum 원문(`MF`)이 한글 이름 옆에 서던 것(#406 W6 m7).
  const sub = [positionKo(position), teamName].filter((v) => !!v && String(v).trim()).join(" · ");

  const boxRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CardPlacement>(CARD_HOME);
  // 게터는 부모가 매 렌더 새로 만든다 → ref 로 최신만 본다(effect 를 재구독하지 않는다).
  const ringsRef = useRef(ringsAt);
  useEffect(() => {
    ringsRef.current = ringsAt;
  });
  useEffect(() => {
    const relocate = () => {
      const el = boxRef.current;
      const stage = el?.offsetParent as HTMLElement | null;
      if (!el || !stage) return;
      const rings = ringsRef.current?.() ?? null;
      setPlace((cur) => {
        const next = pickCardPlacement(
          { width: stage.clientWidth, height: stage.clientHeight },
          { width: el.offsetWidth, height: el.offsetHeight },
          rings,
          cur,
        );
        // 같은 자리면 **같은 객체**를 돌려준다 — 아니면 200ms 마다 리렌더가 돈다.
        return samePlacement(next, cur) ? cur : next;
      });
    };
    relocate();
    const id = window.setInterval(relocate, PLACE_POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  /*
    자리는 **인라인 스타일**로 준다. CSS 에 `left/top` 을 적어 두면 위 기하(`cardRectOf`)와 화면이
    두 곳에서 정의돼, 한쪽만 고쳐지는 날 계약이 "안 겹친다"고 말하는 동안 화면은 겹친다.
    `CARD_INSET` 이 유일한 출처다. 가로는 `left|right` 로 붙여 카드 폭이 바뀌어도 가장자리 여백이
    자동으로 맞는다(측정 지연 한 틱이 좌표로 새 나가지 않는다).
  */
  const pos =
    place.side === "left"
      ? { left: CARD_INSET.side, top: place.top }
      : { right: CARD_INSET.side, top: place.top };

  return (
    <div
      ref={boxRef}
      style={pos}
      className={`${styles.card} ${mine === true ? styles.mine : mine === false ? styles.opp : styles.unknown}`}
      data-testid="arena-player-card"
      data-side={place.side}
      data-top={Math.round(place.top)}
      data-team={team}
      data-player={playerId}
      data-mine={mine === null ? "unknown" : String(mine)}
      role="group"
      aria-label={`선택한 선수 ${name}`}
    >
      <div className={styles.head}>
        <span className={`${styles.disc} ${team === "home" ? styles.discHome : styles.discAway}`} aria-hidden="true">
          {num ?? ""}
        </span>
        <span className={styles.ident}>
          <b className={styles.name} data-testid="arena-player-name">
            {name}
          </b>
          {sub && <span className={styles.sub}>{sub}</span>}
        </span>
        {mine !== null && (
          <span
            className={`${styles.who} ${mine ? styles.whoMine : styles.whoOpp}`}
            data-testid="arena-player-who"
          >
            {mine ? "내 선수" : "상대 선수"}
          </span>
        )}
        <button type="button" className={styles.close} onClick={onClose} aria-label="선택 해제" data-testid="arena-player-close">
          ✕
        </button>
      </div>
      {/*
        ⚠️ **이 문구는 화면에 없는 자리를 가리키지 않는다** — 세 번의 왕복이 여기서 끝난다
        (#406 W4 MAJOR-3 → W6 m2 → W7 m-4).

        ① W4: *"지시는 **아래** [후반 지시] 탭에서 …"* — 그 탭은 `briefTabVisible()` 상
           **`FIRST_HALF` 에서만** 뜬다. 후반 실브라우저에서 없는 탭을 가리켰다.
        ② W4 수리: *"전반의 [후반 지시] 탭과 감독시간의 [감독] 패널에서"* — `FINISHED` 에서 거짓.
        ③ W6 수리: *"지시는 **경기 중** [후반 지시]·[감독] 패널에서 씁니다"* — `SECOND_HALF`
           에서 **여전히 거짓**이다(후반엔 두 자리 다 없다. 계약 ⑦ 스스로 후반에서
           `stage-tab-brief` count 0 을 단언한다). "경기 중"은 FINISHED 를 사고 후반을 내줬을 뿐이다.

        세 번 다 같은 실패다 — **문장이 어딘가를 가리키는 한, 그 자리가 없는 상태가 반드시 있다**
        (지시를 쓸 수 있는 자리는 상태별로 열리고 닫히는데 이 카드는 상태를 모른다. prop 으로
        상태를 내리는 길은 `StageShell`·`MatchViewer` 를 #421 과 겹치게 건드린다). 그래서 W7 은
        **가리키기를 그만둔다**: 뱃지가 이미 "내 선수 / 상대 선수"를 말하므로 문장은 **이 카드가
        무엇인가**만 말한다. 그건 이 부품의 자기 성질이라(위 머리말: 지시 입력칸을 두지 않는다)
        경기 상태와 무관하게 참이다.

        계약 ⑦ 은 이제 토큰 존재(`/경기 중/`)가 아니라 **성질**로 건다 — 세 상태 각각에서, 문구가
        어떤 자리를 이름으로 부르면 **그 자리가 그 화면에 실제로 있어야** 한다. 위 ①②③ 은 전부
        그 성질에서 죽는다.

        ⚠️ **문구 길이는 기하다**(#406 W6 MAJOR-A). 카드가 커질수록 무대에서 링을 피할 자리가
        줄어든다 — W4 초판 문구는 폰에서 카드를 280×95 로 부풀려 한가운데 선 선수를 **어느
        자리로도 못 피하는** 구멍을 만들었다. 여기 한 줄을 늘리기 전에
        `player-selection.ts:CARD_INSET` 의 예산 식과 계약 ⑨ 의 예산 단언을 먼저 읽어라.
      */}
      <p className={styles.note} data-testid="arena-player-note">
        {mine === false
          ? "열람 전용 — 정보만 봅니다."
          : mine === true
            ? "이 카드는 정보만 보여줍니다."
            : "피치에서 선택한 선수입니다."}
      </p>
      {onOpenDetail && (
        <button
          type="button"
          className={styles.detail}
          onClick={() => onOpenDetail(playerId, team)}
          data-testid="arena-player-detail"
        >
          선수 정보
        </button>
      )}
    </div>
  );
}

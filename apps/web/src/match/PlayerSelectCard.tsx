import type { TeamSide } from "./player-selection";
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
}

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
}: PlayerSelectCardProps) {
  const sub = [position, teamName].filter((v) => !!v && String(v).trim()).join(" · ");
  return (
    <div
      className={`${styles.card} ${mine === true ? styles.mine : styles.opp}`}
      data-testid="arena-player-card"
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
        ⚠️ **이 문구는 상태와 무관하게 참이어야 한다**(#406 W4 독립검증 MAJOR-3). 초판은 내 선수에
        대해 *"지시는 **아래** [후반 지시] 탭에서 …"* 라고 단정했는데, 그 탭은
        `stage-state.briefTabVisible()` 상 **`FIRST_HALF` 에서만** 뜬다. 그런데 이 무대는 후반·
        종료 화면도 같이 쓴다 — 실브라우저(`state: SECOND_HALF`)에서 없는 탭을 가리키고 있었다.
        prop 으로 상태를 내려 문구를 갈아 끼우는 대신(= `StageShell`·`MatchViewer`·`VisualPlayback`
        을 #421 과 겹치게 건드리는 길) **어느 상태에서도 참인 형태**로 일반화한다: 지시를 쓰는
        자리가 어디인지는 상태와 무관한 사실이고, "지금 아래에 있다"만 거짓이었다.
      */}
      <p className={styles.note} data-testid="arena-player-note">
        {mine === false
          ? "상대 선수입니다 — 정보 열람만 가능합니다."
          : mine === true
            ? "내 선수입니다 — 지시는 전반의 [후반 지시] 탭과 감독시간의 [감독] 패널에서 씁니다."
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

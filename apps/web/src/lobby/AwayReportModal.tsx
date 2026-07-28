import { useNavigate } from "react-router-dom";
import { useAckAwayReports } from "../api/hooks";
import { Modal } from "../common/Modal";
import {
  headline,
  isForfeit,
  ratingDeltaText,
  resultBadge,
  type AwayReportsResponse,
} from "./away-report-logic";
import styles from "./AwayReportModal.module.css";

/**
 * 부재중 피원정 결과 팝업(#245 요구 1·3).
 *
 * <p>화면 하나가 두 요구를 같이 answers 한다: 헤드라인+요약 3칸이 "몇 팀과 몇 승 몇 패, 득실,
 * 레이팅 ±X"(요구 3)이고, 리스트가 "어떤 팀에게 당했고 결과가 어땠나"(요구 1)다.
 *
 * <p>규율 둘:
 * <ul>
 *   <li><b>숫자를 다시 세지 않는다</b> — 전부 서버 summary 를 그린다(away-report-logic 참조).</li>
 *   <li><b>ack 이 실패해도 모달은 닫는다</b> — 연출 실패가 로비 동선을 막으면 안 된다
 *       (StarterReveal 선례). 미확인 상태는 서버에 남아 다음 진입에 다시 뜬다.</li>
 * </ul>
 */
export function AwayReportModal({
  data,
  onClose,
}: {
  data: AwayReportsResponse;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const ack = useAckAwayReports();
  const { summary, reports } = data;

  /**
   * ⚠️ **화면에 그린 것만 확인 처리한다**(독립검증 MAJ-1). ids 를 비우면 서버는 미확인 **전부**를
   * seen 으로 바꾸는데, 목록은 서버 `report-list-limit`(20) 로 잘려 있다 — 21번째부터는 **한 번도
   * 보여주지 않은 채 영구 소멸**하고 헤드라인은 "20팀"이라고 거짓말한다. 잘린 만큼은 남겨서
   * 다음 진입에 다시 뜨게 한다.
   */
  function confirm() {
    // ack 결과를 기다리지 않는다 — 닫기는 사용자의 것이고, 멱등이라 재시도가 안전하다.
    ack.mutate(reports.map((r) => r.id));
    onClose();
  }

  // 이번 창에 못 실은 나머지. 침묵하면 유저는 이게 전부인 줄 안다.
  const remaining = Math.max(0, (data.unseen ?? reports.length) - reports.length);

  return (
    <Modal
      onClose={confirm}
      labelledBy="away-report-title"
      overlayClassName={styles.overlay}
      className={styles.modal}
      testId="away-report-modal"
    >
      <h2 id="away-report-title" className={styles.title}>
        자리를 비운 사이
      </h2>
      <p className={styles.headline} data-testid="away-report-headline">
        {headline(summary, reports)}
      </p>

      <div className={styles.summary}>
        <div className={styles.cell}>
          <span className={styles.key}>전적</span>
          <span className={styles.value} data-testid="away-summary-record">
            {summary.wins}승 {summary.draws}무 {summary.losses}패
          </span>
        </div>
        <div className={styles.cell}>
          <span className={styles.key}>득실</span>
          <span className={styles.value} data-testid="away-summary-goals">
            {summary.goalsFor} : {summary.goalsAgainst}
          </span>
        </div>
        <div className={styles.cell}>
          <span className={styles.key}>레이팅</span>
          <span
            className={`${styles.value} ${deltaClass(summary.ratingDelta)}`}
            data-testid="away-summary-rating"
          >
            {ratingDeltaText(summary.ratingDelta)}
          </span>
        </div>
      </div>

      <ul className={styles.list} data-testid="away-report-list">
        {reports.map((r) => (
          <li key={r.id}>
            {/*
              경기 보기 — 수비자도 그 경기를 볼 수 있다(hero Q5). 단 둘을 지킨다:
              ① **몰수는 열지 않는다** — 상대가 브리핑에서 무른 경기라 재생할 하프가 애초에 없다
                 (열면 수비자에게 "포기한 경기입니다"가 뜬다. 포기한 건 상대인데).
              ② **클릭은 확인이 아니다** — 예전엔 클릭이 그 행을 ack 해버려서, 경기를 보러 간
                 순간 리포트가 목록에서 사라졌다. 이 앱엔 지난 리포트를 볼 화면(status=all)이
                 없으므로 그건 **영구 소실**이다. 확인은 [확인] 버튼만 한다(독립검증 2R blocker).
            */}
            <button
              type="button"
              className={styles.item}
              data-testid="away-report-item"
              disabled={isForfeit(r)}
              title={isForfeit(r) ? "상대가 경기 전에 포기해 재생할 경기가 없습니다" : undefined}
              onClick={() => navigate(`/match/${r.matchId}`)}
            >
              <span className={`${styles.badge} ${styles[`badge${r.result}`] ?? ""}`}>
                {resultBadge(r.result)}
              </span>
              <span className={styles.who}>{r.attackerName}</span>
              {/* 상대가 브리핑에서 무른 경우 — "0:0 인데 승"으로 보이면 버그로 읽힌다. */}
              <span className={styles.score}>
                {isForfeit(r) ? "몰수" : `${r.goalsFor} : ${r.goalsAgainst}`}
              </span>
              <span className={`${styles.delta} ${deltaClass(r.ratingDelta)}`}>
                {ratingDeltaText(r.ratingDelta)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {remaining > 0 && (
        <p className={styles.remaining} data-testid="away-report-remaining">
          외 {remaining}경기는 다음에 이어서 보여드립니다
        </p>
      )}

      <button
        type="button"
        className={styles.confirm}
        data-testid="away-report-confirm"
        onClick={confirm}
      >
        확인
      </button>
    </Modal>
  );
}

function deltaClass(delta: number): string {
  return (delta > 0 ? styles.up : delta < 0 ? styles.down : styles.flat) ?? "";
}

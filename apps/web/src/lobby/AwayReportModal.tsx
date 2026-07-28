import { useNavigate } from "react-router-dom";
import { useAckAwayReports } from "../api/hooks";
import { Modal } from "../common/Modal";
import {
  headline,
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

  function confirm() {
    // ack 결과를 기다리지 않는다 — 닫기는 사용자의 것이고, 멱등이라 재시도가 안전하다.
    ack.mutate(undefined);
    onClose();
  }

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
            {/* 경기 보기 — 수비자도 그 경기를 볼 수 있다(hero Q5). 서버가 리포트 행을 근거로
                읽기 전용 접근을 허용하므로 평소 매치 화면을 그대로 연다. */}
            <button
              type="button"
              className={styles.item}
              data-testid="away-report-item"
              onClick={() => {
                ack.mutate([r.id]);
                navigate(`/match/${r.matchId}`);
              }}
            >
              <span className={`${styles.badge} ${styles[`badge${r.result}`] ?? ""}`}>
                {resultBadge(r.result)}
              </span>
              <span className={styles.who}>{r.attackerName}</span>
              <span className={styles.score}>
                {r.goalsFor} : {r.goalsAgainst}
              </span>
              <span className={`${styles.delta} ${deltaClass(r.ratingDelta)}`}>
                {ratingDeltaText(r.ratingDelta)}
              </span>
            </button>
          </li>
        ))}
      </ul>

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

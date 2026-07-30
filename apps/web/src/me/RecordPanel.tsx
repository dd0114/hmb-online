import { useMyRecord } from "../api/hooks-p286";
import { donutDash, formMark, recordView } from "./record-logic";
import styles from "./RecordPanel.module.css";

const R = 26;
const C = 2 * Math.PI * R;

/**
 * 전적 패널 (#286 W5, 설계 §3.7) — 승률 도넛 · 최근 폼 · 모드별 전적표.
 *
 * ⚠️ **서버 `GET /api/me/record` 가 아직 없다**(#319 = W4). 없으면 이 구역을 **통째로 안 그린다** —
 * 상위 화면의 통산 전적 한 줄은 그대로 남으므로 유저가 잃는 것이 없다. 스켈레톤을 띄우면
 * "아직 없는 기능"이 "고장 난 화면"으로 보인다.
 *
 * ⚠️ **승률은 서버 값만 쓴다.** 무승부 취급이 서버 규칙이라 클라가 나누면 조용히 어긋난다.
 */
export function RecordPanel() {
  const { data } = useMyRecord();
  const v = recordView(data);
  if (!v.usable) return null;

  return (
    <section className={styles.card} data-testid="me-record-panel">
      <div className={styles.top}>
        {/* 도넛은 승률을 **알 때만** 그린다 — 모르면 자리 자체가 없다. */}
        {v.winRate !== null && (
          <div className={styles.donutWrap} data-testid="me-winrate">
            <svg viewBox="0 0 64 64" className={styles.donut} aria-hidden="true">
              <circle className={styles.track} cx="32" cy="32" r={R} />
              <circle
                className={styles.fill}
                cx="32"
                cy="32"
                r={R}
                data-testid="me-winrate-arc"
                strokeDasharray={donutDash(v.winRate, C)}
              />
            </svg>
            <span className={styles.donutLabel}>{Math.round(v.winRate * 100)}%</span>
            <span className={styles.donutSub}>승률</span>
          </div>
        )}

        <div className={styles.summary}>
          {v.overall && (
            <b className={styles.overall} data-testid="me-record-overall">
              {v.overall.wins}승 {v.overall.draws}무 {v.overall.losses}패
            </b>
          )}
          {v.streak.current !== null && (
            <span className={styles.streak} data-testid="me-streak">
              현재 {v.streak.current}연승
              {v.streak.best !== null && ` · 최고 ${v.streak.best}`}
            </span>
          )}
        </div>
      </div>

      {v.form.length > 0 && (
        <div className={styles.formRow} data-testid="me-form">
          <span className={styles.formLabel}>최근</span>
          {/* 색 하나로 구분하지 않는다 — 글자(승/무/패)를 같이 쓴다(적록색약, #262 규율). */}
          {v.form.map((f, i) => (
            <span key={`${f}-${i}`} className={`${styles.mark} ${styles[f.toLowerCase()]}`}>
              {formMark(f)}
            </span>
          ))}
        </div>
      )}

      {v.modes.length > 0 && (
        <table className={styles.table} data-testid="me-record-modes">
          <thead>
            <tr>
              <th>모드</th><th>경기</th><th>승</th><th>무</th><th>패</th>
            </tr>
          </thead>
          <tbody>
            {v.modes.map((m) => (
              <tr key={m.key} data-testid={`me-mode-${m.key}`}>
                <td className={styles.modeName}>{m.label}</td>
                <td>{m.rec.played}</td>
                <td>{m.rec.wins}</td>
                <td>{m.rec.draws}</td>
                <td>{m.rec.losses}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

import { useEffect } from "react";
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
export function RecordPanel({ onShowsOverall }: { onShowsOverall?: (v: boolean) => void }) {
  const { data } = useMyRecord();
  const v = recordView(data);
  /**
   * 상위 화면이 중복 표시를 접을 수 있게 알린다(#286 MIN-4) — "그려졌나"는 서버 응답에 달려
   * 있어 여기서만 안다. effect 로 알리는 이유: 렌더 중 부모 setState 는 경고를 낸다.
   *
   * ⚠️ **`usable` 이 아니라 `overall !== null` 이다.** 접기의 뜻은 "패널이 보인다"가 아니라
   * **"패널이 통산 전적을 대신 말한다"** 이다. `usable` 로 알리면 `{"recentForm":[…]}` 처럼
   * **overall 없이 오는 부분 응답**에서 상단 폴백이 접히는데 패널에도 통산이 없어 —
   * 통산 전적이 화면에서 **통째로 사라진다**(독립검증 2R minor-3, 실측 0회 표시).
   * 이 파일 스스로가 "응답 형태를 믿지 않는다"(#245·#251)를 전제로 `block()` 에서 overall
   * 부재를 명시 처리하는데, 접기 신호만 그 가정을 안 따르고 있었다.
   */
  const showsOverall = v.usable && v.overall !== null;
  useEffect(() => onShowsOverall?.(showsOverall), [showsOverall, onShowsOverall]);
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

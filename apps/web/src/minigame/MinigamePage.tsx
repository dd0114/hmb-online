import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { VisualPlayback } from "../match/VisualPlayback";
import { LOBBY_PATH } from "../auth/return-to";
import styles from "./MinigamePage.module.css";

/**
 * #493 W1 — 신규 유저 첫 경험: 1분 미니게임(`/welcome`).
 *
 * hero C(하이브리드) 확정 근거(W0 실측, `epics/493-tutorial/research.md` 축4): 강제 연습 1판은
 * 첫 세션 7:30~11:20 + AI 생성 대기 2회 + GEN1 타임아웃 시 FAILED 화면이 첫인상이 될 수 있다.
 * 저장 리플레이 주입은 **1분 내 첫 골 · 대기 0 · 실패 모드 0** — 재미를 먼저 증명하고
 * 진짜 경기(연습)는 온보딩·보상(#493 W3)이 당긴다.
 *
 * - 자산 = `minigame-log.json`(커밋된 정적 번들, gzip 63KB — 계약 `minigame-log.test.ts`).
 *   **`/api` 접촉 0** 이 이 화면의 계약이다(e2e ② 가 감시) — 서버가 죽어 있어도 첫 경험은 돈다.
 * - 재생 = 게임화면과 **같은 부품**(`VisualPlayback`, 재발명 금지 #57). `clock=null` 이라
 *   라이브 게이트가 없고, viewer-core 는 load 시 자동 재생한다(review 아님).
 * - 번들 주의: JSON 을 모듈 import 하지 않는다 — 495KB 가 메인 청크에 박혀 **모든** 유저의
 *   부팅이 느려진다. `new URL(…, import.meta.url)` 로 별도 에셋으로 남기고 이 화면만 받는다.
 */
const LOG_URL = new URL("./minigame-log.json", import.meta.url).href;

type MiniLog = {
  tickSnapshots: { tick: number }[];
  finalScore: { home: number; away: number };
};

export function MinigamePage() {
  const navigate = useNavigate();
  const [log, setLog] = useState<MiniLog | null>(null);
  const [broken, setBroken] = useState(false);
  const [ended, setEnded] = useState(false);
  const lastTickRef = useRef(Number.POSITIVE_INFINITY);

  useEffect(() => {
    let alive = true;
    fetch(LOG_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: MiniLog) => {
        if (!alive) return;
        const snaps = data?.tickSnapshots;
        if (!Array.isArray(snaps) || snaps.length === 0) throw new Error("bad log");
        lastTickRef.current = snaps[snaps.length - 1]!.tick;
        setLog(data);
      })
      .catch(() => {
        if (alive) setBroken(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const goHome = () => navigate(LOBBY_PATH, { replace: true });

  // 자산이 깨져도 신규 유저를 가두지 않는다 — 관전만 빠지고 동선은 그대로(StarterReveal 규율).
  if (broken) {
    return (
      <div className={styles.page} data-testid="minigame-broken">
        <p className={styles.copy}>경기 영상을 불러오지 못했습니다 — 바로 시작해도 됩니다.</p>
        <button type="button" className={styles.cta} data-testid="minigame-cta" onClick={goHome}>
          이제 당신의 팀으로
        </button>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>60초 관전</h1>
        <p className={styles.sub}>당신이 만들게 될 경기를 먼저 보세요 — 선수들은 감독의 말로 움직입니다</p>
      </header>

      <div className={styles.stage} data-testid="minigame-stage">
        {log && (
          <VisualPlayback
            log={log}
            half={1}
            onFallback={() => setBroken(true)}
            controlMode="play"
            canSwitch={false}
            onControlMode={() => undefined}
            clock={null}
            clockOffsetMs={0}
            onTick={(tick) => {
              if (tick >= lastTickRef.current) setEnded(true);
            }}
            skipSlot={
              <button type="button" className={styles.skip} data-testid="minigame-skip" onClick={goHome}>
                건너뛰기 ›
              </button>
            }
          />
        )}
        {!log && <div className={styles.loading}>경기장 준비 중…</div>}

        {ended && log && (
          <div className={styles.endOverlay} data-testid="minigame-end">
            <div className={styles.endScore}>
              경기 종료 · {log.finalScore.home} : {log.finalScore.away}
            </div>
            <p className={styles.copy}>이 경기의 모든 움직임은 감독의 지시에서 나왔습니다.</p>
            <button type="button" className={styles.cta} data-testid="minigame-cta" onClick={goHome}>
              이제 당신의 팀으로
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

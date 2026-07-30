import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { usePlayers, type CatalogPlayer } from "../api/hooks";
import {
  useAcceptTrade,
  useProposeFa,
  useSpeedupTrade,
  useStartTrade,
  useTradeSlots,
} from "../api/hooks-v2";
import type { FaProposeRequest, TradeResolveResponse } from "../api/v2";
import { Layout } from "../common/Layout";
import { PointsBadge } from "../common/PointsBadge";
import { ErrorToast } from "../common/ErrorToast";
import { TradeSlotCard } from "./TradeSlotCard";
import { TradeResultModal } from "./TradeResultModal";
import { countdownSec, slotView } from "./trade-logic";
import styles from "./TradePage.module.css";

/**
 * ⚠️ `embedded` (#286 W2): 이 화면은 이제 **상위 탭 안에 얹혀** 산다(트레이드).
 * embedded 면 자기 `Layout`·헤더를 그리지 않는다 — 안 그러면 `app-container` 가 두 겹이 되어
 * 하단 네비 여백·최대폭이 이중으로 걸린다. 단독 라우트는 아직 리다이렉트로만 들어오므로
 * 비-embedded 경로도 남겨 둔다(구 URL 이 죽지 않게).
 */
export function TradePage({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useTradeSlots();
  const { data: players } = usePlayers();

  const start = useStartTrade();
  const speedup = useSpeedupTrade();
  const propose = useProposeFa();
  const accept = useAcceptTrade();

  const [result, setResult] = useState<TradeResolveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Countdown anchor: capture the local clock at each data refresh, then tick a 1s counter so
  // WAITING slots recompute from (remainingSec − localElapsed) — drift-immune (trade-logic).
  const fetchedAtRef = useRef<number>(Date.now());
  const [, forceTick] = useState(0);
  useEffect(() => {
    fetchedAtRef.current = Date.now();
  }, [data]);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const catalog = useMemo(() => {
    const m = new Map<string, CatalogPlayer>();
    for (const p of Array.isArray(players) ? players : []) m.set(p.id, p);
    return m;
  }, [players]);
  const owned = useMemo(() => (Array.isArray(players) ? players : []).filter((p) => p.owned), [players]);

  const walletPoints = data?.wallet?.points ?? 0;
  // #232: 단축 비용의 재화는 **서버가 정한다**(slot.speedupCurrency). 무료재화 잔액으로만 게이팅하면
  // 서버가 유상재화로 바꾸는 순간 "표기는 Z, 잠금은 골드 기준"이 된다 — #213 의 후반부와 같은 형태다.
  // ⚠️ `?? 0` 으로 떨어뜨리지 않는다 — openapi 가 `gems` 를 required 로 두지 않아(구서버 호환)
  // 미수신이 정상 경로인데, 0 으로 읽으면 유상재화를 들고 있는 유저가 **거짓으로 잠긴다**.
  const walletGems = data?.wallet?.gems;
  const walletLoaded = Boolean(data);
  const busy = start.isPending || speedup.isPending || propose.isPending || accept.isPending;

  function handleError(err: unknown, fallback: string) {
    if (err instanceof ApiError) {
      // 재화 이름이 들어가는 문구는 **서버 message 를 그대로** 쓴다 — 클라가 이름을 지어내면
      // 표기 변경이 web 배포가 된다(#232). 코드별 분기는 문맥 접두사만 붙인다.
      if (err.code === "INSUFFICIENT_POINTS") setError(err.message);
      else if (err.code === "TRADE_INVALID") setError(`처리할 수 없는 요청입니다 — ${err.message}`);
      else setError(err.message);
    } else {
      setError(fallback);
    }
  }

  function onResolved(res: TradeResolveResponse) {
    setResult(res);
  }

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/home")}>
        ← 홈
      </button>
      <h1 className={styles.pageTitle}>트레이드</h1>
      {data && <PointsBadge points={walletPoints} />}
    </div>
  );

  const body = (
    <>
      {isError && <ErrorToast message="트레이드 정보를 불러오지 못했습니다" />}
      {isLoading && <p className={styles.pending}>불러오는 중…</p>}

      <div className={styles.slots} data-testid="trade-slots">
        {/* 배열일 때만 순회한다 — 200 `{}` 면 `slots` 가 undefined 라 `.map` 이 던지고
            [영입] 탭이 통째로 흰 화면이 된다(#286 독립검증 MAJ-3). */}
        {(Array.isArray(data?.slots) ? data.slots : []).map((slot) => {
          const live =
            slotView(slot) === "WAITING"
              ? countdownSec(slot.remainingSec ?? 0, Date.now() - fetchedAtRef.current)
              : 0;
          return (
            <TradeSlotCard
              key={slot.slot}
              slot={slot}
              liveRemainingSec={live}
              walletPoints={walletPoints}
              walletGems={walletGems}
              walletLoaded={walletLoaded}
              catalog={catalog}
              owned={owned}
              busy={busy}
              onStart={(s) =>
                start.mutate(s, { onError: (e) => handleError(e, "장을 열지 못했습니다") })
              }
              onSpeedup={(s) =>
                speedup.mutate(s, { onError: (e) => handleError(e, "단축에 실패했습니다") })
              }
              onPropose={(s, body: FaProposeRequest) =>
                propose.mutate(
                  { slot: s, body },
                  { onSuccess: onResolved, onError: (e) => handleError(e, "제안에 실패했습니다") },
                )
              }
              onAccept={(s) =>
                accept.mutate(s, {
                  onSuccess: onResolved,
                  onError: (e) => handleError(e, "수락에 실패했습니다"),
                })
              }
            />
          );
        })}
      </div>

      <ErrorToast message={error} onDismiss={() => setError(null)} />

      {result && (
        <TradeResultModal result={result} catalog={catalog} onClose={() => setResult(null)} />
      )}
    </>
  );

  if (embedded) return body;
  return (
    <Layout header={header} nav>
      {body}
    </Layout>
  );
}

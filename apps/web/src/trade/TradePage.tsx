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

export function TradePage() {
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
    for (const p of players ?? []) m.set(p.id, p);
    return m;
  }, [players]);
  const owned = useMemo(() => (players ?? []).filter((p) => p.owned), [players]);

  const walletPoints = data?.wallet.points ?? 0;
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
      <button type="button" className={styles.back} onClick={() => navigate("/lobby")}>
        ← 로비
      </button>
      <h1 className={styles.pageTitle}>트레이드</h1>
      {data && <PointsBadge points={walletPoints} />}
    </div>
  );

  return (
    <Layout header={header} nav>
      {isError && <ErrorToast message="트레이드 정보를 불러오지 못했습니다" />}
      {isLoading && <p className={styles.pending}>불러오는 중…</p>}

      <div className={styles.slots} data-testid="trade-slots">
        {data?.slots.map((slot) => {
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
    </Layout>
  );
}

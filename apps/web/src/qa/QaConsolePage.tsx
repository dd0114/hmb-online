import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VisualPlayback } from "../match/VisualPlayback";
import {
  ackLabel,
  canSubmit,
  clockOf,
  headerCounts,
  resolveSelection,
  sortTabs,
  statusLabel,
  submitPayload,
  tabFromSearch,
  type QaAck,
  type QaFeedback,
  type QaTabView,
} from "./qa-console-logic";
import styles from "./QaConsolePage.module.css";

/**
 * QA 콘솔 (#191) — hero 가 **탭 하나만 보고** QA 판단하는 화면.
 *
 * 흐름: 워커 세션이 `tools/qa-tab.mjs register` 로 탭을 만들고(hero 요청/컨펌 후에만 — D10),
 * hero 는 좌측에서 탭을 골라 브리핑을 읽고 → 확인 포인트를 눌러 그 초의 경기를 보고 →
 * 아래 한 줄에 본 대로 적는다. **적은 문장이 그대로 세션 프롬프트**가 되고(D9), 세션은
 * `qa-tab.mjs wait` 이 종료되며 깨어나 이어서 진행한다.
 *
 * 경기 재생은 게임화면과 **같은 부품**(`VisualPlayback`)이다 — 여기서 다시 만들지 않는다.
 * 로컬 전용 화면이며 프로덕션 번들에는 라우트가 없다(App.tsx `import.meta.env.DEV`).
 */
export function QaConsolePage() {
  const [views, setViews] = useState<QaTabView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ feedback: QaFeedback[]; ack: QaAck } | null>(null);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const deepLink = useMemo(
    () => (typeof window === "undefined" ? null : tabFromSearch(window.location.search)),
    [],
  );

  // 선택은 ref 로도 들고 있는다 — 2초 폴링 콜백이 마운트 시점 클로저에 갇히면
  // 갱신마다 선택이 첫 탭으로 튀어(= hero 가 보던 게 바뀌어) 판정을 잃는다.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const loadTabs = useCallback(async () => {
    try {
      const res = await fetch("/qa-api/tabs", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`목록 ${res.status}`);
      const body = (await res.json()) as { tabs: QaTabView[] };
      setViews(body.tabs ?? []);
      setSelected(resolveSelection(body.tabs ?? [], deepLink, selectedRef.current));
      setLive(true);
    } catch {
      // 콘솔 서버가 안 떠 있으면 화면에 그렇게 말한다(빈 화면으로 두면 원인을 모른다).
      setLive(false);
    }
  }, [deepLink]);

  const loadDetail = useCallback(async (tabId: string) => {
    try {
      const res = await fetch(`/qa-api/tabs/${encodeURIComponent(tabId)}/feedback`);
      if (!res.ok) throw new Error(String(res.status));
      setDetail((await res.json()) as { feedback: QaFeedback[]; ack: QaAck });
    } catch {
      setDetail(null);
    }
  }, []);

  // 2초 폴링. SSE 대신 폴링인 이유: 콘솔 서버를 재기동해도 알아서 다시 붙고 부품이 적다.
  useEffect(() => {
    void loadTabs();
    const timer = window.setInterval(() => void loadTabs(), 2000);
    return () => window.clearInterval(timer);
  }, [loadTabs]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void loadDetail(selected);
    const timer = window.setInterval(() => void loadDetail(selected), 2000);
    return () => window.clearInterval(timer);
  }, [selected, loadDetail]);

  const sorted = useMemo(() => sortTabs(views), [views]);
  const counts = useMemo(() => headerCounts(views), [views]);
  const current = sorted.find((v) => v.tab.tabId === selected) ?? null;

  return (
    <div className={styles.root} data-testid="qa-console">
      <div className={styles.top}>
        <div className={styles.brand}>
          HMB QA 콘솔 <small>{typeof window === "undefined" ? "" : window.location.host}/qa/console</small>
        </div>
        <div className={styles.counts}>
          <span>
            탭 <b data-testid="qa-count-total">{counts.total}</b>
          </span>
          <span>
            대기중 <b>{counts.waiting}</b>
          </span>
          <span className={styles.need}>
            내 확인 필요 <b data-testid="qa-count-needme">{counts.needMe}</b>
          </span>
          {counts.stale > 0 && <span>⚠ 응답없음 {counts.stale}</span>}
        </div>
        <div className={styles.topRight} data-testid="qa-live" data-live={live ? "1" : "0"}>
          <span className={[styles.pulse, live ? "" : styles.pulseBad].join(" ")} />
          {live ? "2초 자동갱신" : "콘솔 서버 무응답 — node tools/qa-console.mjs status"}
        </div>
      </div>

      <div className={styles.shell}>
        <nav className={styles.rail}>
          <div>
            <div className={styles.railHead}>세션 탭</div>
            <div className={styles.tabs} data-testid="qa-tab-list">
              {sorted.length === 0 && <div className={styles.empty}>등록된 탭이 없다</div>}
              {sorted.map((v) => (
                <button
                  key={v.tab.tabId}
                  type="button"
                  className={[styles.tab, v.tab.tabId === selected ? styles.tabOn : ""].join(" ")}
                  data-testid={`qa-tab-${v.tab.tabId}`}
                  aria-current={v.tab.tabId === selected}
                  onClick={() => setSelected(v.tab.tabId)}
                >
                  <span className={styles.tabL1}>
                    <span
                      className={[
                        styles.dot,
                        v.stale ? styles.dotStale : v.tab.status === "waiting" ? styles.dotWaiting : "",
                      ].join(" ")}
                    />
                    <span className={styles.issue}>#{v.tab.issue ?? "-"}</span>
                    <span className={styles.tabTitle}>{v.tab.title}</span>
                  </span>
                  <span className={styles.tabL2}>
                    {statusLabel(v)}
                    <span className={[styles.badge, v.unread ? "" : styles.badgeZero].join(" ")}>
                      {v.unread ? `💬${v.unread}` : "—"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          {current ? (
            <Brief view={current} detail={detail} />
          ) : (
            <div className={styles.brief} />
          )}
        </nav>

        {current ? (
          <Stage key={current.tab.tabId} view={current} onSent={() => void loadDetail(current.tab.tabId)} error={error} setError={setError} />
        ) : (
          <div className={styles.blank} data-testid="qa-console-blank">
            <div>
              등록된 탭이 없다.
              <br />
              세션이 <code>node tools/qa-tab.mjs register --id …</code> 로 탭을 만들면 여기 나타난다.
              <br />
              (탭 생성은 hero 요청·컨펌 후에만 — 자율 생성 금지)
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 로그 경로는 끝이 중요하다(어느 픽스처인가) → 뒤 두 조각만 보여주고 전체는 title 로 준다. */
function shortPath(p: string | undefined): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

/** 좌측 브리핑 — "무엇을 고쳤나 / 봐줄 것 / 확인 포인트 / 피드백 이력". */
function Brief({ view, detail }: { view: QaTabView; detail: { feedback: QaFeedback[]; ack: QaAck } | null }) {
  const t = view.tab;
  const feedback = detail?.feedback ?? [];
  const ack = detail?.ack ?? { cursor: 0, items: {}, updatedAt: null };
  return (
    <div className={styles.brief} data-testid="qa-brief">
      <h2 className={styles.briefTitle}>
        #{t.issue ?? "-"} {t.title}
      </h2>
      <div className={styles.briefSub}>
        <code>{t.session ?? "세션 미기재"}</code> · <code>{t.branch ?? "-"}</code>
        <br />
        {t.checkout ?? "-"}
      </div>

      <div className={styles.k}>무엇을 고쳤나</div>
      <div className={styles.v}>{t.summary || "-"}</div>

      <div className={styles.k}>봐줄 것</div>
      <div className={[styles.v, styles.vAsk].join(" ")}>{t.ask || "-"}</div>

      <div className={styles.k}>확인 포인트</div>
      <div className={styles.chips}>
        {t.watch.length === 0 && <span className={styles.empty}>없음 — 세션이 --point 로 등록한다</span>}
        {t.watch.map((w, i) => (
          <button
            key={`${w.tick}-${i}`}
            type="button"
            className={styles.chip}
            data-testid={`qa-point-${i}`}
            data-tick={w.tick ?? ""}
            data-view={w.view ?? ""}
            onClick={() => {
              // 실제 seek 은 Stage 가 듣는다(커스텀 이벤트 — 레일과 무대가 형제라 부모 상태를 안 흔든다).
              window.dispatchEvent(
                new CustomEvent("qa-console:seek", { detail: { tick: w.tick, view: w.view ?? null } }),
              );
            }}
          >
            <b>{clockOf(w.tick)}</b>
            {w.label}
          </button>
        ))}
      </div>

      <div className={styles.k}>피드백 이력</div>
      {feedback.length === 0 && <div className={styles.empty}>아직 없음 — 세션이 wait 로 대기 중이다</div>}
      {[...feedback].reverse().map((f) => {
        const acked = ackLabel(f.seq, ack);
        return (
          <div key={f.seq} className={styles.fbItem} data-testid={`qa-fb-${f.seq}`}>
            <span
              className={[
                styles.fbVerdict,
                f.verdict === "approve" ? styles.vApprove : f.verdict === "reject" ? styles.vReject : styles.vComment,
              ].join(" ")}
            >
              {f.verdict === "approve" ? "✅ 승인" : f.verdict === "reject" ? "❌ 거부" : "💬 전달"}
            </span>
            <span className={styles.fbAt}>
              #{f.seq} {f.clock ? `${f.view ?? "-"} ${f.clock}` : new Date(f.at).toLocaleTimeString()}
            </span>
            <span className={styles.fbBody}>{f.body || "(내용 없음)"}</span>
            <span
              className={[styles.fbAck, acked === "세션 미수신" ? styles.fbAckPending : ""].join(" ")}
              data-testid={`qa-fb-ack-${f.seq}`}
            >
              {acked}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 오른쪽 무대 — 뷰 전환 · 경기 재생(게임화면과 같은 부품) · 피드백 한 줄 바. */
function Stage({
  view,
  onSent,
  error,
  setError,
}: {
  view: QaTabView;
  onSent: () => void;
  error: string | null;
  setError: (v: string | null) => void;
}) {
  const t = view.tab;
  const [viewId, setViewId] = useState(t.views[0]?.id ?? "");
  const [log, setLog] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [attach, setAttach] = useState(true);
  const [sending, setSending] = useState(false);
  const tickRef = useRef(0);
  // 표시용 시계. onTick 은 프레임마다 오지만(초당 60회) **보이는 초가 바뀔 때만** 올린다 —
  // ref 만 쓰면 리렌더가 없어 "지금 장면" 표시가 옛 값에 멈춘다(실화면에서 1'30" 인데 0'03" 로 보였다).
  const [shownTick, setShownTick] = useState(0);

  const active = t.views.find((v) => v.id === viewId) ?? t.views[0] ?? null;

  // 확인 포인트 클릭 → 뷰 전환 + 그 초로 seek. 정확히 그 초에 서려면 `hooks.seek` 를 써야 한다
  // (컨트롤러 jumpToTick 은 맥락용으로 3 스냅샷 되감는다 — qa-time-controls.ts 주석 계약).
  useEffect(() => {
    const onSeek = (e: Event) => {
      const d = (e as CustomEvent<{ tick: number | null; view: string | null }>).detail;
      if (d.view) setViewId(d.view);
      if (d.tick == null) return;
      const hooks = (window as unknown as { __viewer?: { seek?: (t: number) => void } }).__viewer;
      // 뷰를 바꾸면 코어가 재마운트되므로 한 프레임 뒤에 seek 한다.
      window.setTimeout(() => hooks?.seek?.(d.tick as number), d.view ? 400 : 0);
    };
    window.addEventListener("qa-console:seek", onSeek);
    return () => window.removeEventListener("qa-console:seek", onSeek);
  }, []);

  // 탭이 가리키는 match-log 을 콘솔 API 로 받는다(복사 없음 — 세션 체크아웃의 파일을 그대로 읽어 온다).
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLog(null);
    setLoadError(null);
    fetch(`/qa-api/tabs/${encodeURIComponent(t.tabId)}/log/${encodeURIComponent(active.id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`로그 ${res.status}`);
        return res.json();
      })
      .then((v) => {
        if (!cancelled) setLog(v);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [t.tabId, active?.id]);

  const send = async (verdict: QaFeedback["verdict"]) => {
    if (!canSubmit(verdict, body)) {
      setError(verdict === "reject" ? "거부에는 사유가 필요하다(세션이 뭘 할지 모른다)" : "내용을 적어라");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/qa-api/tabs/${encodeURIComponent(t.tabId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          submitPayload({ verdict, body, view: active?.id ?? null, tick: tickRef.current, attach }),
        ),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `전송 ${res.status}`);
      setBody("");
      onSent();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.main} data-testid="qa-stage">
      <div className={styles.views}>
        {t.views.map((v) => (
          <button
            key={v.id}
            type="button"
            className={[styles.view, v.id === viewId ? styles.viewOn : ""].join(" ")}
            data-testid={`qa-view-${v.id}`}
            aria-pressed={v.id === viewId}
            onClick={() => setViewId(v.id)}
          >
            {v.label}
          </button>
        ))}
        <span className={styles.logPath} title={active?.logPath ?? ""}>
          {shortPath(active?.logPath)}
        </span>
      </div>

      <div className={styles.stage}>
        {loadError && (
          <div className={styles.blank} data-testid="qa-log-error">
            match-log 을 불러오지 못했다: {loadError}
            <br />
            세션이 가리킨 경로가 아직 없을 수 있다 — <code>qa-tab.mjs show --id {t.tabId}</code>
          </div>
        )}
        {!loadError && log == null && <div className={styles.blank}>경기 기록 불러오는 중…</div>}
        {!loadError && log != null && (
          // 게임화면과 **같은 부품**. clock=null → 라이브 게이트 off(과거 로그를 자유롭게 왕복).
          // controlMode="full" → #180 초/프레임 컨트롤·스크럽·핀이 그대로 붙는다.
          <VisualPlayback
            log={log}
            half={1}
            onFallback={() => undefined}
            controlMode="full"
            canSwitch={false}
            onControlMode={() => undefined}
            onTick={(tick) => {
              tickRef.current = tick;
              setShownTick((prev) => (clockOf(prev) === clockOf(tick) ? prev : tick));
            }}
            clock={null}
            clockOffsetMs={0}
          />
        )}
      </div>

      {error && <div className={styles.error} data-testid="qa-error">{error}</div>}

      <div className={styles.fbBar}>
        <span className={styles.fbLabel}>세션에 전달</span>
        <input
          type="text"
          className={styles.fbInput}
          data-testid="qa-feedback-input"
          placeholder="적은 그대로 세션 프롬프트가 된다 — 예: 잔류는 되는데 3명이 GK 옆에 뭉쳐 있다"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void send("comment");
            }
          }}
        />
        <label className={styles.fbAttach}>
          <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
          지금 장면 ({active?.id ?? "-"}·<span data-testid="qa-attach-clock">{clockOf(shownTick)}</span>)
        </label>
        <button
          type="button"
          className={[styles.send, styles.sendComment].join(" ")}
          data-testid="qa-send-comment"
          disabled={sending}
          onClick={() => void send("comment")}
          title="Enter 로도 전달"
        >
          💬 전달 ⏎
        </button>
        <span className={styles.tagSep}>태그(선택)</span>
        <button
          type="button"
          className={[styles.send, styles.sendApprove].join(" ")}
          data-testid="qa-send-approve"
          disabled={sending}
          onClick={() => void send("approve")}
          title="= 다음 단계 진행해라"
        >
          ✅ 승인
        </button>
        <button
          type="button"
          className={[styles.send, styles.sendReject].join(" ")}
          data-testid="qa-send-reject"
          disabled={sending}
          onClick={() => void send("reject")}
          title="= 고치고 다시 올려라(사유 필수)"
        >
          ❌ 거부
        </button>
      </div>
    </div>
  );
}

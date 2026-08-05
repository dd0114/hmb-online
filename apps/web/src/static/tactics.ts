/**
 * 스태틱 모드 전술 인풋 생성 (#444) — "AI 가 되면 AI, 안 되면 스태틱".
 *
 * hero 지시(2026-08-05): *"클로드 코드 로그인을 해야하고 로그인 안하면 그냥 스태틱하게 엔진
 * 계산되게하자. 로그인 안돼서 스태틱하게된다고만 알려주게하고"*
 *
 * 두 경로 모두 **새로 만들지 않는다**:
 *  · AI  = 로컬 AI 브리지(`apps/web/scripts/ai-bridge.ts`)가 기존 `claudeCodeExecutor` +
 *          `prompt/coach.ts` 를 그대로 호출한다. 브라우저는 잡 컨텍스트만 보낸다.
 *  · 폴백 = `packages/server` 의 **`stubExecutor`** — 원래부터 "키·네트워크·로그인 0" 결정론
 *          폴백으로 있는 자산이다(시드 결정론 베이스 + 지시 키워드 반영).
 *
 * Pages 에는 브리지가 없으므로 **항상 폴백 + 안내 배너**다(플레이는 막지 않는다).
 */
import type { TacticalInput, TeamInputJobContext } from "@hmb/shared";
import { stubExecutor } from "@hmb/server-stub";

/** 브리지 주소. 없으면 로컬 기본값 — Pages 에서는 그냥 연결이 안 되고 폴백으로 간다. */
function bridgeUrl(): string {
  const raw: unknown = import.meta.env?.VITE_AI_BRIDGE_URL;
  return typeof raw === "string" && raw.trim() ? raw.trim().replace(/\/+$/, "") : "";
}

export type AiStatus =
  | { kind: "unknown" }
  /** 브리지가 살아 있고 claude 로그인도 확인됐다. */
  | { kind: "ready"; model?: string }
  /** 브리지가 없다(=Pages·`npm run play`). */
  | { kind: "no-bridge" }
  /** 브리지는 있는데 claude 로그인이 안 됐거나 실행이 실패했다. */
  | { kind: "not-logged-in"; reason?: string };

let status: AiStatus = { kind: "unknown" };
const listeners = new Set<() => void>();

export function aiStatus(): AiStatus {
  return status;
}

export function subscribeAiStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setStatus(next: AiStatus): void {
  if (next.kind === status.kind) return;
  status = next;
  for (const fn of [...listeners]) fn();
}

/**
 * 브리지 확인 상한. 로컬 프로세스지만 기동 직후에는 `claude` 확인이 아직 안 끝났을 수 있어
 * 너무 짧게 잡으면 **살아 있는 브리지를 없다고 판정**한다(실측으로 그랬다). 그래도 상한은 둔다 —
 * 브리지가 매달리면 첫 화면이 같이 멈춘다.
 */
const PROBE_TIMEOUT_MS = 20_000;
const JOB_TIMEOUT_MS = 180_000;

async function bridgeFetch<T>(path: string, body?: unknown, timeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
  const base = bridgeUrl();
  if (!base) throw new Error("no-bridge");
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl?.signal,
    });
    if (!res.ok) throw new Error(`bridge ${res.status}`);
    return (await res.json()) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let probe: Promise<void> | null = null;

/**
 * 브리지·로그인 상태를 한 번만 확인한다. **절대 throw 하지 않는다** — AI 가 없다는 것은
 * 정상 경로(스태틱 폴백)지 장애가 아니다.
 */
export function probeAi(): Promise<void> {
  probe ??= (async () => {
    if (!bridgeUrl()) {
      setStatus({ kind: "no-bridge" });
      return;
    }
    try {
      const health = await bridgeFetch<{ loggedIn?: boolean; model?: string; reason?: string }>("/ai/health");
      if (health.loggedIn) setStatus({ kind: "ready", ...(health.model ? { model: health.model } : {}) });
      else setStatus({ kind: "not-logged-in", ...(health.reason ? { reason: health.reason } : {}) });
    } catch {
      setStatus({ kind: "no-bridge" });
    }
  })();
  return probe;
}

/** 스태틱(결정론) 폴백 — `stubExecutor` 를 그대로 부른다. */
async function stubTactics(context: TeamInputJobContext): Promise<TacticalInput> {
  // ExecutorJob 은 서버 모듈의 타입이고 스텁이 읽는 필드는 kind·context 뿐이다(그 파일의
  // execute() 가 근거). 브라우저에서 잡 큐를 흉내내지 않으려고 최소 형태만 넘긴다.
  const job = { id: context.matchId, kind: context.kind, context } as unknown as Parameters<
    ReturnType<typeof stubExecutor>["execute"]
  >[0];
  return (await stubExecutor().execute(job)) as TacticalInput;
}

/**
 * 전술 인풋 1건. AI 가 준비돼 있으면 AI, 아니면 폴백.
 * 반환의 `aiGenerated` 로 화면이 "무엇으로 만든 경기인지"를 말할 수 있다.
 */
export async function buildTacticalInput(
  context: TeamInputJobContext,
): Promise<{ input: TacticalInput; aiGenerated: boolean }> {
  await probeAi();
  if (status.kind === "ready") {
    try {
      const out = await bridgeFetch<TacticalInput>("/ai/team-input", { context }, JOB_TIMEOUT_MS);
      return { input: out, aiGenerated: true };
    } catch (err) {
      // AI 실패는 **플레이를 막지 않는다** — 상태만 내리고 그 자리에서 폴백한다.
      setStatus({ kind: "not-logged-in", reason: err instanceof Error ? err.message : "failed" });
    }
  }
  return { input: await stubTactics(context), aiGenerated: false };
}

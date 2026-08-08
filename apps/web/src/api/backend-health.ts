/**
 * 백엔드 도달 상태 (#477).
 *
 * <b>왜 필요한가.</b> web 은 CF Pages 정적 배포라 **백엔드(터널/도커)가 죽어도 그대로 뜬다**.
 * 그때 유저가 보는 것은 빈 화면이거나 정체불명 에러였다 — 앱이 고장난 것처럼 보이고, 물어볼
 * 곳도 없다. 이 모듈은 "지금 백엔드에 못 닿는다"를 **한 곳에서** 판정해 점검 안내로 바꾼다.
 *
 * <b>오탐이 장애보다 나쁘다.</b> 점검 화면은 앱을 통째로 덮으므로, 지하철에서 한 번 끊긴 유저에게
 * 띄우면 멀쩡한 서비스를 장애로 선언하는 셈이다. 그래서 실패 보고 1건으로는 절대 확정하지 않고,
 * <b>확인 프로브가 {@link OUTAGE_CONFIRM_PROBES}회 연속 전부 실패</b>해야 `outage` 로 간다.
 * 그 사이 어디서든 정상 응답이 오면 즉시 취소된다.
 *
 * <b>이 모듈은 fetch 를 모른다.</b> 프로브 구현은 {@link setBackendProbe} 로 주입한다
 * (`api/client.ts` 가 부팅 시 1회 등록) — 그래야 client ↔ health 순환 import 가 생기지 않고,
 * 테스트가 타이머·네트워크 없이 상태기계만 검정할 수 있다.
 */

export type BackendHealth = "ok" | "checking" | "outage";

/** 확정에 필요한 연속 실패 프로브 수. 1 이면 단발 흔들림이 그대로 장애가 된다. */
export const OUTAGE_CONFIRM_PROBES = 2;
/** 확인 프로브 간격(ms). 첫 프로브도 이만큼 기다린 뒤 쏜다 — 순간 끊김에 시간을 준다. */
export const PROBE_INTERVAL_MS = 2000;
/** outage 확정 후 자동 재확인 간격(ms). 유저가 아무것도 안 해도 복구되면 돌아온다. */
export const RECHECK_INTERVAL_MS = 15_000;

type Listener = (health: BackendHealth) => void;

let health: BackendHealth = "ok";
/**
 * 세대 카운터 — `ok` 로 돌아갈 때마다 증가한다. 진행 중이던 확인 루프가 **뒤늦게 돌아와**
 * 이미 복구된 상태를 다시 `outage` 로 덮는 것을 막는다(await 사이에 상태가 바뀔 수 있다).
 */
let generation = 0;
const listeners = new Set<Listener>();

/** 기본 프로브 = "모른다" → 확정하지 않는다(주입 전에는 점검 화면이 뜨지 않는다). */
let probe: () => Promise<boolean> = () => Promise.resolve(true);
let delay: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
/** 자동 재확인 타이머 핸들. 정상 복귀·리셋 때 반드시 해제한다(테스트 프로세스가 안 끝난다). */
let recheckTimer: ReturnType<typeof setTimeout> | null = null;

/** 프로덕션 배선: `api/client.ts` 가 실제 헬스 프로브를 등록한다. */
export function setBackendProbe(fn: () => Promise<boolean>): void {
  probe = fn;
}

/** 테스트 전용 — 대기를 즉시 통과시켜 상태기계만 검정한다. */
export function __setBackendHealthDelay(fn: (ms: number) => Promise<void>): void {
  delay = fn;
}

/** 테스트 전용 상태 리셋(모듈 스코프 상태 때문에 필요). */
export function __resetBackendHealth(): void {
  health = "ok";
  generation++;
  listeners.clear();
  clearRecheck();
  probe = () => Promise.resolve(true);
}

export function getBackendHealth(): BackendHealth {
  return health;
}

export function subscribeBackendHealth(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function set(next: BackendHealth): void {
  if (health === next) return;
  health = next;
  if (next === "ok") {
    generation++;
    clearRecheck();
  }
  for (const fn of listeners) fn(next);
}

/**
 * 요청이 정상 응답을 받았다 — 어떤 상태였든 즉시 정상으로 돌린다.
 * (진행 중인 확인 루프는 세대 카운터로 무효화된다.)
 */
export function reportBackendReachable(): void {
  set("ok");
}

/**
 * 요청이 백엔드에 못 닿았다(응답 없음 또는 게이트웨이 5xx). **여기서 확정하지 않는다** —
 * 확인 루프를 시작할 뿐이고, 이미 확인 중이거나 확정된 상태면 중복 기동하지 않는다.
 */
export function reportBackendUnreachable(): void {
  if (health !== "ok") return;
  health = "checking"; // 화면엔 아직 아무것도 안 띄운다(구독자 통지 없음)
  void confirmOutage(generation);
}

async function confirmOutage(gen: number): Promise<void> {
  for (let i = 0; i < OUTAGE_CONFIRM_PROBES; i++) {
    await delay(PROBE_INTERVAL_MS);
    if (gen !== generation) return; // 그 사이 정상 응답이 왔다
    if (await probe()) {
      if (gen === generation) set("ok");
      return;
    }
    if (gen !== generation) return; // 프로브를 기다리는 동안 복구됐다
  }
  if (gen !== generation) return;
  set("outage");
  scheduleRecheck(generation);
}

/**
 * outage 확정 후 조용히 계속 두드린다 — 워치독이 터널을 되살리면 유저 조작 없이 돌아온다.
 *
 * ⚠️ **주입 가능한 `delay` 를 쓰는 while 루프로 만들면 안 된다.** 테스트가 대기를 0 으로 주면
 * 그 루프가 이벤트 루프를 굶겨 프로세스가 통째로 멈춘다(실제로 그렇게 한 번 매달렸다).
 * 재확인은 **항상 실시간 타이머**로 돈다 — 주기가 곧 이 기능의 의미이기 때문이다.
 */
function scheduleRecheck(gen: number): void {
  clearRecheck();
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    if (gen !== generation || health !== "outage") return;
    void probe().then((alive) => {
      if (gen !== generation) return;
      if (alive) set("ok");
      else scheduleRecheck(gen);
    });
  }, RECHECK_INTERVAL_MS);
}

function clearRecheck(): void {
  if (recheckTimer !== null) {
    clearTimeout(recheckTimer);
    recheckTimer = null;
  }
}

/** 점검 화면의 [다시 시도]. 살아 있으면 true + 즉시 정상 복귀. */
export async function retryBackendNow(): Promise<boolean> {
  const alive = await probe();
  if (alive) set("ok");
  return alive;
}

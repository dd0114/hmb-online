import { spawn } from "node:child_process";

/**
 * ai-mode — 기동 프리플라이트: **클로드 로그인 여부로 실효 AI 모드를 정한다** (#471 AC3).
 *
 * hero 요구: *"클로드 로그인 안되어있으면 게임시작할때 안내말만하고 스태틱 엔진으로 써있어야함."*
 * 기존 `claudeCodeAuthSelfCheck()`(executors/claude-code.ts)는 **API 키 경고만** 하고 로그인 여부는
 * 한 번도 보지 않았다 — 미로그인 상태로 기동하면 잡을 집은 뒤에야 매 경기 실패했다.
 *
 * 설계 두 줄:
 *  - **판정은 순수 함수**(`resolveAiMode`) — 프로브는 주입된다. 실제 로그인 상태에 의존하는 판정 로직은
 *    검정할 수 없다(claude-code.ts 의 `ClaudeRunner` 주입과 같은 관례).
 *  - **사유는 표 하나가 단일 출처**(`AI_MODE_REASONS`) — 실행기 로그 · `/internal/ai-mode` 신고 ·
 *    `/api/config` 의 `ai.reason` · README/doctor 문구가 전부 이 열거를 쓴다.
 */

/** 강등 사유 표 — 단일 출처. `logged-in`·`not-wanted` 는 "강등 없음" 사유다. */
export const AI_MODE_REASONS = [
  /** 희망 모드가 claude-code 가 아니다 → 프로브 생략(stub 기동에 CLI 는 불필요). */
  "not-wanted",
  /** `claude` 실행 파일이 PATH 에 없다. */
  "cli-missing",
  /** 프로브가 돌긴 했는데 결과를 못 읽었다(비JSON·필드 부재·예외). */
  "probe-failed",
  /** 프로브가 제한 시간 안에 안 끝났다(무한 대기 금지). */
  "probe-timeout",
  /** CLI 는 있는데 로그인이 안 돼 있다. */
  "logged-out",
  /** 로그인돼 있다 → 강등 없음. */
  "logged-in",
] as const;

export type AiModeReason = (typeof AI_MODE_REASONS)[number];

/** 화면·API 가 쓰는 모드 라벨. `unknown` 은 **서버가** 붙인다(아직 신고 전) — 실행기는 쓰지 않는다. */
export type AiMode = "live" | "stub";

export interface AuthProbeResult {
  /** 로그인 여부를 **읽어냈다**는 뜻(값이 false 여도 ok:true). 못 읽었으면 false. */
  ok: boolean;
  loggedIn?: boolean;
  timedOut?: boolean;
  cliMissing?: boolean;
  /** 로그용 짧은 사유. 토큰·이메일 등은 담지 않는다. */
  detail?: string;
}

export type AuthProbe = () => Promise<AuthProbeResult>;

export interface AiModeDecision {
  /** env `AI_EXECUTOR` 가 요청한 모드. */
  wanted: string;
  /** 실제로 만들 executor kind. */
  effective: string;
  mode: AiMode;
  reason: AiModeReason;
  downgraded: boolean;
  detail?: string;
}

/**
 * 프리플라이트 판정. **어떤 입력에도 던지지 않는다** — 프로브가 터져도 게임은 스텁으로 떠야 한다.
 * `wanted` 가 claude-code 가 아니면 프로브를 호출조차 하지 않는다.
 */
export async function resolveAiMode(wanted: string, probe: AuthProbe): Promise<AiModeDecision> {
  if (wanted !== "claude-code") {
    return { wanted, effective: wanted, mode: "stub", reason: "not-wanted", downgraded: false };
  }

  let r: AuthProbeResult;
  try {
    r = await probe();
  } catch (e) {
    r = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  const down = (reason: AiModeReason): AiModeDecision => ({
    wanted,
    effective: "stub",
    mode: "stub",
    reason,
    downgraded: true,
    ...(r.detail === undefined ? {} : { detail: r.detail }),
  });

  if (r.cliMissing) return down("cli-missing");
  if (r.timedOut) return down("probe-timeout");
  if (!r.ok) return down("probe-failed");
  if (!r.loggedIn) return down("logged-out");
  return { wanted, effective: "claude-code", mode: "live", reason: "logged-in", downgraded: false };
}

/** 프로브 러너 결과(주입 가능 — 테스트는 subprocess 를 띄우지 않는다). */
export interface AuthRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
}

export type AuthRunner = (args: string[], timeoutMs: number) => Promise<AuthRunResult>;

export interface ClaudeAuthProbeOptions {
  runner?: AuthRunner;
  /** 기본 10초. 기동을 세우지 않는 것이 로그인 판정보다 중요하다. */
  timeoutMs?: number;
  /** 실행 파일. 기본 env `CLAUDE_BIN` → `claude`. */
  bin?: string;
}

/**
 * 기본 프로브 = `claude auth status --json`.
 * 실측 출력: `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max",…}`
 * **exit 코드로 판정하지 않는다** — stdout 에 `loggedIn` 불리언이 있으면 그것이 답이고(로그아웃 시
 * 비영 코드를 줄 수 있다), 없을 때만 timeout/ENOENT/파싱실패로 갈린다.
 */
export function createClaudeAuthProbe(opts: ClaudeAuthProbeOptions = {}): AuthProbe {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const bin = opts.bin ?? process.env["CLAUDE_BIN"] ?? "claude";
  const runner = opts.runner ?? defaultAuthRunner(bin);

  return async () => {
    const res = await runner(["auth", "status", "--json"], timeoutMs);
    const loggedIn = readLoggedIn(res.stdout);
    if (loggedIn !== null) return { ok: true, loggedIn };
    if (res.spawnError?.code === "ENOENT") return { ok: false, cliMissing: true, detail: `${bin} 없음` };
    if (res.timedOut) return { ok: false, timedOut: true, detail: `프로브 ${timeoutMs}ms 초과` };
    return {
      ok: false,
      detail: `exit ${res.code}: ${(res.stderr || res.stdout).trim().slice(0, 120)}`,
    };
  };
}

/** stdout 에서 `loggedIn` 불리언만 추출. 못 읽으면 null(넘겨짚지 않는다). */
function readLoggedIn(stdout: string): boolean | null {
  try {
    const v = JSON.parse(stdout) as unknown;
    if (v && typeof v === "object" && typeof (v as { loggedIn?: unknown }).loggedIn === "boolean") {
      return (v as { loggedIn: boolean }).loggedIn;
    }
  } catch {
    /* 비JSON → null */
  }
  return null;
}

function defaultAuthRunner(bin: string): AuthRunner {
  return (args, timeoutMs) =>
    new Promise<AuthRunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let done = false;
      const finish = (r: AuthRunResult): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      // ⚠️ ANTHROPIC_API_KEY 는 엔트리(prepareExecutorEnv)에서 이미 unset 된다 — 여기서 다시 넣지 않는다.
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ code: -1, stdout, stderr, timedOut: true });
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (e) => finish({ code: -1, stdout, stderr, timedOut: false, spawnError: e }));
      child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr, timedOut: false }));
    });
}

/** 실행기 로그 한 줄. `scripts/local-stack.sh doctor` 문구와 같은 사유 어휘를 쓴다. */
export function describeAiMode(d: AiModeDecision): string {
  if (!d.downgraded) {
    return d.reason === "logged-in"
      ? "AI 모드 live — 구독 로그인 확인됨(claude-code)."
      : `AI 모드 stub — 희망 모드가 ${d.wanted} (${d.reason}).`;
  }
  const tail = d.detail ? ` — ${d.detail}` : "";
  return `AI 모드 스텁 엔진으로 강등 (${d.reason})${tail}. 라이브 AI 를 쓰려면 \`claude\` 로그인 후 다시 기동하세요.`;
}

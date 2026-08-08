import { describe, it, expect, vi } from "vitest";
import {
  AI_MODE_REASONS,
  resolveAiMode,
  createClaudeAuthProbe,
  describeAiMode,
  type AuthProbe,
  type AuthRunner,
} from "./ai-mode.js";

/**
 * AC3 계약 — "클로드 로그인 안 되어 있으면 게임시작할 때 안내말만 하고 스태틱 엔진"(#471 hero 요구).
 *
 * 이 파일이 지키는 것은 두 가지다:
 *  ① **강등은 판정 함수 하나가 결정한다** — 사유 표(6개)가 단일 출처이고, 어떤 입력도 표 밖으로 못 나간다.
 *  ② **프로브는 주입된다** — 실제 `claude` 로그인 상태에 의존하는 테스트는 CI 에서 거짓 green/red 를 낸다.
 *     기본 프로브는 러너를 주입해 subprocess 없이 검정한다(claude-code.ts 의 ClaudeRunner 관례와 동일).
 */

const probeNever: AuthProbe = async () => {
  throw new Error("프로브가 호출되면 안 되는 경로");
};

describe("resolveAiMode — 강등 사유 표", () => {
  it("사유 표가 단일 출처이고 6개다", () => {
    expect([...AI_MODE_REASONS]).toEqual([
      "not-wanted",
      "cli-missing",
      "probe-failed",
      "probe-timeout",
      "logged-out",
      "logged-in",
    ]);
  });

  it("희망이 claude-code 가 아니면 프로브를 아예 호출하지 않는다(stub 기동에 CLI 불필요)", async () => {
    const probe = vi.fn(probeNever);
    const d = await resolveAiMode("stub", probe);
    expect(probe).not.toHaveBeenCalled();
    expect(d).toMatchObject({ wanted: "stub", effective: "stub", mode: "stub", reason: "not-wanted", downgraded: false });
  });

  it("로그인돼 있으면 강등하지 않는다 → live", async () => {
    const d = await resolveAiMode("claude-code", async () => ({ ok: true, loggedIn: true }));
    expect(d).toMatchObject({ effective: "claude-code", mode: "live", reason: "logged-in", downgraded: false });
  });

  it.each([
    ["cli-missing", { ok: false, cliMissing: true }],
    ["probe-timeout", { ok: false, timedOut: true }],
    ["probe-failed", { ok: false, detail: "파싱 실패" }],
    ["logged-out", { ok: true, loggedIn: false }],
  ] as const)("%s 면 stub 으로 강등한다", async (reason, result) => {
    const d = await resolveAiMode("claude-code", async () => result);
    expect(d).toMatchObject({ wanted: "claude-code", effective: "stub", mode: "stub", reason, downgraded: true });
  });

  it("프로브가 던져도 기동을 막지 않고 probe-failed 로 강등한다", async () => {
    const d = await resolveAiMode("claude-code", async () => {
      throw new Error("boom");
    });
    expect(d).toMatchObject({ effective: "stub", mode: "stub", reason: "probe-failed", downgraded: true });
    expect(d.detail).toContain("boom");
  });

  it("사유는 표 밖으로 나가지 않는다", async () => {
    for (const result of [
      { ok: true, loggedIn: true },
      { ok: true, loggedIn: false },
      { ok: false, cliMissing: true },
      { ok: false, timedOut: true },
      { ok: false },
    ]) {
      const d = await resolveAiMode("claude-code", async () => result);
      expect(AI_MODE_REASONS).toContain(d.reason);
    }
  });
});

describe("createClaudeAuthProbe — 기본 프로브(러너 주입)", () => {
  it("`claude auth status --json` 을 부른다", async () => {
    const runner = vi.fn<AuthRunner>(async () => ({
      code: 0,
      stdout: '{"loggedIn":true}',
      stderr: "",
      timedOut: false,
    }));
    await createClaudeAuthProbe({ runner })();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0]).toEqual(["auth", "status", "--json"]);
  });

  it("loggedIn:true 를 읽는다", async () => {
    const probe = createClaudeAuthProbe({
      runner: async () => ({
        code: 0,
        stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}',
        stderr: "",
        timedOut: false,
      }),
    });
    await expect(probe()).resolves.toMatchObject({ ok: true, loggedIn: true });
  });

  it("loggedIn:false 는 exit 코드와 무관하게 로그아웃으로 읽는다", async () => {
    const probe = createClaudeAuthProbe({
      runner: async () => ({ code: 1, stdout: '{"loggedIn":false}', stderr: "", timedOut: false }),
    });
    await expect(probe()).resolves.toMatchObject({ ok: true, loggedIn: false });
  });

  it("CLI 부재(ENOENT)는 probe-failed 가 아니라 cli-missing 이다", async () => {
    const err: NodeJS.ErrnoException = new Error("spawn claude ENOENT");
    err.code = "ENOENT";
    const probe = createClaudeAuthProbe({
      runner: async () => ({ code: -1, stdout: "", stderr: "", timedOut: false, spawnError: err }),
    });
    await expect(probe()).resolves.toMatchObject({ ok: false, cliMissing: true });
  });

  it("타임아웃은 별도 사유다(무한 대기 금지)", async () => {
    const probe = createClaudeAuthProbe({
      runner: async () => ({ code: -1, stdout: "", stderr: "", timedOut: true }),
    });
    await expect(probe()).resolves.toMatchObject({ ok: false, timedOut: true });
  });

  it("JSON 이 아니거나 loggedIn 이 없으면 probe-failed 로 흘린다(로그인으로 넘겨짚지 않는다)", async () => {
    for (const stdout of ["", "not json", "{}", '{"loggedIn":"yes"}']) {
      const probe = createClaudeAuthProbe({
        runner: async () => ({ code: 0, stdout, stderr: "", timedOut: false }),
      });
      const r = await probe();
      expect(r.ok).toBe(false);
      expect(r.cliMissing).not.toBe(true);
      expect(r.timedOut).not.toBe(true);
    }
  });
});

describe("describeAiMode — 사람이 읽는 한 줄", () => {
  it("강등이면 왜 강등됐는지가 문장에 들어간다", async () => {
    const d = await resolveAiMode("claude-code", async () => ({ ok: false, cliMissing: true }));
    const line = describeAiMode(d);
    expect(line).toContain("스텁");
    expect(line).toContain("cli-missing");
  });

  it("라이브면 강등 문구가 없다", async () => {
    const d = await resolveAiMode("claude-code", async () => ({ ok: true, loggedIn: true }));
    expect(describeAiMode(d)).not.toContain("강등");
  });
});

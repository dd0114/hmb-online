// qa-tab CLI 계약 (#191 AC1/AC3/AC4). 다른 세션이 의존하는 표면이므로 **실제 프로세스로** 검증한다
// (모듈 직접 호출로는 exit code·stdout 규약이 안 잡힌다 — 세션은 그 두 개로 판단한다).
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { appendFeedback, readAck, readTab } from "./registry.mjs";

const CLI = resolve(__dirname, "..", "qa-tab.mjs");
let home: string;
let logA: string;
let logB: string;

function run(args: string[], cwd = home) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HMB_QA_CONSOLE_HOME: home, HMB_QA_CONSOLE_PORT: "8300" },
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "qa-cli-test-"));
  mkdirSync(join(home, "logs"), { recursive: true });
  logA = join(home, "logs", "after.json");
  logB = join(home, "logs", "before.json");
  writeFileSync(logA, JSON.stringify({ tickSnapshots: [] }));
  writeFileSync(logB, JSON.stringify({ tickSnapshots: [] }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const registerArgs = (id = "182-corner-stay") => [
  "register", "--id", id, "--issue", "182",
  "--title", "코너 전원 전진 → 잔류 1~3명",
  "--summary", "잔류 0명 → 1~3명",
  "--ask", "잔류가 자연스러운가",
  "--log", `${logA}@after:after (fix)`,
  "--log", `${logB}@before:before (0.19.0)`,
  "--point", "12:34 첫 코너 — 잔류 확인",
  "--point", "12:34@before 같은 장면",
];

describe("register (AC1)", () => {
  it("탭을 만들고 hero 에게 줄 URL 을 stdout 으로 낸다", () => {
    const r = run(registerArgs());
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("http://127.0.0.1:8300/qa/console?tab=182-corner-stay");
    const tab = readTab(home, "182-corner-stay");
    expect(tab.title).toBe("코너 전원 전진 → 잔류 1~3명");
    expect(tab.views.map((v: { id: string }) => v.id)).toEqual(["after", "before"]);
    expect(tab.watch[0]).toMatchObject({ tick: 754, label: "첫 코너 — 잔류 확인" });
    expect(tab.watch[1]).toMatchObject({ tick: 754, view: "before" });
  });

  it("git 이력을 남긴다 — 히스토리 요구(§3.1)", () => {
    run(registerArgs());
    const log = spawnSync("git", ["-C", home, "log", "--oneline"], { encoding: "utf8" });
    expect(log.status).toBe(0);
    expect(log.stdout).toMatch(/qa\(182-corner-stay\): register/);
  });

  it("없는 로그를 가리키면 실패한다 — hero 가 빈 화면을 보기 전에 세션이 안다", () => {
    const r = run(["register", "--id", "x-tab", "--title", "t", "--log", join(home, "logs", "nope.json")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/없다/);
    expect(readTab(home, "x-tab")).toBeNull();
  });

  it("--log 없이는 만들 수 없다", () => {
    expect(run(["register", "--id", "x-tab", "--title", "t"]).status).toBe(2);
  });

  it("같은 id 재등록은 막고, --force 면 덮어쓴다", () => {
    run(registerArgs());
    expect(run(registerArgs()).status).toBe(2);
    const forced = run([...registerArgs(), "--force"]);
    expect(forced.status).toBe(0);
  });

  it("탭 id 에 경로 조작을 넣으면 거부한다", () => {
    const r = run(["register", "--id", "../escape", "--title", "t", "--log", logA]);
    expect(r.status).not.toBe(0);
  });
});

describe("update / status / show / list", () => {
  beforeEach(() => run(registerArgs()));

  it("부분 갱신은 준 필드만 바꾼다", () => {
    expect(run(["update", "--id", "182-corner-stay", "--summary", "새 요약"]).status).toBe(0);
    const tab = readTab(home, "182-corner-stay");
    expect(tab.summary).toBe("새 요약");
    expect(tab.title).toBe("코너 전원 전진 → 잔류 1~3명");
  });

  it("status 로 waiting/resolved 를 옮긴다", () => {
    run(["status", "--id", "182-corner-stay", "--set", "waiting"]);
    expect(readTab(home, "182-corner-stay").status).toBe("waiting");
    run(["status", "--id", "182-corner-stay", "--set", "resolved"]);
    expect(readTab(home, "182-corner-stay").status).toBe("resolved");
  });

  it("모르는 status 는 거부", () => {
    expect(run(["status", "--id", "182-corner-stay", "--set", "nope"]).status).toBe(2);
  });

  it("없는 탭 조작은 exit 4 — 세션이 '오타냐 삭제냐'를 코드로 구분한다", () => {
    expect(run(["show", "--id", "ghost-tab"]).status).toBe(4);
    expect(run(["update", "--id", "ghost-tab", "--summary", "x"]).status).toBe(4);
  });

  it("list --json 이 여러 세션 탭을 섞이지 않게 낸다(AC4)", () => {
    run(registerArgs("176-deadball"));
    run(registerArgs("181-ball-curve"));
    const r = run(["list", "--json"]);
    const ids = JSON.parse(r.stdout).map((v: { tab: { tabId: string } }) => v.tab.tabId).sort();
    expect(ids).toEqual(["176-deadball", "181-ball-curve", "182-corner-stay"]);
  });
});

describe("피드백 왕복 (AC3)", () => {
  beforeEach(() => {
    run(registerArgs());
    run(["status", "--id", "182-corner-stay", "--set", "waiting"]);
  });

  it("hero 문장이 그대로 세션에 온다(D9) — 미수신만 골라 받는다", () => {
    appendFeedback(home, "182-corner-stay", {
      verdict: "reject", body: "잔류는 되는데 3명 다 GK 옆에 뭉쳐 있다", view: "after", tick: 760,
      now: new Date().toISOString(),
    });
    const r = run(["feedback", "--id", "182-corner-stay", "--unread", "--json"]);
    expect(r.status).toBe(0);
    const items = JSON.parse(r.stdout);
    expect(items).toHaveLength(1);
    expect(items[0].body).toBe("잔류는 되는데 3명 다 GK 옆에 뭉쳐 있다");
    expect(items[0].clock).toBe("12'40\"");
  });

  it("ack 하면 미수신에서 빠진다", () => {
    appendFeedback(home, "182-corner-stay", { verdict: "comment", body: "a", now: new Date().toISOString() });
    run(["ack", "--id", "182-corner-stay", "--state", "working", "--note", "재현 중"]);
    expect(readAck(home, "182-corner-stay").cursor).toBe(1);
    expect(JSON.parse(run(["feedback", "--id", "182-corner-stay", "--unread", "--json"]).stdout)).toEqual([]);
  });

  it("wait 은 이미 온 피드백에 즉시 종료(exit 0) + 내용을 stdout JSON 으로 준다", () => {
    appendFeedback(home, "182-corner-stay", { verdict: "approve", body: "통과", now: new Date().toISOString() });
    const r = run(["wait", "--id", "182-corner-stay", "--timeout", "5"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.tabId).toBe("182-corner-stay");
    expect(out.items[0].verdict).toBe("approve");
  });

  it("wait 은 아무것도 없으면 exit 3(타임아웃) — 세션이 다시 걸면 된다", () => {
    const r = run(["wait", "--id", "182-corner-stay", "--timeout", "1"]);
    expect(r.status).toBe(3);
  });

  it("wait 은 없는 탭이면 exit 4", () => {
    expect(run(["wait", "--id", "ghost-tab", "--timeout", "1"]).status).toBe(4);
  });
});

describe("export — 픽스 PR 에 QA 근거 싣기", () => {
  it("브리핑 + 왕복 전문을 마크다운으로 낸다", () => {
    run(registerArgs());
    appendFeedback(home, "182-corner-stay", {
      verdict: "reject", body: "뭉침 먼저", view: "after", tick: 760, now: new Date().toISOString(),
    });
    run(["ack", "--id", "182-corner-stay", "--state", "done", "--note", "markGap 로 분리"]);
    const out = join(home, "out", "qa.md");
    const r = run(["export", "--id", "182-corner-stay", "--out", out]);
    expect(r.status).toBe(0);
    const md = readFileSync(out, "utf8");
    expect(md).toMatch(/# QA 콘솔 기록/);
    expect(md).toMatch(/뭉침 먼저/);
    expect(md).toMatch(/세션 처리: done — markGap 로 분리/);
    expect(md).toMatch(/12'40"/);
  });
});

describe("help", () => {
  it("동사 없이 부르면 사용법을 낸다(다른 세션의 첫 진입점)", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/register/);
    expect(r.stdout).toMatch(/wait/);
  });

  it("모르는 동사는 exit 2 + 사용법", () => {
    const r = run(["nonsense"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/register/);
  });
});

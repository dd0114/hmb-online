// QA 콘솔 레지스트리 계약 (#191 웨이브2). 구현 전에 기대동작을 먼저 박는다(루트 §2-3 E2E-TDD).
//
// 이 파일이 지키는 것은 **다른 세션이 의존하는 표면**이다: 탭 id 규칙 · 부분 갱신 머지 ·
// 확인포인트/로그 인자 파싱 · 로그 경로 allowlist · 피드백 seq 단조성 · ack 커서 · stale 판정.
// 시간은 전부 주입한다(순수 함수 유지 — 테스트가 시계에 흔들리지 않게).
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  QA_CONSOLE_VERSION,
  SCHEMA_VERSION,
  appendFeedback,
  buildTab,
  ensureHome,
  listTabs,
  logPathAllowed,
  mergeTab,
  normalizeTabId,
  parseClock,
  parseLogArg,
  parsePointArg,
  readAck,
  readFeedback,
  readTab,
  removeTab,
  tabView,
  unreadFeedback,
  writeAck,
  writeTab,
} from "./registry.mjs";

let home: string;
let logFile: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "qa-console-test-"));
  ensureHome(home);
  // allowlist 통과용 실제 로그 파일(존재 검증도 걸린다)
  const logDir = join(home, "logs");
  mkdirSync(logDir, { recursive: true });
  logFile = join(logDir, "fixture-real.json");
  writeFileSync(logFile, JSON.stringify({ tickSnapshots: [] }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** 최소 유효 탭 입력 — 각 테스트가 필요한 필드만 덮어쓴다. */
function input(over: Record<string, unknown> = {}) {
  return {
    tabId: "182-corner-stay",
    issue: 182,
    title: "코너 전원 전진 → 잔류 1~3명",
    session: "hmb:bug182",
    checkout: "/Users/peter.park/spider12/hmb-online",
    branch: "bug/182",
    summary: "잔류 0명이던 것을 1~3명으로",
    ask: "잔류가 자연스러운가",
    views: [{ id: "after", label: "after (fix)", logPath: logFile }],
    watch: [{ tick: 754, label: "첫 코너" }],
    now: "2026-07-26T04:00:00.000Z",
    ...over,
  };
}

describe("탭 id", () => {
  it("이슈-슬러그 형태를 통과시킨다", () => {
    expect(normalizeTabId("182-corner-stay")).toBe("182-corner-stay");
    expect(normalizeTabId("  176-deadball  ")).toBe("176-deadball");
  });

  it("경로 조작·공백·대문자를 거부한다 — id 가 곧 파일명이라 탈출이 곧 임의쓰기다", () => {
    for (const bad of ["../escape", "a/b", "has space", "UPPER", "", ".", "..", "dot.dot", "sym$bol"]) {
      expect(() => normalizeTabId(bad)).toThrow();
    }
  });
});

describe("확인 포인트 인자", () => {
  it("mm:ss 를 여러 표기로 받는다(apps/web parseClockInput 과 같은 계약)", () => {
    expect(parseClock("12:34")).toBe(754);
    expect(parseClock("12'34\"")).toBe(754);
    expect(parseClock("12 34")).toBe(754);
    expect(parseClock("1:2")).toBe(62);
    expect(parseClock("754")).toBe(754);
    expect(parseClock("12:60")).toBeNull(); // 초는 59 까지
    expect(parseClock("nope")).toBeNull();
    expect(parseClock("")).toBeNull();
    expect(parseClock(null)).toBeNull();
  });

  it("`12:34 라벨` 을 tick+label 로 쪼갠다", () => {
    expect(parsePointArg("12:34 첫 코너 — 잔류 확인")).toEqual({
      tick: 754,
      label: "첫 코너 — 잔류 확인",
    });
  });

  it("`12:34@before 라벨` 로 볼 뷰까지 지정한다", () => {
    expect(parsePointArg("12:34@before 같은 장면")).toEqual({
      tick: 754,
      view: "before",
      label: "같은 장면",
    });
  });

  it("시각이 없으면 tick 없이 라벨만 — 설명용 포인트도 허용", () => {
    expect(parsePointArg("경기 전체 인상")).toEqual({ tick: null, label: "경기 전체 인상" });
  });
});

describe("로그 인자", () => {
  it("`경로@id:라벨` 을 뷰로 만든다", () => {
    expect(parseLogArg(`${logFile}@after:after (fix)`, home)).toEqual({
      id: "after",
      label: "after (fix)",
      logPath: logFile,
    });
  });

  it("id·라벨을 생략하면 파일명에서 유도한다", () => {
    expect(parseLogArg(logFile, home)).toEqual({
      id: "fixture-real",
      label: "fixture-real",
      logPath: logFile,
    });
  });

  it("상대경로는 기준 디렉토리로 절대화한다 — 세션이 자기 체크아웃에서 그냥 치게", () => {
    const v = parseLogArg("logs/fixture-real.json", home);
    expect(v.logPath).toBe(logFile);
  });
});

describe("로그 경로 allowlist", () => {
  it("허용 루트 안의 .json 만 통과", () => {
    expect(logPathAllowed(logFile, [home])).toBe(true);
  });

  it("허용 루트 밖은 거부", () => {
    expect(logPathAllowed("/etc/passwd", [home])).toBe(false);
  });

  it("`..` 로 루트를 벗어나면 거부 — 문자열 접두 비교로는 못 잡는다", () => {
    expect(logPathAllowed(join(home, "..", "escape.json"), [home])).toBe(false);
  });

  it(".json 이 아니면 거부(콘솔이 서빙하는 건 match-log 뿐)", () => {
    const other = join(home, "logs", "note.txt");
    writeFileSync(other, "x");
    expect(logPathAllowed(other, [home])).toBe(false);
  });
});

describe("탭 생성·갱신", () => {
  it("스키마·producer 버전을 박는다 — QA 버전이 올라가도 구기록을 읽을 수 있게", () => {
    const tab = buildTab(input());
    expect(tab.schemaVersion).toBe(SCHEMA_VERSION);
    expect(tab.producer).toBe(QA_CONSOLE_VERSION);
    expect(tab.createdAt).toBe("2026-07-26T04:00:00.000Z");
    expect(tab.status).toBe("draft"); // 등록 직후는 draft — waiting 은 세션이 명시
  });

  it("로그가 없는 뷰는 등록 자체를 실패시킨다 — 빈 화면 원인을 세션이 즉시 알게", () => {
    expect(() =>
      buildTab(input({ views: [{ id: "after", label: "x", logPath: join(home, "logs", "missing.json") }] })),
    ).toThrow(/없/);
  });

  it("뷰가 하나도 없으면 실패 — 관전 대상 없는 탭은 목적 미달", () => {
    expect(() => buildTab(input({ views: [] }))).toThrow();
  });

  it("watch 의 view 는 실제 뷰 id 여야 한다", () => {
    expect(() =>
      buildTab(input({ watch: [{ tick: 1, label: "x", view: "nope" }] })),
    ).toThrow(/nope/);
  });

  it("부분 갱신은 준 필드만 바꾸고 updatedAt 을 올린다", () => {
    const tab = buildTab(input());
    const merged = mergeTab(tab, { summary: "새 요약" }, "2026-07-26T05:00:00.000Z");
    expect(merged.summary).toBe("새 요약");
    expect(merged.title).toBe(tab.title); // 안 준 필드는 보존
    expect(merged.updatedAt).toBe("2026-07-26T05:00:00.000Z");
    expect(merged.createdAt).toBe(tab.createdAt);
  });

  it("갱신은 tabId·createdAt 을 못 바꾼다(정체성 고정)", () => {
    const tab = buildTab(input());
    const merged = mergeTab(tab, { tabId: "other", createdAt: "1999-01-01T00:00:00.000Z" } as never, "2026-07-26T05:00:00.000Z");
    expect(merged.tabId).toBe("182-corner-stay");
    expect(merged.createdAt).toBe(tab.createdAt);
  });
});

describe("파일 저장", () => {
  it("쓰고 읽으면 같다 · 없는 탭은 null", () => {
    const tab = buildTab(input());
    writeTab(home, tab);
    expect(readTab(home, tab.tabId)).toEqual(tab);
    expect(readTab(home, "nope-nope")).toBeNull();
  });

  it("목록은 여러 세션 탭을 섞이지 않게 전부 반환한다(AC4)", () => {
    writeTab(home, buildTab(input()));
    writeTab(home, buildTab(input({ tabId: "176-deadball", issue: 176, session: "hmb:bug176" })));
    writeTab(home, buildTab(input({ tabId: "181-ball", issue: 181, session: "hmb:bug181" })));
    const ids = listTabs(home).map((t) => t.tabId).sort();
    expect(ids).toEqual(["176-deadball", "181-ball", "182-corner-stay"]);
  });

  it("손상된 탭 파일 하나가 목록 전체를 죽이지 않는다", () => {
    writeTab(home, buildTab(input()));
    writeFileSync(join(home, "tabs", "broken.json"), "{ not json");
    expect(listTabs(home).map((t) => t.tabId)).toEqual(["182-corner-stay"]);
  });

  it("삭제하면 탭·피드백·ack 이 함께 사라진다", () => {
    const tab = buildTab(input());
    writeTab(home, tab);
    appendFeedback(home, tab.tabId, { verdict: "comment", body: "x", now: "2026-07-26T04:10:00.000Z" });
    writeAck(home, tab.tabId, { cursor: 1, items: {} }, "2026-07-26T04:11:00.000Z");
    removeTab(home, tab.tabId);
    expect(readTab(home, tab.tabId)).toBeNull();
    expect(readFeedback(home, tab.tabId)).toEqual([]);
    expect(readAck(home, tab.tabId).cursor).toBe(0);
  });
});

describe("피드백", () => {
  const now = (n: number) => `2026-07-26T04:${String(10 + n).padStart(2, "0")}:00.000Z`;

  it("seq 는 1부터 단조 증가하고 append 순서가 보존된다", () => {
    writeTab(home, buildTab(input()));
    const a = appendFeedback(home, "182-corner-stay", { verdict: "comment", body: "첫째", now: now(0) });
    const b = appendFeedback(home, "182-corner-stay", { verdict: "approve", body: "둘째", now: now(1) });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(readFeedback(home, "182-corner-stay").map((f) => f.body)).toEqual(["첫째", "둘째"]);
  });

  it("body 가 그대로 남는다 — 이 문장이 세션 프롬프트가 된다(D9)", () => {
    writeTab(home, buildTab(input()));
    const body = "잔류는 되는데 3명 다 GK 옆에 뭉쳐 있다";
    appendFeedback(home, "182-corner-stay", { verdict: "comment", body, now: now(0) });
    expect(readFeedback(home, "182-corner-stay")[0].body).toBe(body);
  });

  it("줄바꿈이 든 body 도 한 레코드로 남는다 — jsonl 이 깨지면 이력이 잘린다", () => {
    writeTab(home, buildTab(input()));
    appendFeedback(home, "182-corner-stay", { verdict: "comment", body: "첫줄\n둘째줄", now: now(0) });
    const raw = readFileSync(join(home, "feedback", "182-corner-stay.jsonl"), "utf8").trimEnd();
    expect(raw.split("\n")).toHaveLength(1);
    expect(readFeedback(home, "182-corner-stay")[0].body).toBe("첫줄\n둘째줄");
  });

  it("거부는 사유가 없으면 거절한다 — 세션이 뭘 할지 모른다", () => {
    writeTab(home, buildTab(input()));
    expect(() =>
      appendFeedback(home, "182-corner-stay", { verdict: "reject", body: "  ", now: now(0) }),
    ).toThrow();
  });

  it("승인/전달은 본문이 비어도 통과한다(태그만 눌러도 동작 — D9)", () => {
    writeTab(home, buildTab(input()));
    expect(appendFeedback(home, "182-corner-stay", { verdict: "approve", body: "", now: now(0) }).seq).toBe(1);
  });

  it("보던 장면(view·tick)을 함께 박는다 — 세션이 그 초를 재현한다", () => {
    writeTab(home, buildTab(input()));
    appendFeedback(home, "182-corner-stay", {
      verdict: "comment", body: "여기", view: "after", tick: 760, now: now(0),
    });
    const f = readFeedback(home, "182-corner-stay")[0];
    expect(f.view).toBe("after");
    expect(f.tick).toBe(760);
    expect(f.clock).toBe("12'40\""); // 사람이 읽는 표기도 같이 저장(세션 로그·이슈 인용용)
  });

  it("없는 탭에는 피드백을 못 남긴다", () => {
    expect(() => appendFeedback(home, "ghost-tab", { verdict: "comment", body: "x", now: now(0) })).toThrow();
  });
});

describe("ack(수신·처리상태)", () => {
  const T = "2026-07-26T04:30:00.000Z";

  it("미수신 = 커서 이후 전부", () => {
    writeTab(home, buildTab(input()));
    for (const b of ["a", "b", "c"]) {
      appendFeedback(home, "182-corner-stay", { verdict: "comment", body: b, now: T });
    }
    const fb = readFeedback(home, "182-corner-stay");
    expect(unreadFeedback(fb, { cursor: 0, items: {} }).map((f) => f.body)).toEqual(["a", "b", "c"]);
    expect(unreadFeedback(fb, { cursor: 2, items: {} }).map((f) => f.body)).toEqual(["c"]);
    expect(unreadFeedback(fb, { cursor: 3, items: {} })).toEqual([]);
  });

  it("ack 은 커서와 항목별 처리상태를 남긴다", () => {
    writeTab(home, buildTab(input()));
    appendFeedback(home, "182-corner-stay", { verdict: "reject", body: "고쳐", now: T });
    writeAck(home, "182-corner-stay", { cursor: 1, items: { 1: { state: "working", note: "재현 중", at: T } } }, T);
    const ack = readAck(home, "182-corner-stay");
    expect(ack.cursor).toBe(1);
    expect(ack.items["1"].state).toBe("working");
    expect(ack.updatedAt).toBe(T);
  });

  it("커서는 뒤로 가지 않는다 — 재시작한 세션이 이미 처리한 것을 다시 받지 않게", () => {
    writeTab(home, buildTab(input()));
    writeAck(home, "182-corner-stay", { cursor: 3, items: {} }, T);
    writeAck(home, "182-corner-stay", { cursor: 1, items: {} }, T);
    expect(readAck(home, "182-corner-stay").cursor).toBe(3);
  });
});

describe("콘솔 목록 뷰", () => {
  const T0 = Date.parse("2026-07-26T04:00:00.000Z");
  const H = 3600_000;

  it("미확인 수를 센다", () => {
    const tab = buildTab(input());
    writeTab(home, tab);
    appendFeedback(home, tab.tabId, { verdict: "comment", body: "x", now: "2026-07-26T04:10:00.000Z" });
    const v = tabView(home, tab.tabId, T0 + H);
    expect(v.unread).toBe(1);
  });

  it("갱신이 오래 멈췄고 미수신 피드백이 남았으면 stale — 세션이 죽은 신호", () => {
    const tab = mergeTab(buildTab(input()), { status: "waiting" }, "2026-07-26T04:00:00.000Z");
    writeTab(home, tab);
    appendFeedback(home, tab.tabId, { verdict: "comment", body: "x", now: "2026-07-26T04:05:00.000Z" });
    expect(tabView(home, tab.tabId, T0 + 2 * H).stale).toBe(false); // 아직 2시간
    expect(tabView(home, tab.tabId, T0 + 7 * H).stale).toBe(true); // 6시간 초과
  });

  it("피드백을 세션이 다 받았으면 오래돼도 stale 아니다 — 기다리는 쪽이 hero 인 정상 상태", () => {
    const tab = mergeTab(buildTab(input()), { status: "waiting" }, "2026-07-26T04:00:00.000Z");
    writeTab(home, tab);
    expect(tabView(home, tab.tabId, T0 + 99 * H).stale).toBe(false);
  });

  it("resolved 는 stale 로 표시하지 않는다", () => {
    const tab = mergeTab(buildTab(input()), { status: "resolved" }, "2026-07-26T04:00:00.000Z");
    writeTab(home, tab);
    appendFeedback(home, tab.tabId, { verdict: "comment", body: "x", now: "2026-07-26T04:05:00.000Z" });
    expect(tabView(home, tab.tabId, T0 + 99 * H).stale).toBe(false);
  });
});

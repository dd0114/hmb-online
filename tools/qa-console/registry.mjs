// QA 콘솔 레지스트리 코어 (#191). 파일 레이아웃과 스키마의 SoT.
//
// 설계 근거는 docs/plan-v5/qa-console.md §3. 요약:
//  · 라이브 전송 = **파일시스템 한 경로**(16 체크아웃이 같은 파일을 본다). git 은 기록 계층.
//  · **파일별 writer 를 하나로 못 박는다** — tabs=세션 / feedback=콘솔서버 / acks=세션.
//    두 프로세스가 같은 파일을 쓰는 경우가 설계상 없으므로 락 없이 동시 다중탭이 성립한다(AC4).
//  · 시각은 **주입**한다(now 인자). 순수성 유지 + 테스트가 시계에 흔들리지 않는다.
//
// 여기엔 npm 의존성이 없다(node 표준만) — 세션이 어느 체크아웃에서든 `node tools/qa-tab.mjs` 로 바로 쓴다.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";

/** 레코드 스키마 버전 — 형태가 바뀌면 올린다(마이그레이션 기준). */
export const SCHEMA_VERSION = 1;

/**
 * QA 콘솔 관리버전. hero 확정 계약: **QA 버전 ≥ main 버전**이 항상 성립하고,
 * "이 버전 올린다"고 명시할 때 main 이 흡수한다. 모든 레코드에 producer 로 박혀
 * QA 버전이 올라가도 구버전 기록을 읽을 수 있다.
 */
export const QA_CONSOLE_VERSION = "qaConsole@0.1.0";

/** 탭 상태 — 세션이 갱신한다. */
export const TAB_STATUS = ["draft", "waiting", "acked", "resolved"];

/** 피드백 태그. 기본은 comment(=그냥 전달). approve/reject 는 진행/재작업 갈림길만 확정하는 얇은 규약(D9). */
export const VERDICTS = ["comment", "approve", "reject"];

/** 갱신 없이 이 시간을 넘기고 **미수신 피드백이 남아 있으면** stale = 세션이 죽었다는 신호. */
export const STALE_AFTER_MS = 6 * 3600_000;

// ── 경로 ─────────────────────────────────────────────────────────────────

/**
 * 레지스트리 루트. `$HMB_QA_CONSOLE_HOME`(테스트·격리) → `~/hmb-qa-console`(기본).
 * 기본 경로는 **브랜치를 바꾸지 않는 고정 위치**여야 한다 — 워킹트리 안에 두면
 * `git checkout` 한 번에 살아있는 탭·피드백이 디스크에서 사라진다(§3.1 조건 3).
 */
export function registryHome(env = process.env) {
  const override = env.HMB_QA_CONSOLE_HOME;
  return override && override.trim() !== "" ? resolve(override) : join(homedir(), "hmb-qa-console");
}

export const tabsDir = (home) => join(home, "tabs");
export const feedbackDir = (home) => join(home, "feedback");
export const acksDir = (home) => join(home, "acks");
export const tabPath = (home, id) => join(tabsDir(home), `${id}.json`);
export const feedbackPath = (home, id) => join(feedbackDir(home), `${id}.jsonl`);
export const ackPath = (home, id) => join(acksDir(home), `${id}.json`);

/** 디렉토리 준비(+ 런타임 산출물 gitignore). 여러 번 불러도 안전. */
export function ensureHome(home) {
  for (const d of [tabsDir(home), feedbackDir(home), acksDir(home)]) mkdirSync(d, { recursive: true });
  const ignore = join(home, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "console.pid\nconsole.log\n*.tmp\n");
  return home;
}

// ── 원자적 쓰기 ───────────────────────────────────────────────────────────

/**
 * tmp+rename. 읽는 쪽(콘솔 API 는 2초마다 전체를 읽는다)이 **반쯤 쓰인 JSON** 을 보지 않게 한다.
 * pid 를 tmp 이름에 넣어 두 프로세스가 같은 tmp 를 밟지 않는다.
 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // 없거나 손상 — 호출부가 판단(목록은 그 항목만 건너뛴다)
  }
}

// ── 탭 id ────────────────────────────────────────────────────────────────

const TAB_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 탭 id 검증. **id 가 곧 파일명**이라 여기서 막지 못하면 경로 탈출이 곧 임의 파일 쓰기다.
 * 허용: 소문자·숫자 토큰을 `-` 로 이은 형태(`182-corner-stay`). 그 외 전부 거부.
 */
export function normalizeTabId(raw) {
  const id = String(raw ?? "").trim();
  if (!TAB_ID_RE.test(id)) {
    throw new Error(`탭 id 형식이 아니다: "${raw}" (소문자·숫자·하이픈만, 예: 182-corner-stay)`);
  }
  return id;
}

// ── 인자 파싱(CLI 표면) ───────────────────────────────────────────────────

/**
 * `mm:ss` → 틱(=게임초). apps/web `qa-time-controls.ts:parseClockInput` 과 **같은 계약**을 mjs 로 미러한다
 * (런타임이 달라 import 할 수 없다 — 그래서 계약을 테스트로 양쪽에 박는다).
 * 받는 형태: `12:34` · `12'34"` · `12 34` · `1:2` · `754`(초만). 해석 불가면 null.
 */
export function parseClock(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const m = s.match(/^(\d+)\s*[:'’\s]\s*(\d{1,2})"?$/);
  if (m) {
    const sec = Number(m[2]);
    if (sec > 59) return null;
    return Number(m[1]) * 60 + sec;
  }
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

/** 틱 → 사람이 읽는 시계 표기(`12'34"`). 피드백에 같이 저장해 세션 로그·이슈 인용에 쓴다. */
export function formatClock(tick) {
  const t = Math.max(0, Math.round(Number(tick) || 0));
  return `${Math.floor(t / 60)}'${String(t % 60).padStart(2, "0")}"`;
}

/**
 * 확인 포인트 인자 → `{tick, view?, label}`.
 *   "12:34 첫 코너 — 잔류 확인"   → tick 754, label "첫 코너 — 잔류 확인"
 *   "12:34@before 같은 장면"      → 그 뷰로 전환해서 볼 포인트
 *   "경기 전체 인상"               → tick null(설명용 포인트도 허용)
 */
export function parsePointArg(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^([\d:'’\s"]+?)(?:@([a-z0-9-]+))?\s+(.*)$/);
  if (m) {
    const tick = parseClock(m[1]);
    if (tick != null) {
      const out = { tick, label: m[3].trim() };
      if (m[2]) out.view = m[2];
      return out;
    }
  }
  return { tick: null, label: s };
}

/**
 * 로그 인자 → 뷰. `<경로>[@<id>[:<라벨>]]`.
 * 경로는 `baseDir`(세션 cwd) 기준으로 절대화한다 — 세션이 자기 체크아웃에서 상대경로로 그냥 치게.
 * 경로에 `@` 가 들어갈 수 있으니 **마지막 `@`** 를 구분자로 본다.
 */
export function parseLogArg(raw, baseDir) {
  const s = String(raw ?? "").trim();
  if (s === "") throw new Error("--log 가 비었다");
  const at = s.lastIndexOf("@");
  let pathPart = s;
  let idPart = "";
  if (at > 0) {
    pathPart = s.slice(0, at);
    idPart = s.slice(at + 1);
  }
  const colon = idPart.indexOf(":");
  const id = (colon === -1 ? idPart : idPart.slice(0, colon)).trim();
  const label = (colon === -1 ? "" : idPart.slice(colon + 1)).trim();
  const logPath = isAbsolute(pathPart) ? resolve(pathPart) : resolve(baseDir, pathPart);
  const fallbackId = basename(logPath, extname(logPath));
  const viewId = id || fallbackId;
  return { id: viewId, label: label || viewId, logPath };
}

// ── 로그 경로 allowlist ───────────────────────────────────────────────────

/**
 * 기본 허용 루트: 이 머신의 hmb 체크아웃들(홈 아래) + 임시 디렉토리(세션 스크래치패드·E2E 격리).
 * `$HMB_QA_LOG_ROOTS`(`:` 구분)로 추가한다.
 * macOS 의 `tmpdir()` 은 `/var/folders/...` 라 `/tmp` 만으로는 안 걸린다 → 둘 다 넣는다.
 */
export function defaultLogRoots(env = process.env, home = homedir()) {
  const extra = (env.HMB_QA_LOG_ROOTS ?? "").split(":").filter((p) => p.trim() !== "");
  return [home, tmpdir(), "/private/tmp", "/tmp", ...extra];
}

/**
 * 콘솔이 파일을 읽어 서빙하므로 **경로를 반드시 좁힌다**.
 *  · realpath 로 정규화 후 루트 안인지 본다(`..`·심링크 탈출은 문자열 접두 비교로는 못 잡는다)
 *  · 정규 파일 + `.json` 만(콘솔이 서빙하는 것은 match-log 뿐)
 */
export function logPathAllowed(candidate, roots = defaultLogRoots()) {
  let real;
  try {
    real = realpathSync(resolve(candidate));
    if (!statSync(real).isFile()) return false;
  } catch {
    return false; // 없는 파일은 허용하지 않는다
  }
  if (extname(real).toLowerCase() !== ".json") return false;
  return roots.some((root) => {
    let r;
    try {
      r = realpathSync(resolve(root));
    } catch {
      return false;
    }
    return real === r || real.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

// ── 탭 ───────────────────────────────────────────────────────────────────

const TAB_PATCHABLE = [
  "issue", "title", "session", "checkout", "branch", "status", "summary", "ask", "views", "watch",
];

/**
 * 탭 레코드 생성. **등록 시점에 뷰 로그의 존재를 검증**한다 — 안 하면 hero 가 빈 화면을 보고
 * "왜 안 나오지"로 시간을 태운다. 실패는 세션 쪽에서 즉시 드러나는 게 옳다.
 */
export function buildTab(input) {
  const tabId = normalizeTabId(input.tabId);
  const now = input.now ?? new Date().toISOString();
  const views = normalizeViews(input.views, input.logRoots);
  const watch = normalizeWatch(input.watch, views);
  const status = input.status ?? "draft";
  if (!TAB_STATUS.includes(status)) throw new Error(`status 가 ${TAB_STATUS.join("|")} 중 하나여야 한다: ${status}`);
  return {
    schemaVersion: SCHEMA_VERSION,
    producer: QA_CONSOLE_VERSION,
    tabId,
    issue: input.issue == null ? null : Number(input.issue),
    title: String(input.title ?? "").trim() || tabId,
    session: input.session ?? null,
    checkout: input.checkout ?? null,
    branch: input.branch ?? null,
    status,
    summary: input.summary ?? "",
    ask: input.ask ?? "",
    views,
    watch,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeViews(views, logRoots) {
  const list = Array.isArray(views) ? views : [];
  if (list.length === 0) throw new Error("관전 대상(--log)이 최소 하나 필요하다");
  const seen = new Set();
  return list.map((v) => {
    const id = normalizeTabId(v.id); // 뷰 id 도 같은 규칙(URL·파일명에 실린다)
    if (seen.has(id)) throw new Error(`뷰 id 중복: ${id}`);
    seen.add(id);
    const logPath = resolve(v.logPath ?? "");
    if (!existsSync(logPath)) throw new Error(`match-log 이 없다: ${logPath}`);
    if (!logPathAllowed(logPath, logRoots ?? defaultLogRoots())) {
      throw new Error(`허용된 경로 밖이거나 .json 이 아니다: ${logPath}`);
    }
    return { id, label: String(v.label ?? id), logPath };
  });
}

function normalizeWatch(watch, views) {
  const ids = new Set(views.map((v) => v.id));
  return (Array.isArray(watch) ? watch : []).map((w) => {
    const out = { tick: w.tick == null ? null : Math.max(0, Math.round(Number(w.tick))), label: String(w.label ?? "") };
    if (w.view != null) {
      if (!ids.has(w.view)) throw new Error(`확인 포인트가 없는 뷰를 가리킨다: ${w.view}`);
      out.view = w.view;
    }
    return out;
  });
}

/** 부분 갱신 — 준 필드만 반영. tabId·createdAt·producer 는 정체성이라 고정. */
export function mergeTab(existing, patch, now = new Date().toISOString()) {
  const next = { ...existing };
  for (const key of TAB_PATCHABLE) {
    if (patch[key] === undefined) continue;
    next[key] = patch[key];
  }
  if (patch.views !== undefined) next.views = normalizeViews(patch.views, patch.logRoots);
  if (patch.watch !== undefined || patch.views !== undefined) {
    next.watch = normalizeWatch(patch.watch ?? next.watch, next.views);
  }
  if (next.status != null && !TAB_STATUS.includes(next.status)) {
    throw new Error(`status 가 ${TAB_STATUS.join("|")} 중 하나여야 한다: ${next.status}`);
  }
  next.tabId = existing.tabId;
  next.createdAt = existing.createdAt;
  next.schemaVersion = SCHEMA_VERSION;
  next.producer = QA_CONSOLE_VERSION;
  next.updatedAt = now;
  return next;
}

export function writeTab(home, tab) {
  ensureHome(home);
  writeJsonAtomic(tabPath(home, normalizeTabId(tab.tabId)), tab);
  return tab;
}

export function readTab(home, id) {
  return readJson(tabPath(home, normalizeTabId(id)));
}

/** 목록. 손상된 파일 하나가 전체를 죽이지 않게 조용히 건너뛴다(콘솔이 안 뜨는 것보다 낫다). */
export function listTabs(home) {
  let names;
  try {
    names = readdirSync(tabsDir(home));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const tab = readJson(join(tabsDir(home), name));
    if (tab && typeof tab.tabId === "string") out.push(tab);
  }
  return out;
}

/** 탭·피드백·ack 을 함께 지운다(반쪽 삭제가 남아 유령 미확인 수를 만들지 않게). */
export function removeTab(home, id) {
  const tabId = normalizeTabId(id);
  for (const f of [tabPath(home, tabId), feedbackPath(home, tabId), ackPath(home, tabId)]) {
    rmSync(f, { force: true });
  }
  return tabId;
}

// ── 피드백 ───────────────────────────────────────────────────────────────

/**
 * 피드백 1건 append. writer 는 **콘솔 서버 하나**라 경합이 없고, O_APPEND 한 줄 쓰기라 부분 기록도 없다.
 * `body` 는 손대지 않는다 — 이 문장이 그대로 세션 프롬프트가 된다(D9).
 */
export function appendFeedback(home, id, entry) {
  const tabId = normalizeTabId(id);
  if (!existsSync(tabPath(home, tabId))) throw new Error(`없는 탭이다: ${tabId}`);
  const verdict = entry.verdict ?? "comment";
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict 가 ${VERDICTS.join("|")} 중 하나여야 한다: ${verdict}`);
  const body = String(entry.body ?? "");
  // 거부만 사유 필수 — 사유 없는 거부는 세션이 무엇을 고쳐야 할지 모른다. 승인/전달은 태그만으로도 유효.
  if (verdict === "reject" && body.trim() === "") throw new Error("거부에는 사유가 필요하다(세션이 뭘 할지 모른다)");
  const prev = readFeedback(home, tabId);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    producer: QA_CONSOLE_VERSION,
    seq: prev.length + 1,
    at: entry.now ?? new Date().toISOString(),
    verdict,
    body,
  };
  if (entry.view != null) record.view = String(entry.view);
  if (entry.tick != null && Number.isFinite(Number(entry.tick))) {
    record.tick = Math.max(0, Math.round(Number(entry.tick)));
    record.clock = formatClock(record.tick);
  }
  mkdirSync(feedbackDir(home), { recursive: true });
  // JSON.stringify 가 개행을 \n 으로 이스케이프하므로 여러 줄 본문도 한 줄 = 한 레코드로 남는다.
  appendFileSync(feedbackPath(home, tabId), `${JSON.stringify(record)}\n`);
  return record;
}

export function readFeedback(home, id) {
  const file = feedbackPath(home, normalizeTabId(id));
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 깨진 줄은 건너뛴다 — 뒤 이력을 잃는 게 더 손해다
    }
  }
  return out;
}

// ── ack ──────────────────────────────────────────────────────────────────

const EMPTY_ACK = { cursor: 0, items: {}, updatedAt: null };

export function readAck(home, id) {
  const ack = readJson(ackPath(home, normalizeTabId(id)));
  if (!ack) return { ...EMPTY_ACK, items: {} };
  return {
    cursor: Number(ack.cursor) || 0,
    items: ack.items && typeof ack.items === "object" ? ack.items : {},
    updatedAt: ack.updatedAt ?? null,
  };
}

/**
 * ack 저장. **커서는 뒤로 가지 않는다** — 재시작한 세션이 `--since` 를 잘못 줘도
 * 이미 처리한 피드백을 다시 받아 같은 작업을 반복하지 않게 한다.
 */
export function writeAck(home, id, next, now = new Date().toISOString()) {
  const tabId = normalizeTabId(id);
  ensureHome(home);
  const prev = readAck(home, tabId);
  const merged = {
    schemaVersion: SCHEMA_VERSION,
    producer: QA_CONSOLE_VERSION,
    cursor: Math.max(prev.cursor, Number(next.cursor) || 0),
    items: { ...prev.items, ...(next.items ?? {}) },
    updatedAt: now,
  };
  writeJsonAtomic(ackPath(home, tabId), merged);
  return merged;
}

/** 세션이 아직 안 받은 피드백. */
export function unreadFeedback(feedback, ack) {
  const cursor = Number(ack?.cursor) || 0;
  return feedback.filter((f) => Number(f.seq) > cursor);
}

// ── 콘솔 목록 뷰 ──────────────────────────────────────────────────────────

/**
 * 콘솔이 좌측 목록을 그릴 때 쓰는 파생값. `nowMs` 주입(순수).
 *
 * stale 판정 = "갱신이 오래 멈췄고 **미수신 피드백이 남아 있다**". 미수신이 없으면 기다리는 쪽이
 * hero 인 정상 상태라 오래돼도 stale 이 아니다 — 이 구분이 없으면 배지가 상시 노랗게 떠서 무의미해진다.
 */
export function tabView(home, id, nowMs = Date.now()) {
  const tab = readTab(home, id);
  if (!tab) return null;
  const feedback = readFeedback(home, id);
  const ack = readAck(home, id);
  const unread = unreadFeedback(feedback, ack);
  const updatedMs = Date.parse(tab.updatedAt ?? tab.createdAt ?? "") || 0;
  const idleMs = Math.max(0, nowMs - updatedMs);
  return {
    tab,
    feedbackCount: feedback.length,
    unread: unread.length,
    lastFeedbackAt: feedback.length ? feedback[feedback.length - 1].at : null,
    ackCursor: ack.cursor,
    ackItems: ack.items,
    idleMs,
    stale: tab.status !== "resolved" && unread.length > 0 && idleMs > STALE_AFTER_MS,
  };
}

/** 목록 전체(콘솔 `GET /qa-api/tabs`). 최근 갱신 우선. */
export function listTabViews(home, nowMs = Date.now()) {
  return listTabs(home)
    .map((t) => tabView(home, t.tabId, nowMs))
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.tab.updatedAt ?? 0) - Date.parse(a.tab.updatedAt ?? 0));
}

#!/usr/bin/env node
// qa-tab — QA 콘솔 탭 CLI (#191). **다른 세션이 쓰는 표면**이므로 여기가 문서이자 계약이다.
//
// 사용법은 `node tools/qa-tab.mjs help`. 레시피는 docs/plan-v5/qa-console-playbook.md.
// 레지스트리 위치·스키마 근거는 docs/plan-v5/qa-console.md §3.
//
// 규약(hero 확정):
//  · 탭은 **hero 가 요청하거나 컨펌했을 때만** 만든다(자율 생성 금지, D10).
//  · hero 가 적은 문장은 **그대로 세션 프롬프트**다. 태그(승인/거부)는 진행/재작업 갈림길만 확정한다(D9).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  QA_CONSOLE_VERSION,
  TAB_STATUS,
  VERDICTS,
  buildTab,
  ensureHome,
  feedbackPath,
  formatClock,
  listTabViews,
  mergeTab,
  normalizeTabId,
  parseLogArg,
  parsePointArg,
  readAck,
  readFeedback,
  readTab,
  registryHome,
  removeTab,
  tabView,
  unreadFeedback,
  writeAck,
  writeTab,
} from "./qa-console/registry.mjs";
import { commitRegistry, ensureGitRepo, syncRegistry, tabHistory } from "./qa-console/git.mjs";
import { pendingFeedback, waitForFeedback } from "./qa-console/wait.mjs";

const EXIT = { ok: 0, usage: 2, timeout: 3, missing: 4, gone: 5 };

// ── 인자 파싱 ─────────────────────────────────────────────────────────────

/** `--key value` / `--flag` / 반복 가능한 키(`--log`, `--point`)를 배열로 모은다. */
function parseArgs(argv) {
  const out = { _: [], repeated: { log: [], point: [] } };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next != null && !next.startsWith("--") ? (i++, next) : true;
    if (key === "log" || key === "point") out.repeated[key].push(String(value));
    else out[key] = value;
  }
  return out;
}

function die(msg, code = EXIT.usage) {
  process.stderr.write(`[qa-tab] ${msg}\n`);
  process.exit(code);
}

function nowIso() {
  return new Date().toISOString();
}

/** `--summary "..."` 또는 `--summary-file path` 중 준 것을 읽는다(파일이 긴 설명에 편하다). */
function textArg(args, key) {
  if (args[key] != null && args[key] !== true) return String(args[key]);
  const file = args[`${key}-file`];
  if (file != null && file !== true) {
    const p = resolve(String(file));
    if (!existsSync(p)) die(`${key}-file 이 없다: ${p}`);
    return readFileSync(p, "utf8").trim();
  }
  return undefined;
}

/** 세션이 안 알려줘도 자기 체크아웃·브랜치·세션 라벨을 최대한 자동으로 채운다(타이핑 줄이기). */
function detectContext(cwd) {
  const git = (as) => {
    const r = spawnSync("git", ["-C", cwd, ...as], { encoding: "utf8" });
    return r.status === 0 ? (r.stdout ?? "").trim() : null;
  };
  return {
    checkout: git(["rev-parse", "--show-toplevel"]) ?? cwd,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    session: process.env.HMB_SESSION ?? process.env.TMUX_PANE_SESSION ?? null,
  };
}

function consoleUrl(tabId) {
  const port = process.env.HMB_QA_CONSOLE_PORT ?? "8300";
  return `http://127.0.0.1:${port}/qa/console?tab=${tabId}`;
}

/** 레지스트리 변경을 git 에 남긴다. 실패는 경고만 — 왕복을 막지 않는다(§git.mjs). */
function record(home, message) {
  ensureGitRepo(home);
  const res = commitRegistry(home, message);
  if (!res.ok && res.reason) process.stderr.write(`[qa-tab] git 기록 생략: ${res.reason}\n`);
}

// ── 동사 ─────────────────────────────────────────────────────────────────

function cmdRegister(args, home) {
  const id = normalizeTabId(args.id ?? die("--id 가 필요하다(예: --id 182-corner-stay)"));
  if (readTab(home, id) && !args.force) {
    die(`이미 있는 탭이다: ${id} (갱신은 update, 덮어쓰기는 --force)`);
  }
  if (args.log === undefined && args.repeated.log.length === 0) {
    die("--log <match-log 경로>[@id:라벨] 이 최소 하나 필요하다 — 볼 게 없는 탭은 목적 미달");
  }
  const ctx = detectContext(process.cwd());
  const views = args.repeated.log.map((raw) => parseLogArg(raw, process.cwd()));
  const watch = args.repeated.point.map((raw) => parsePointArg(raw));
  let tab;
  try {
    tab = buildTab({
      tabId: id,
      issue: args.issue,
      title: textArg(args, "title") ?? id,
      session: args.session ?? ctx.session,
      checkout: args.checkout ?? ctx.checkout,
      branch: args.branch ?? ctx.branch,
      status: args.status ?? "draft",
      summary: textArg(args, "summary") ?? "",
      ask: textArg(args, "ask") ?? "",
      views,
      watch,
      now: nowIso(),
    });
  } catch (e) {
    die(String(e.message ?? e));
  }
  writeTab(home, tab);
  record(home, `qa(${id}): register — ${tab.title}`);
  process.stdout.write(`${consoleUrl(id)}\n`);
  process.stderr.write(
    `[qa-tab] 탭 등록: ${id} · 뷰 ${tab.views.length} · 확인포인트 ${tab.watch.length}\n` +
      `[qa-tab] hero 에게 이 URL 한 줄을 알린다. 다음: status --set waiting → wait\n`,
  );
}

function cmdUpdate(args, home) {
  const id = normalizeTabId(args.id ?? die("--id 가 필요하다"));
  const tab = readTab(home, id) ?? die(`없는 탭이다: ${id}`, EXIT.missing);
  const patch = {};
  for (const key of ["title", "summary", "ask"]) {
    const v = textArg(args, key);
    if (v !== undefined) patch[key] = v;
  }
  for (const key of ["issue", "session", "checkout", "branch", "status"]) {
    if (args[key] !== undefined && args[key] !== true) patch[key] = args[key];
  }
  if (args.repeated.log.length > 0) patch.views = args.repeated.log.map((raw) => parseLogArg(raw, process.cwd()));
  if (args.repeated.point.length > 0) patch.watch = args.repeated.point.map((raw) => parsePointArg(raw));
  if (Object.keys(patch).length === 0) die("바꿀 것을 하나는 줘라(--title/--summary/--ask/--log/--point/--status …)");
  let next;
  try {
    next = mergeTab(tab, patch, nowIso());
  } catch (e) {
    die(String(e.message ?? e));
  }
  writeTab(home, next);
  record(home, `qa(${id}): update — ${Object.keys(patch).join(",")}`);
  process.stderr.write(`[qa-tab] 갱신: ${id} (${Object.keys(patch).join(", ")})\n`);
}

function cmdStatus(args, home) {
  const id = normalizeTabId(args.id ?? die("--id 가 필요하다"));
  const set = String(args.set ?? "");
  if (!TAB_STATUS.includes(set)) die(`--set 은 ${TAB_STATUS.join("|")} 중 하나여야 한다`);
  const tab = readTab(home, id) ?? die(`없는 탭이다: ${id}`, EXIT.missing);
  writeTab(home, mergeTab(tab, { status: set }, nowIso()));
  record(home, `qa(${id}): status → ${set}`);
  process.stderr.write(`[qa-tab] ${id} 상태 = ${set}\n`);
  if (set === "resolved") {
    const s = syncRegistry(home);
    process.stderr.write(`[qa-tab] ${s.ok ? `원격 동기화 완료(${s.remote}/${s.branch})` : `동기화 생략: ${s.reason}`}\n`);
  }
}

function cmdList(args, home) {
  const views = listTabViews(home, Date.now()).filter(
    (v) => !args.mine || v.tab.checkout === detectContext(process.cwd()).checkout,
  );
  if (args.json) {
    process.stdout.write(`${JSON.stringify(views, null, 2)}\n`);
    return;
  }
  if (views.length === 0) {
    process.stdout.write("탭 없음\n");
    return;
  }
  for (const v of views) {
    const flags = [v.stale ? "stale" : null, v.unread ? `미수신 ${v.unread}` : null].filter(Boolean).join(" · ");
    process.stdout.write(
      `${v.tab.status.padEnd(8)} ${String(v.tab.tabId).padEnd(26)} #${v.tab.issue ?? "-"} ${v.tab.title}` +
        `${flags ? `  [${flags}]` : ""}\n`,
    );
  }
}

function cmdShow(args, home) {
  const id = normalizeTabId(args.id ?? die("--id 가 필요하다"));
  const v = tabView(home, id, Date.now()) ?? die(`없는 탭이다: ${id}`, EXIT.missing);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
    return;
  }
  const t = v.tab;
  const lines = [
    `#${t.issue ?? "-"} ${t.title}   [${t.status}${v.stale ? " · stale" : ""}]`,
    `  탭 ${t.tabId} · 세션 ${t.session ?? "-"} · ${t.branch ?? "-"} · ${t.checkout ?? "-"}`,
    `  URL ${consoleUrl(t.tabId)}`,
    `  무엇을 고쳤나: ${t.summary || "-"}`,
    `  봐줄 것: ${t.ask || "-"}`,
    `  뷰: ${t.views.map((x) => `${x.id}(${basename(x.logPath)})`).join(" ")}`,
    `  확인 포인트: ${t.watch.length ? t.watch.map((w) => `${w.tick == null ? "-" : formatClock(w.tick)} ${w.label}`).join(" | ") : "-"}`,
    `  피드백 ${v.feedbackCount}건 · 미수신 ${v.unread}건 (ack 커서 ${v.ackCursor})`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdFeedback(args, home) {
  const id = normalizeTabId(args.id ?? die("--id 가 필요하다"));
  if (!readTab(home, id)) die(`없는 탭이다: ${id}`, EXIT.missing);
  const all = readFeedback(home, id);
  const items = args.unread ? unreadFeedback(all, readAck(home, id)) : all;
  if (args.json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }
  if (items.length === 0) {
    process.stdout.write(`${args.unread ? "미수신 피드백 없음" : "피드백 없음"}\n`);
    return;
  }
  const ack = readAck(home, id);
  for (const f of items) {
    const st = ack.items?.[String(f.seq)]?.state;
    const where = f.clock ? ` @${f.view ?? "-"} ${f.clock}` : "";
    process.stdout.write(`#${f.seq} [${f.verdict}]${where} ${f.body}${st ? `  (${st})` : ""}\n`);
  }
}

function cmdAck(args, home) {
  const id = normalizeTabId(args.id ?? die("--id 가 필요하다"));
  if (!readTab(home, id)) die(`없는 탭이다: ${id}`, EXIT.missing);
  const all = readFeedback(home, id);
  // --seq 를 안 주면 "지금까지 온 것 전부 받았다"로 본다(가장 흔한 경우).
  const seq = args.seq != null && args.seq !== true ? Number(args.seq) : all.length;
  if (!Number.isFinite(seq) || seq < 0) die("--seq 는 0 이상 정수");
  const state = String(args.state ?? "received");
  if (!["received", "working", "done", "skipped"].includes(state)) {
    die("--state 는 received|working|done|skipped");
  }
  const items = {};
  if (seq > 0) items[String(seq)] = { state, note: args.note === true ? null : (args.note ?? null), at: nowIso() };
  const next = writeAck(home, id, { cursor: seq, items }, nowIso());
  record(home, `qa(${id}): ack #${seq} ${state}`);
  process.stderr.write(`[qa-tab] ack: ${id} 커서 ${next.cursor} · #${seq} = ${state}\n`);
}

async function cmdWait(args, home) {
  const id = normalizeTabId(args.id ?? die("--id 가 필요하다"));
  const timeoutMs = (args.timeout != null && args.timeout !== true ? Number(args.timeout) : 900) * 1000;
  const since = args.since != null && args.since !== true ? Number(args.since) : null;
  let res;
  try {
    res = await waitForFeedback({ home, tabId: id, since, timeoutMs, pollMs: 1000 });
  } catch (e) {
    die(String(e.message ?? e), EXIT.missing);
  }
  if (res.status === "timeout") {
    process.stderr.write(`[qa-tab] 대기 시간 초과 — 다시 걸면 이어서 기다린다\n`);
    process.exit(EXIT.timeout);
  }
  if (res.status === "gone") {
    process.stderr.write(`[qa-tab] 탭이 사라졌다: ${id}\n`);
    process.exit(EXIT.gone);
  }
  // 세션이 그대로 읽고 지시로 삼는 형태 — body 가 프롬프트다(D9).
  process.stdout.write(`${JSON.stringify({ tabId: id, items: res.items }, null, 2)}\n`);
  const first = res.items[0];
  process.stderr.write(
    `[qa-tab] 피드백 ${res.items.length}건 도착. 첫 건 [${first.verdict}] ${first.clock ?? ""} ${first.body}\n` +
      `[qa-tab] 처리 후 ack --id ${id} --seq ${res.items[res.items.length - 1].seq} --state working|done\n`,
  );
}

function cmdRemove(args, home) {
  const id = normalizeTabId(args.id ?? die("--id 가 필요하다"));
  if (!readTab(home, id)) die(`없는 탭이다: ${id}`, EXIT.missing);
  removeTab(home, id);
  record(home, `qa(${id}): remove`);
  process.stderr.write(`[qa-tab] 삭제: ${id} (git 이력에는 남는다)\n`);
}

/**
 * 픽스 PR 에 QA 근거를 같이 싣는다(§3.1 추가). 세션 **자기 체크아웃**에 마크다운으로 쓴다 →
 * 그 픽스의 QA 왕복이 main 히스토리에도 남는다.
 */
function cmdExport(args, home) {
  const id = normalizeTabId(args.id ?? die("--id 가 필요하다"));
  const v = tabView(home, id, Date.now()) ?? die(`없는 탭이다: ${id}`, EXIT.missing);
  const t = v.tab;
  const fb = readFeedback(home, id);
  const ack = readAck(home, id);
  const out =
    args.out != null && args.out !== true
      ? resolve(String(args.out))
      : resolve(process.cwd(), "issues", `qa-${id}.md`);
  mkdirSync(join(out, ".."), { recursive: true });
  const body = [
    `# QA 콘솔 기록 — ${t.title}`,
    "",
    `- 탭 \`${t.tabId}\` · 이슈 #${t.issue ?? "-"} · 세션 \`${t.session ?? "-"}\` · 브랜치 \`${t.branch ?? "-"}\``,
    `- 상태 ${t.status} · 등록 ${t.createdAt} · 갱신 ${t.updatedAt}`,
    `- producer ${t.producer}`,
    "",
    "## 무엇을 고쳤나",
    "",
    t.summary || "-",
    "",
    "## 봐줄 것으로 요청한 것",
    "",
    t.ask || "-",
    "",
    "## 확인 포인트",
    "",
    ...(t.watch.length
      ? t.watch.map((w) => `- ${w.tick == null ? "(시점 없음)" : formatClock(w.tick)} ${w.label}${w.view ? ` [${w.view}]` : ""}`)
      : ["- 없음"]),
    "",
    "## hero 피드백 왕복",
    "",
    ...(fb.length
      ? fb.flatMap((f) => {
          const st = ack.items?.[String(f.seq)];
          return [
            `### #${f.seq} ${f.verdict}${f.clock ? ` @${f.view ?? "-"} ${f.clock}` : ""} — ${f.at}`,
            "",
            f.body || "(내용 없음)",
            "",
            st ? `> 세션 처리: ${st.state}${st.note ? ` — ${st.note}` : ""}` : "> 세션 미수신",
            "",
          ];
        })
      : ["없음", ""]),
  ].join("\n");
  writeFileSync(out, `${body}\n`);
  process.stdout.write(`${out}\n`);
  process.stderr.write(`[qa-tab] 내보냄: ${out} — 픽스 커밋에 같이 실어라\n`);
}

function cmdHistory(args, home) {
  const id = normalizeTabId(args.id ?? die("--id 가 필요하다"));
  const rel = `feedback/${id}.jsonl`;
  const log = tabHistory(home, rel, args.limit != null && args.limit !== true ? Number(args.limit) : 50);
  if (log.length === 0) {
    process.stdout.write("git 이력 없음(레지스트리가 git 리포가 아니거나 아직 커밋이 없다)\n");
    return;
  }
  for (const c of log) process.stdout.write(`${c.hash}  ${c.date}  ${c.subject}\n`);
}

function cmdSync(args, home) {
  ensureGitRepo(home);
  commitRegistry(home, "qa: sync");
  const res = syncRegistry(home, { remote: args.remote === true ? undefined : args.remote, branch: args.branch === true ? null : args.branch });
  process.stdout.write(res.ok ? `pushed → ${res.remote}/${res.branch}\n` : `동기화 안 됨: ${res.reason}\n`);
}

function cmdHelp() {
  process.stdout.write(
    `qa-tab (${QA_CONSOLE_VERSION}) — QA 콘솔 탭 CLI

레지스트리: ${registryHome()}   (HMB_QA_CONSOLE_HOME 로 변경)
콘솔:       http://127.0.0.1:${process.env.HMB_QA_CONSOLE_PORT ?? "8300"}/qa/console

  register  --id <이슈-슬러그> [--issue N] --title "…" [--summary|--summary-file] [--ask "…"]
            --log <경로>[@id:라벨] (반복)  [--point "12:34 라벨" | "12:34@뷰id 라벨"] (반복) [--force]
  update    --id … [위 필드 중 바꿀 것만]
  status    --id … --set ${TAB_STATUS.join("|")}
  list      [--json] [--mine]
  show      --id … [--json]
  feedback  --id … [--unread] [--json]
  ack       --id … [--seq N] [--state received|working|done|skipped] [--note "…"]
  wait      --id … [--timeout 초=900] [--since N]     # 백그라운드로 걸어라(도착=종료=세션 재진입)
  remove    --id …
  export    --id … [--out 경로]      # issues/qa-<id>.md — 픽스 PR 에 QA 근거를 같이 싣는다
  history   --id … [--limit N]       # 그 탭의 git 이력
  sync      [--remote origin] [--branch …]

규약: 탭은 hero 요청/컨펌 후에만 만든다. 피드백 body 는 그대로 지시로 받는다.
      태그 approve = 다음 단계 진행 / reject = 고치고 다시 올려라(사유 필수).
exit: 0 정상 · 2 사용법 · 3 대기 시간초과 · 4 없는 탭 · 5 탭 사라짐
`,
  );
}

// ── 진입점 ───────────────────────────────────────────────────────────────

const [verb, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const home = ensureHome(args.home && args.home !== true ? resolve(String(args.home)) : registryHome());

const table = {
  register: cmdRegister,
  update: cmdUpdate,
  status: cmdStatus,
  list: cmdList,
  ls: cmdList,
  show: cmdShow,
  feedback: cmdFeedback,
  ack: cmdAck,
  wait: cmdWait,
  remove: cmdRemove,
  rm: cmdRemove,
  export: cmdExport,
  history: cmdHistory,
  sync: cmdSync,
  help: cmdHelp,
};

if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
  cmdHelp();
  process.exit(EXIT.ok);
}
const fn = table[verb];
if (!fn) {
  process.stderr.write(`[qa-tab] 모르는 동사: ${verb}\n\n`);
  cmdHelp();
  process.exit(EXIT.usage);
}
await fn(args, home);

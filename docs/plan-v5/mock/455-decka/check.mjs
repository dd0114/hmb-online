import { chromium } from "@playwright/test";

const FILE = "file:///Users/peter.park/spider13/hmb-online/docs/plan-v5/mock/455-decka/index.html";
const OUT = "/private/tmp/claude-1609956905/-Users-peter-park-spider13-hmb-online/359043af-cc05-47d4-834a-36ce435c1a60/scratchpad";
const log = [];
const ok = (n, v, extra = "") => log.push(`${v ? "PASS" : "FAIL"}  ${n}${extra ? " — " + extra : ""}`);

const b = await chromium.launch();
process.on("unhandledRejection", (e) => { console.log(log.join("\n")); console.log("ERR " + String(e).slice(0, 240)); process.exit(1); });
const ctx = await b.newContext({ viewport: { width: 1180, height: 900 }, hasTouch: true, isMobile: false, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errs.push("console:" + m.text()); });
await page.goto(FILE);
await page.waitForTimeout(400);

// ── 초기 상태
const starters = await page.locator("#pitch .slot .tok").count();
ok("초기 선발 11명", starters === 11, `${starters}명`);
const power0 = Number(await page.locator("#teamPower").innerText());
ok("팀 전력 계산", power0 > 0, String(power0));
ok("자동 채우기 숨김(빈칸 0)", await page.locator("#btnFill").isHidden());

// ── R3-① 보유 선수 = 모달. 화면에 인라인 목록이 없어야 한다(있으면 R2 로 되돌아간 것)
ok("보유 선수 인라인 목록 없음(= 모달로 되돌림)", (await page.locator("#poolWrap").count()) === 0);
ok("처음엔 보유 선수 목록이 안 보인다(모달이 닫혀 있음)", !(await page.locator("#poolList").isVisible()));

// ── R5-⑤ 기본 = 1안(책갈피 탭). 프롬프트가 **펼쳐진 내용**이어야 한다(버튼 뒤가 아니라)
{
  // ⚠️ 목업 페이지의 설명/하단 바가 폰 프레임 밖에서 덮으므로 **전체화면(실기기와 같은 상태)** 에서 잰다
  await page.locator("#focusOn").click();
  await page.waitForTimeout(400);
  const g = await page.evaluate(() => {
    const ta = document.querySelector("#teamPromptInline");
    const r = ta.getBoundingClientRect(), st = document.querySelector("#stage").getBoundingClientRect();
    const pt = document.querySelector("#pitch").getBoundingClientRect();
    const last = document.querySelector("#stage").contains(document.querySelector("#benchWrap"))
      ? document.querySelector("#benchWrap") : document.querySelector("#pitch");
    return { visible: r.width > 0 && r.height > 0, h: Math.round(r.height),
      hit: document.elementFromPoint(r.left + r.width / 2, r.top + 10) === ta,
      gap: Math.round(st.bottom - last.getBoundingClientRect().bottom),
      tabs: [...document.querySelectorAll("#tabRow button")].map((b) => b.dataset.p),
      benchInTab: document.querySelector("#panelSub").contains(document.querySelector("#benchWrap")),
      poolBarHidden: document.querySelector("#poolBar").hidden, pitchH: Math.round(pt.height) };
  });
  ok("1안 기본 — 프롬프트가 눌러야 보이는 게 아니라 펼쳐져 있다", g.visible && g.hit, `높이 ${g.h}px`);
  ok("탭 3개 = 전체 지시 · 후보 · 세부 전술", JSON.stringify(g.tabs) === JSON.stringify(["team", "sub", "tune"]), g.tabs.join(","));
  ok("후보(벤치)가 탭 안으로 들어갔다", g.benchInTab && g.poolBarHidden);
  ok("1안이 R4 의 아래 여백을 먹는다(여백 ≈ 0)", g.gap <= 4, `${g.gap}px`);
  await page.locator("#phone").screenshot({ path: `${OUT}/mock-r5-tabs.png` });
  await page.locator("#focusOff").click();
  await page.waitForTimeout(300);
}

// ── R4 2안(버튼 바) — 켜서 확인한 뒤 다시 1안으로 되돌린다
await page.locator("#layoutToggle").click();
await page.waitForTimeout(350);
ok("2안 — 하단 버튼 3개(팀 지시 강조 · 가진 선수 · ⚙)",
  (await page.locator("#poolBar #btnTeam").isVisible()) && (await page.locator("#poolBar #btnPool").isVisible())
  && (await page.locator("#poolBar #btnTuneBar").isVisible()));
ok("2안에서 팀 지시만 강조색(다른 버튼과 배경이 다르다)", await page.evaluate(() => {
  const bg = (s) => getComputedStyle(document.querySelector(s)).backgroundColor;
  return bg("#btnTeam") !== bg("#btnPool");
}));
ok("2안에서는 프롬프트 내용이 안 보인다(= 눌러야 보인다)", !(await page.locator("#teamPromptInline").isVisible()));

// ── 팀 프롬프트 시트 (실제 앱 DirectiveRail) — 2안에서는 [팀 지시] 버튼으로 연다
{
  await page.locator("#btnTeam").click();
  await page.waitForTimeout(300);
  const tp = page.locator("#teamPrompt");
  ok("[팀 지시] → 팀 프롬프트 칸이 열린다", await tp.isVisible());
  const said = "초반부터 강하게 압박하고, 뺏으면 곧장 역습으로 간다.";
  await tp.fill(said);
  await page.waitForTimeout(120);
  ok("팀 프롬프트 글자수 표시", (await page.locator("#tpCount").innerText()).trim() === `${said.length} / 500`, await page.locator("#tpCount").innerText());
  await page.locator("#btnTune").click();
  await page.waitForTimeout(150);
  ok("팀 세부 조정 펼침(라인·압박·템포·폭)", (await page.locator("#tunePanel .tuneRow").count()) === 4);
  await page.locator("#tpSave").click();
  await page.waitForTimeout(300);
  ok("저장하면 하단 [팀 지시] 표시등이 켜진다",
    Number(await page.locator("#teamDot").evaluate((e) => getComputedStyle(e).opacity)) > 0.9);
  await page.locator("#btnTeam").click();
  await page.waitForTimeout(280);
  ok("다시 열면 쓴 문장이 그대로 있다", (await page.locator("#teamPrompt").inputValue()) === said);
  await page.locator("#tpCancel").click();
  await page.waitForTimeout(250);
  // 1안으로 되돌리면 **같은 문장**이 인라인에도 그대로 있어야 한다(입력이 두 개인데 값은 하나)
  await page.locator("#layoutToggle").click();
  await page.waitForTimeout(350);
  ok("1안/2안이 같은 팀 지시를 본다(입력 두 개, 값 하나)", (await page.locator("#teamPromptInline").inputValue()) === said);
}

// ── R3-③ 포메이션 전환 — 선수는 그대로, 자리만 다시 배치
{
  const before = await page.evaluate(() => [...document.querySelectorAll("#pitch .slot")].map((s) => ({
    idx: s.dataset.idx, pid: s.querySelector(".tok")?.dataset.player ?? null,
    x: Math.round(s.getBoundingClientRect().left), y: Math.round(s.getBoundingClientRect().top) })));
  await page.selectOption("#formation", "4-3-3");
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => [...document.querySelectorAll("#pitch .slot")].map((s) => ({
    idx: s.dataset.idx, pid: s.querySelector(".tok")?.dataset.player ?? null,
    x: Math.round(s.getBoundingClientRect().left), y: Math.round(s.getBoundingClientRect().top) })));
  const sameSet = JSON.stringify(before.map((b) => b.pid).sort()) === JSON.stringify(after.map((a) => a.pid).sort());
  const moved = before.filter((b, i) => b.x !== after[i].x || b.y !== after[i].y).length;
  ok("포메이션 4-3-3 → 선수 그대로, 자리만 이동", sameSet && moved >= 3, `이동 ${moved}칸 · 선수집합 ${sameSet ? "동일" : "달라짐"}`);
  await page.locator("#phone").screenshot({ path: `${OUT}/mock-r3-433.png` });
  await page.selectOption("#formation", "4-4-2");
  await page.waitForTimeout(250);
}

// ── R3-① 하단 [보유 선수] → 모달이 올라오고, 포지션 필터가 실제로 걸린다
{
  // 1안에서는 [후보] 탭 안의 [제외 명단에서 데려오기] 가 그 입구다
  await page.locator('#tabRow button[data-p="sub"]').click();
  await page.waitForTimeout(250);
  await page.locator("#btnPoolInTab").click();
  await page.waitForTimeout(250);
  ok("[후보] 탭의 [제외 명단에서 데려오기] → 모달 열림", await page.locator('#sheet[data-on="1"] #poolList').isVisible());
  const all = await page.locator("#poolList .prow").count();
  await page.locator('#posFilter button[data-pos="FW"]').click();
  await page.waitForTimeout(150);
  const fw = await page.evaluate(() => [...document.querySelectorAll("#poolList .prow .tok")].map((t) => t.dataset.pos));
  ok("모달 포지션 필터(FW)", fw.length > 0 && fw.every((p) => p === "FW") && fw.length < all, `전체 ${all}명 → FW ${fw.length}명`);
  await page.locator("#phone").screenshot({ path: `${OUT}/mock-r3-pool.png` });
  await page.locator("#poolClose").click();
  await page.waitForTimeout(300);
  // 닫힘 판정은 DOM 존재가 아니라 **실제로 보이는지**로 — 시트는 내려가도 내용이 남는다(계약이 초록으로 거짓말하지 않게)
  const shut = await page.evaluate(() => {
    const l = document.querySelector("#poolList"); if (!l) return { gone: true };
    const r = l.getBoundingClientRect(), ph = document.querySelector("#phone").getBoundingClientRect();
    return { gone: false, below: r.top >= ph.bottom - 2, hit: document.elementFromPoint(r.left + 20, r.top + 10) };
  });
  ok("모달을 닫으면 목록이 화면 밖으로 내려간다", shut.gone || shut.below, JSON.stringify({ gone: shut.gone, below: shut.below }));
}

// ── 정한 값 3개가 처음부터 켜져 있다 (hero 는 고를 것이 없다)
{
  const on = await page.evaluate(() => ({
    q1: document.querySelector('#q1opts .opt[data-v="A"]').dataset.on,
    q2: document.querySelector('#q2opts .opt[data-v="ㄴ"]').dataset.on,
    q3: document.querySelector('#q3opts .opt[data-v="68"]').dataset.on,
    q4: document.querySelector('#q4opts .opt[data-v="sheet"]').dataset.on,
    q5: document.querySelector('#q5opts .opt[data-v="tabs"]').dataset.on,
    live: [document.getElementById("liveQ1").textContent, document.getElementById("liveQ2").textContent, document.getElementById("liveQ3").textContent].join(" · "),
  }));
  ok("A · ㄴ · 68까지 · 시트 · 1안탭 이 기본 선택으로 켜져 있다",
    on.q1 === "1" && on.q2 === "1" && on.q3 === "1" && on.q4 === "1" && on.q5 === "1", on.live);
  const v = await page.evaluate(() => ({ same: document.getElementById("sumVerdict").dataset.same, str: document.getElementById("sumStr").value }));
  ok("컨펌 화면이 '제안 그대로' 로 뜬다",
    v.same === "1" && /메뉴=A안 · auto한마디=ㄴ안 · 경기장=68:68까지/.test(v.str) && /뜨는방식=시트 · 하단=1안탭/.test(v.str), v.str.slice(0, 90));
}

await page.screenshot({ path: `${OUT}/mock-01-initial.png` });
await page.locator("#phone").screenshot({ path: `${OUT}/mock-01-phone.png` });

// ── 탭 → 메뉴
const firstTok = page.locator("#pitch .slot .tok").first();
const pid = await firstTok.getAttribute("data-player");
await firstTok.click();
await page.waitForTimeout(250);
ok("탭 → 메뉴 열림", await page.locator('#sheet[data-on="1"]').isVisible());
const menuCount = await page.locator("#sheet .menuList button").count();
ok("A안 기본 메뉴 4항목", menuCount === 4, `${menuCount}개`);
await page.locator("#phone").screenshot({ path: `${OUT}/mock-02-menu.png` });
{
  const geo = await page.evaluate(() => [...document.querySelectorAll("#sheet .menuList button")].map((b) => {
    const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { t: b.innerText.replace(/\n/g, " ").slice(0, 12), pos: cs.position, hit: hit === b || b.contains(hit) };
  }));
  ok("메뉴 4항목 전부 실제로 눌린다", geo.every((g) => g.pos === "static" && g.hit), JSON.stringify(geo));
}

// ── 프롬프트 입력
await page.locator('#sheet button[data-act="say"]').first().click();
await page.waitForTimeout(200);
await page.locator("#sayText").fill("왼쪽으로 벌려서 크로스 올려라. 무리한 돌파 금지.");
await page.waitForTimeout(100);
const cnt = await page.locator("#sayCount").innerText();
await page.locator("#phone").screenshot({ path: `${OUT}/mock-03-prompt.png` });
await page.locator("#saySave").click();
await page.waitForTimeout(300);
const dotEmpty = await page.locator(`.tok[data-player="${pid}"] .say`).first().getAttribute("data-empty");
ok("한마디 저장 → 초록 점", dotEmpty === "0", `글자수 ${cnt}`);

// ── 꾹 누름 드래그 → 스왑 (터치)
const before = await page.evaluate(() => {
  const t = [...document.querySelectorAll("#pitch .slot")].filter((s) => s.querySelector(".tok"));
  return t.slice(0, 2).map((s) => ({ idx: s.dataset.idx, pid: s.querySelector(".tok").dataset.player }));
});
const a = page.locator(`#pitch .slot[data-idx="${before[0].idx}"] .tok`);
const c = page.locator(`#pitch .slot[data-idx="${before[1].idx}"]`);
const ab = await a.boundingBox(), cb = await c.boundingBox();
const cdp = await ctx.newCDPSession(page);
const tp = (x, y) => [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp(ab.x + ab.width / 2, ab.y + 20) });
await page.waitForTimeout(60);
const ringMid = await page.locator(`.tok[data-player="${before[0].pid}"] .holdRing`).count();
await page.waitForTimeout(180);
const grabbed = await page.evaluate(() => document.querySelector("#ghost")?.dataset.on === "1");
await page.locator("#phone").screenshot({ path: `${OUT}/mock-04-grabbed.png` });
for (let i = 1; i <= 6; i++) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: tp(ab.x + ab.width / 2 + ((cb.x + cb.width / 2 - ab.x - ab.width / 2) * i) / 6, ab.y + 20 + ((cb.y + 22 - ab.y - 20) * i) / 6),
  });
  await page.waitForTimeout(40);
}
await page.locator("#phone").screenshot({ path: `${OUT}/mock-05-dragging.png` });
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(300);
const after = await page.evaluate((idxs) => idxs.map((i) => document.querySelector(`#pitch .slot[data-idx="${i}"] .tok`)?.dataset.player), [before[0].idx, before[1].idx]);
ok("홀드링 표시(150ms 전)", ringMid === 1);
ok("150ms 후 잡힘(고스트)", grabbed);
ok("드롭 → 자리 맞바꿈", after[0] === before[1].pid && after[1] === before[0].pid, `${before[0].pid}↔${before[1].pid} → ${after.join(",")}`);
await page.locator("#phone").screenshot({ path: `${OUT}/mock-06-swapped.png` });

// ── 빈칸 만들기 → 자동 채우기 노출
await page.locator("#tabs button[data-t='q1']").click();
await page.waitForTimeout(200);
await page.locator("#pane-q1 .opt[data-v='C']").click();
await page.waitForTimeout(150);
await page.locator("#tabs button[data-t='proto']").click();
await page.waitForTimeout(200);
await page.locator("#pitch .slot .tok").first().click();
await page.waitForTimeout(200);
const menuC = await page.locator("#sheet .menuList button").count();
ok("C안 메뉴 5항목", menuC === 5, `${menuC}개`);
await page.locator('#sheet button[data-act="remove"]').click();
await page.waitForTimeout(300);
const st2 = await page.locator("#pitch .slot .tok").count();
ok("명단에서 빼기 → 선발 10명", st2 === 10, `${st2}명`);
ok("빈칸 생기면 [자동 채우기] 노출", await page.locator("#btnFill").isVisible());
await page.locator("#phone").screenshot({ path: `${OUT}/mock-07-empty-fill.png` });

// ── R3-① 빈 자리 탭 → 그 포지션으로 필터된 모달 (실제 앱 PlayerPicker autoFilter 와 같은 성질)
{
  const empty = page.locator("#pitch .slot").filter({ has: page.locator(".hole") }).first();
  const want = (await empty.locator(".posTag").innerText()).trim();
  await empty.click();
  await page.waitForTimeout(250);
  const st = await page.evaluate(() => ({
    open: document.querySelector("#sheet").dataset.on,
    on: document.querySelector('#posFilter button[data-on="1"]')?.dataset.pos,
    rows: [...document.querySelectorAll("#poolList .prow .tok")].map((t) => t.dataset.pos),
  }));
  ok("빈 자리 탭 → 그 포지션으로 필터된 모달", st.open === "1" && st.on === want && st.rows.every((p) => p === want),
    `${want} 자리 → 필터 ${st.on} · ${st.rows.length}명`);
  await page.locator("#phone").screenshot({ path: `${OUT}/mock-r3-emptyslot-pool.png` });
  await page.locator("#poolClose").click();
  await page.waitForTimeout(200);
}
await page.locator("#btnFill").click();
await page.waitForTimeout(300);
const st3 = await page.locator("#pitch .slot .tok").count();
ok("자동 채우기 → 다시 11명", st3 === 11, `${st3}명`);
ok("채운 뒤 버튼 다시 숨김", await page.locator("#btnFill").isHidden());

// ── C 안으로 바꾸면 컨펌 화면이 "제안과 다름" 으로 바뀐다
{
  const v = await page.evaluate(() => ({ same: document.getElementById("sumVerdict").dataset.same, cls: document.getElementById("s1").className }));
  ok("다른 안을 고르면 컨펌 화면이 '다름' 으로 바뀐다", v.same === "0" && /chg/.test(v.cls), `same=${v.same} · ${v.cls}`);
}

// ── auto (기본 ㄴ안 = 쓴 한마디 불가침, 질문 없이 바로 동작)
const promptsBefore = await page.evaluate(() => document.querySelectorAll('.say[data-empty="0"]').length);
await page.locator("#btnAuto").click();
await page.waitForTimeout(400);
const promptsAfter = await page.evaluate(() => document.querySelectorAll('.say[data-empty="0"]').length);
const toastTxt = await page.locator("#toast").innerText();
ok("auto 가 질문 없이 바로 동작(기본 ㄴ안)", !(await page.locator("#pane-q2").isVisible()) && /전력/.test(toastTxt), toastTxt.slice(0, 70));
ok("ㄴ안 auto → 쓴 한마디 보존 + 빈 칸만 채움", promptsAfter >= promptsBefore, `${promptsBefore}→${promptsAfter} · ${toastTxt.slice(0, 70)}`);
{
  const kept = await page.evaluate(() => {
    // 앞서 저장한 문장이 사람을 따라 그대로 남아 있는가
    return [...document.querySelectorAll(".tok .say")].filter((s) => s.dataset.empty === "0").length;
  });
  ok("auto 뒤에도 한마디 있는 선수가 남아 있다", kept > 0, `${kept}명`);
}
await page.locator("#phone").screenshot({ path: `${OUT}/mock-08-auto.png` });

// ── 비율: 기본(68 상한) vs 현행 68:44
const h0 = (await page.locator("#pitch").boundingBox()).height;
await page.locator("#tabs button[data-t='q3']").click();
await page.waitForTimeout(150);
await page.locator("#pane-q3 .opt[data-v='44']").click();
await page.locator("#tabs button[data-t='proto']").click();
await page.waitForTimeout(300);
const h1 = (await page.locator("#pitch").boundingBox()).height;
ok("기본(68 상한)이 현행 68:44 보다 경기장이 크다", h0 > h1 + 30, `68까지 ${Math.round(h0)}px vs 68:44 ${Math.round(h1)}px`);
await page.locator("#phone").screenshot({ path: `${OUT}/mock-09-ratio44.png` });
await page.locator("#tabs button[data-t='q3']").click();
await page.waitForTimeout(150);
await page.locator("#pane-q3 .opt[data-v='68']").click();
await page.locator("#tabs button[data-t='proto']").click();
await page.waitForTimeout(300);

// ── R4-④ 모달(가운데 팝업) 모드 — 같은 내용, 뜨는 방식만 다르다
{
  await page.locator("#surfaceToggle").click();
  await page.waitForTimeout(200);
  await page.locator('#tabRow button[data-p="sub"]').click();
  await page.waitForTimeout(200);
  await page.locator("#btnPoolInTab").click();
  await page.waitForTimeout(350);
  const g = await page.evaluate(() => {
    const s = document.querySelector("#sheet").getBoundingClientRect();
    const ph = document.querySelector("#phone").getBoundingClientRect();
    const rows = document.querySelectorAll("#poolList .prow").length;
    return { mode: document.querySelector("#sheet").dataset.mode, rows,
      belowGap: Math.round(ph.bottom - s.bottom), aboveGap: Math.round(s.top - ph.top),
      pitchVisible: Math.round(document.querySelector("#pitch").getBoundingClientRect().bottom - s.top) };
  });
  ok("모달 모드 — 아래·위가 모두 떠 있다(시트가 아니다)", g.mode === "modal" && g.belowGap > 20 && g.aboveGap > 20,
    JSON.stringify({ 위: g.aboveGap, 아래: g.belowGap }));
  ok("모달이어도 목록 내용은 같다", g.rows > 0, `${g.rows}행`);
  await page.locator("#phone").screenshot({ path: `${OUT}/mock-r4-modal.png` });
  await page.locator("#poolClose").click();
  await page.waitForTimeout(250);
  // 선수 메뉴도 같이 모달로 바뀐다(표시 방식은 화면 전체에 하나)
  await page.locator("#pitch .slot .tok").first().click();
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => ({ n: document.querySelectorAll("#sheet .menuList button").length,
    mode: document.querySelector("#sheet").dataset.mode }));
  ok("선수 메뉴도 같은 방식으로 뜬다", m.mode === "modal" && m.n >= 4, `${m.n}항목 · ${m.mode}`);
  await page.locator('#sheet button[data-act="close"]').click();
  await page.waitForTimeout(250);
  await page.locator("#surfaceToggle").click();   // 기본(시트)으로 되돌린다
  await page.waitForTimeout(200);
  ok("되돌리면 다시 시트", (await page.locator("#sheet").getAttribute("data-mode")) === "sheet");
}

// ── 폰 실기기 뷰포트(390×844) 별도 확인
const p2 = await (await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })).newPage();
await p2.goto(FILE);
await p2.waitForTimeout(400);
await p2.locator("#focusOn").click();          // 실기기와 같게 = 설명 없이 폰 전체
await p2.waitForTimeout(400);
const geo = await p2.evaluate(() => {
  const r = (s) => document.querySelector(s).getBoundingClientRect();
  const ph = r("#phone"), tb = r("#deckTabs"), pt = r("#pitch"), st = r("#stage");
  return { gap: Math.round(ph.bottom - tb.bottom), pitchH: Math.round(pt.height), pitchW: Math.round(pt.width),
    spacer: Math.round(st.bottom - pt.bottom), phoneH: Math.round(ph.height), ratio: Math.round((68 * pt.height) / pt.width) };
});
ok("1안 탭이 화면 최하단(빈 띠 없음)", geo.gap <= 2, geo.gap + "px");
ok("폰에서 경기장이 상한 68 에 닿는다", geo.ratio >= 64 && geo.ratio <= 70, `실측 68 : ${geo.ratio} (${geo.pitchW}×${geo.pitchH}px)`);
// ⚠️ 68 에서 멈추면 아래가 남는다 — 그 크기를 **판정하지 않고 기록**한다(얼마가 적당한지는 hero 결정)
ok("1안에서 경기장 아래 죽은 여백 없음", geo.spacer <= 4, `${geo.spacer}px`);
ok("실측 비율이 화면에도 그대로 표시된다",
  new RegExp(`68 : ${geo.ratio}`).test(await p2.locator("#liveQ3").innerText()), await p2.locator("#liveQ3").innerText());
{
  const ov = await p2.evaluate(() => {
    // 4-4-2 미드필더 4명 이름표가 서로 겹치는지 — 좌표 추론이 아니라 실제 사각형 교차로 본다
    const nm = [...document.querySelectorAll("#pitch .slot .tok .nm")].map((e) => e.getBoundingClientRect());
    let hit = 0;
    for (let i = 0; i < nm.length; i++) for (let j = i + 1; j < nm.length; j++) {
      const a = nm[i], b = nm[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) hit++;
    }
    return hit;
  });
  ok("선수 이름표 겹침 0 (A1 의 원래 불만)", ov === 0, `겹친 쌍 ${ov}`);
}
const doc = await p2.evaluate(() => ({ ow: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
ok("390px 폰에서 가로 넘침 없음", doc.ow <= doc.cw + 1, `${doc.ow} vs ${doc.cw}`);
await p2.screenshot({ path: `${OUT}/mock-10-phone390.png`, fullPage: false });

ok("JS 에러 0", errs.length === 0, errs.slice(0, 3).join(" | "));
console.log(log.join("\n"));
await b.close();

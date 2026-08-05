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

// ── 정한 값 3개가 처음부터 켜져 있다 (hero 는 고를 것이 없다)
{
  const on = await page.evaluate(() => ({
    q1: document.querySelector('#q1opts .opt[data-v="A"]').dataset.on,
    q2: document.querySelector('#q2opts .opt[data-v="ㄴ"]').dataset.on,
    q3: document.querySelector('#q3opts .opt[data-v="60"]').dataset.on,
    live: [document.getElementById("liveQ1").textContent, document.getElementById("liveQ2").textContent, document.getElementById("liveQ3").textContent].join(" · "),
  }));
  ok("A · ㄴ · 68:60 이 기본 선택으로 켜져 있다", on.q1 === "1" && on.q2 === "1" && on.q3 === "1", on.live);
  const v = await page.evaluate(() => ({ same: document.getElementById("sumVerdict").dataset.same, str: document.getElementById("sumStr").value }));
  ok("컨펌 화면이 '제안 그대로' 로 뜬다", v.same === "1" && /메뉴=A안 · auto한마디=ㄴ안 · 경기장=68:60/.test(v.str), v.str.slice(0, 60));
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

// ── 비율 슬라이더
const h0 = (await page.locator("#pitch").boundingBox()).height;
await page.locator("#tabs button[data-t='q3']").click();
await page.waitForTimeout(150);
await page.locator("#pane-q3 .opt[data-v='76']").click();
await page.locator("#tabs button[data-t='proto']").click();
await page.waitForTimeout(250);
const h1 = (await page.locator("#pitch").boundingBox()).height;
ok("비율 슬라이더가 경기장 높이를 바꾼다", h1 > h0 + 30, `${Math.round(h0)}px → ${Math.round(h1)}px`);
await page.locator("#phone").screenshot({ path: `${OUT}/mock-09-ratio76.png` });

// ── 폰 실기기 뷰포트(390×844) 별도 확인
const p2 = await (await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })).newPage();
await p2.goto(FILE);
await p2.waitForTimeout(400);
const poolH = await p2.evaluate(() => Math.round(document.querySelector("#poolWrap").getBoundingClientRect().height));
ok("폰에서 보유 선수 목록이 남는 세로를 가져간다", poolH > 120, poolH + "px");
const gap = await p2.evaluate(() => {
  const ph = document.querySelector("#phone").getBoundingClientRect();
  const pw = document.querySelector("#poolWrap").getBoundingClientRect();
  return Math.round(ph.bottom - pw.bottom);
});
ok("보유 선수 아래 빈 띠 없음(= 최하단)", gap <= 2, gap + "px");
const doc = await p2.evaluate(() => ({ ow: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
ok("390px 폰에서 가로 넘침 없음", doc.ow <= doc.cw + 1, `${doc.ow} vs ${doc.cw}`);
await p2.screenshot({ path: `${OUT}/mock-10-phone390.png`, fullPage: false });

ok("JS 에러 0", errs.length === 0, errs.slice(0, 3).join(" | "));
console.log(log.join("\n"));
await b.close();

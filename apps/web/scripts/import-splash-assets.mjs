#!/usr/bin/env node
/**
 * #479 — 첫 진입 스플래시 소재 반입 (adboost #475 동결본 → apps/web/public/splash/**)
 *
 * ## 왜 이 스크립트가 있나 (그리고 왜 산출물을 커밋하나)
 *
 * `public/chars/`·`public/viewer-embed.html` 은 **gitignore + 빌드시 재생성**이다 — 소재가
 * 리포 안(`design/characters/dist`)에 있어서 배포 시점에 다시 만들 수 있기 때문이다.
 * 스플래시는 **그럴 수 없다**: 동결본과 소재가 `~/hmb-submit/`(리포 밖, adboost 세션 산출물)에
 * 있어서 CF Pages 빌드 머신에는 존재하지 않는다. 그래서 **변환 결과를 커밋한다**(#479 스코프의
 * "에셋을 리포로 복사·경량화"). 이 스크립트는 그 산출물의 **출처와 재현 절차**를 박아 두는 것이고,
 * 동결본이 손에 있을 때만 돌아간다.
 *
 * ## 무엇을 반입하나 — 250MB 가 아니라 137장
 *
 * `v1-final-20260809.html` 의 컷 7개가 참조하는 소재만 가져온다. `../seq/**` 는 20개 시퀀스
 * 1540장 250MB 인데 이 광고는 그 중 4개 시퀀스의 **일부 구간**만 쓴다(나머지 16개는 한 장도
 * 참조하지 않는다). 아래 RANGES 가 그 구간이다.
 *
 * ⚠️ **RANGES 는 사본이다 — 정본은 `src/splash/ad-show.ts` 다.** 둘이 갈라지면
 * `src/splash/splash-assets.test.ts` 가 red 가 된다(쇼가 참조하는 파일이 없거나, 안 쓰는
 * 파일이 반입돼 있으면 그 계약이 잡는다). 여기 숫자를 고치기 전에 그 테스트를 봐라.
 *
 * ## 왜 webp q80 이고, 왜 프레임/해상도는 안 건드리나
 *
 * - q80 = **압축만**. 137장 21.6MB(PNG) → 4.19MB. `focus: CARD` 로 선명하게 표시되는 카드
 *   영역을 PNG/q72/q80/q86 스택으로 크롭해 눈으로 대조했고 구분되지 않았다(§2-2).
 * - ⚠️ **품질을 더 내리는 것은 레버가 아니다** — `say1` 한 장이 q86→q50 에서 84→54KB 뿐이다.
 *   용량을 지배하는 것은 글자가 아니라 UI 배경의 미세 그라디언트 노이즈다.
 * - ⚠️ **해상도 축소·프레임 드롭은 기각했다.** 카메라가 `TIGHT=780`(소재 픽셀) 크롭을 1080
 *   무대에 넣으므로 폰(390 CSS × DPR3 = 1170 device px)에서 소재는 이미 1:1~1.4배 업스케일로
 *   쓰인다 — 낮추면 이 광고의 클라이맥스인 펀치인이 뭉개진다. 프레임 드롭(`say1` 31→16 =
 *   −1.3MB)은 20fps→10fps 라 hero 가 #475 R2 에서 직접 튜닝한 호흡을 바꾼다.
 *
 * ## 사용법
 *
 *   node apps/web/scripts/import-splash-assets.mjs            # 기본 소스 ~/hmb-submit
 *   HMB_SUBMIT=/path/to/hmb-submit node …/import-splash-assets.mjs
 *   node …/import-splash-assets.mjs --check                   # 변환 없이 산출물만 검사
 *
 * 필요 도구 = `cwebp`(brew install webp).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..");
const OUT_ROOT = join(WEB_ROOT, "public", "splash");
const SRC_ROOT = process.env.HMB_SUBMIT ?? join(homedir(), "hmb-submit");

/** webp 품질 — 위 주석의 근거로 고정. 바꾸면 산출물 전체가 움직인다. */
const QUALITY = 80;

/**
 * 동결본이 참조하는 프레임 구간. `[from, to]` 양끝 포함(플레이어 `clip()` 과 같은 규약).
 * ⚠️ 정본은 `src/splash/ad-show.ts` — 위 주석 참조.
 */
const RANGES = [
  // 컷 ① steal 65–71 은 컷 ③ 14–70 과 합쳐 14–71 (플레이어가 Set 으로 dedupe 한다)
  { seq: "steal", from: 14, to: 71 },
  { seq: "say1", from: 17, to: 47 },
  { seq: "tackle", from: 14, to: 59 },
  // 컷 ④ 는 이 한 장을 정지컷으로 쓴다(meta.json 이 note:"empty" 로 표시한 마지막 프레임).
  // ⚠️ 디렉토리명 `say-captain` 을 유지해야 한다 — 플레이어의 onTick 합성 레이어가 pane 의
  //    src 문자열에 그 이름이 들어 있는지로 게이트한다(player.js paintSayCard).
  { seq: "say-captain", from: 16, to: 16 },
];

/** 정지컷(시퀀스 밖). */
const STILLS = [{ src: "shots/76-reveal-all.png", out: "shots/76-reveal-all.webp" }];

const pad3 = (n) => String(n).padStart(3, "0");

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [p.slice(base.length + 1)];
  });
}

function expected() {
  const out = [];
  for (const { seq, from, to } of RANGES) {
    for (let i = from; i <= to; i++) out.push(`seq/${seq}/f-${pad3(i)}.webp`);
  }
  for (const s of STILLS) out.push(s.out);
  return out.sort();
}

function report() {
  const want = expected();
  const have = walk(OUT_ROOT).sort();
  const missing = want.filter((f) => !have.includes(f));
  const extra = have.filter((f) => !want.includes(f));
  let bytes = 0;
  for (const f of have) bytes += statSync(join(OUT_ROOT, f)).size;
  const digest = createHash("sha256");
  for (const f of have) digest.update(f).update(readFileSync(join(OUT_ROOT, f)));
  return { want, have, missing, extra, bytes, sha: digest.digest("hex").slice(0, 16) };
}

function print(r) {
  console.log(`[splash] out   : ${OUT_ROOT}`);
  console.log(`[splash] files : ${r.have.length} / expected ${r.want.length}`);
  console.log(`[splash] bytes : ${r.bytes} (${(r.bytes / 1048576).toFixed(2)} MB)`);
  console.log(`[splash] sha256: ${r.sha} (path+content, 앞 16자)`);
  if (r.missing.length) console.log(`[splash] MISSING (${r.missing.length}): ${r.missing.slice(0, 8).join(", ")}…`);
  if (r.extra.length) console.log(`[splash] EXTRA   (${r.extra.length}): ${r.extra.slice(0, 8).join(", ")}…`);
}

if (process.argv.includes("--check")) {
  const r = report();
  print(r);
  process.exit(r.missing.length || r.extra.length ? 1 : 0);
}

// ── 변환 ─────────────────────────────────────────────────────────────────────
if (!existsSync(SRC_ROOT)) {
  console.error(`[splash] 동결본 소재가 없다: ${SRC_ROOT}`);
  console.error(`[splash] 이 스크립트는 adboost 산출물이 손에 있을 때만 돈다. 커밋된 public/splash/**`);
  console.error(`[splash] 는 그 결과물이고, 검사만 하려면 --check 를 써라.`);
  process.exit(2);
}
try {
  execFileSync("cwebp", ["-version"], { stdio: "ignore" });
} catch {
  console.error("[splash] cwebp 가 없다 — brew install webp");
  process.exit(2);
}

rmSync(OUT_ROOT, { recursive: true, force: true });

let n = 0;
for (const { seq, from, to } of RANGES) {
  mkdirSync(join(OUT_ROOT, "seq", seq), { recursive: true });
  for (let i = from; i <= to; i++) {
    const src = join(SRC_ROOT, "seq", seq, `f-${pad3(i)}.png`);
    if (!existsSync(src)) {
      console.error(`[splash] 소재 없음: ${src}`);
      process.exit(3);
    }
    execFileSync("cwebp", ["-quiet", "-q", String(QUALITY), src, "-o", join(OUT_ROOT, "seq", seq, `f-${pad3(i)}.webp`)]);
    n++;
  }
  console.log(`[splash] ${seq} ${from}–${to} 변환 완료`);
}
for (const s of STILLS) {
  const src = join(SRC_ROOT, s.src);
  if (!existsSync(src)) {
    console.error(`[splash] 소재 없음: ${src}`);
    process.exit(3);
  }
  mkdirSync(dirname(join(OUT_ROOT, s.out)), { recursive: true });
  execFileSync("cwebp", ["-quiet", "-q", String(QUALITY), src, "-o", join(OUT_ROOT, s.out)]);
  n++;
  console.log(`[splash] ${s.src} 변환 완료`);
}

console.log(`[splash] q${QUALITY} · ${n}장`);
const r = report();
print(r);
process.exit(r.missing.length || r.extra.length ? 1 : 0);

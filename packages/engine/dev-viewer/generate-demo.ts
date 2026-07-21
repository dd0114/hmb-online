import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog, MatchEvent } from "@hmb/shared";
import { runMatch } from "../src/match";
import { defaultEngineConfig } from "../src/config";
import { demoSeed, demoHome, demoAway, demoSelect, makeTacticalInput } from "../src/fixtures";
import { computeMatchStats, formatStatsReport, type StatsOptions, type MatchStats } from "./match-stats";

/**
 * generate-demo — fixtures 로 runMatch 를 실행해 dev-viewer/match-log.json 을 만든다.
 * index.html 이 이 JSON 을 fetch 해서 경기를 애니메이션한다.
 *
 * 실행 방법(둘 중 택1):
 *  1) 테스트 러너(권장, Node 20 OK):
 *       npx vitest run packages/engine/dev-viewer/generate-demo.test.ts
 *     → match-log.json 이 (재)생성된다.
 *  2) Node 22+ 직접 실행:
 *       node --experimental-strip-types packages/engine/dev-viewer/generate-demo.ts
 */

/** 데모 MatchLog 생성(리얼 config = 스탯 증빙용). */
export function buildDemoLog(): MatchLog {
  return runMatch(demoSeed, demoHome, demoAway, demoSelect, defaultEngineConfig);
}

/**
 * 쇼케이스 config — 뷰어 관전용(리얼 아님). 경기 시간을 줄이고 골 확률을 높여
 * "짧고 잘 보이는" 데모를 만든다. 리얼 config(defaultEngineConfig)는 그대로 유지.
 * 튜닝 노브(가독성): matchMinutes(관전시간) · contest.xgBase/onTargetBase(골 빈도).
 */
export const showcaseConfig = {
  ...defaultEngineConfig,
  version: "engine@0.9.0-showcase",
  matchMinutes: 24,
  decisionWeights: {
    ...defaultEngineConfig.decisionWeights,
    shoot: 1.6, // 슛 더 자주(관전 재미).
  },
  contest: {
    ...defaultEngineConfig.contest,
    xgBase: 0.62, // 0.225 → 0.62 (슛당 득점 확률↑ = 골 더 많이, 관전 재미용 · perceptibility 6/6)
    onTargetBase: 0.55, // 유효슛↑ → 세이브 상황↑
    shootXgThreshold: 0.05,
    saveCornerProb: 0.7, // 세이브→코너 굴절↑
    offTargetBlockCornerProb: 0.45, // 빗맞음→코너↑
    oneOnOneClearM: 7.0,
    oneOnOneXgMult: 2.0, // 1대1 하이라이트 더 강하게
  },
  rules: {
    ...defaultEngineConfig.rules,
    foul: { ...defaultEngineConfig.rules.foul, base: 0.02 },
    // 24분짜리 쇼케이스는 리얼 빈도로는 카드가 안 나올 때가 많다(파울 ~3건 × 옐로 0.17).
    // 관전 데모는 카드 연출도 보여줘야 하므로 쇼케이스에서만 상향(리얼 config 는 무변경).
    card: { ...defaultEngineConfig.rules.card, yellowProb: 0.5 },
  },
  variety: {
    ...defaultEngineConfig.variety,
    dribbleChainProb: 0.8,
    dribbleChainBonus: 1.6,
    dribbleChainMaxTicks: 6,
    defenderOverlapProb: 0.2,
    overlapReach: 0.45,
    decisionTemperature: 0.7,
    roamNoiseAmp: 4.5,
  },
};

/** 쇼케이스 MatchLog(뷰어용). */
export function buildShowcaseLog(): MatchLog {
  return runMatch(demoSeed, demoHome, demoAway, demoSelect, showcaseConfig);
}

/**
 * 골 검증(AC-goal-in-net): 각 goal 이벤트의 골 틱 스냅샷에서 공이
 *  - 골라인 근처(x < nearLine 또는 x > width-nearLine)  AND
 *  - 골포스트 y 범위 안(centerY ± goalWidth/2)
 * 에 있으면 PASS. 센터(52.5,34)로 리셋되면 FAIL.
 */
function buildGoalInNetReport(log: MatchLog, label: string): { report: string; allPass: boolean } {
  const width = defaultEngineConfig.pitch.width; // 105
  const height = defaultEngineConfig.pitch.height; // 68
  const goalWidth = defaultEngineConfig.pitch.goalWidth; // 7.32
  const centerY = height / 2;
  const halfPost = goalWidth / 2;
  const yLo = centerY - halfPost;
  const yHi = centerY + halfPost;
  const nearLine = 3; // 골라인 근처 허용 오차(m).

  const snapByTick = new Map<number, (typeof log.tickSnapshots)[number]>();
  for (const s of log.tickSnapshots) snapByTick.set(s.tick, s);

  const goals = log.events.filter((e) => e.type === "goal");
  const lines: string[] = [];
  lines.push(`=== AC-goal-in-net: ${label} (${log.configVersion}, seed ${log.seed}) ===`);
  lines.push(
    `골라인 근처 기준: x < ${nearLine} 또는 x > ${width - nearLine} | 골포스트 y 범위: ${yLo.toFixed(2)}..${yHi.toFixed(2)}`,
  );
  lines.push(`총 골: ${goals.length}`);
  let allPass = true;
  goals.forEach((g, i) => {
    const snap = snapByTick.get(g.tick);
    if (!snap) {
      allPass = false;
      lines.push(`  #${i + 1} tick=${g.tick} team=${g.team} FAIL: 스냅샷 없음`);
      return;
    }
    const { x, y } = snap.ball;
    const nearGoalLine = x < nearLine || x > width - nearLine;
    const inPosts = y >= yLo && y <= yHi;
    const pass = nearGoalLine && inPosts;
    if (!pass) allPass = false;
    lines.push(
      `  #${i + 1} tick=${g.tick} team=${g.team} ball=(${x.toFixed(2)},${y.toFixed(2)}) ` +
        `골라인=${nearGoalLine ? "O" : "X"} 포스트내=${inPosts ? "O" : "X"} => ${pass ? "PASS" : "FAIL"}`,
    );
  });
  lines.push(`결과: ${allPass ? "ALL PASS" : "FAIL"} (센터(52.5,34) 리셋이면 FAIL)`);
  return { report: lines.join("\n"), allPass };
}

/**
 * 슛 도착 검증(AC-shot-target): 모든 슛 결과의 그 틱 스냅샷 공 y 가 골문 근처(26~42)이고
 * 코너(y<5 또는 y>63)로 간 슛이 0건인지 확인한다. 결과(goal/saved/off_target)별로 도착 좌표 표.
 *  - goal: 골 이벤트(공은 네트).
 *  - saved: 세이브 결과 슛 이벤트(공은 키퍼 = 골문 중앙).
 *  - off_target: 빗맞음 결과 슛 이벤트(공은 골포스트 살짝 옆).
 * (코너/골킥 세트피스는 별도 shot_out 정지 이후 재시작 단계에서만 공이 코너/스팟에 놓인다.)
 */
function buildShotTargetReport(log: MatchLog, label: string): { report: string; allPass: boolean } {
  const width = defaultEngineConfig.pitch.width; // 105
  const height = defaultEngineConfig.pitch.height; // 68
  const centerY = height / 2; // 34
  const halfPost = defaultEngineConfig.pitch.goalWidth / 2; // 3.66
  const yLo = 26;
  const yHi = 42;
  const cornerLo = 5; // y<5 또는 y>height-5(=63) 이면 코너 깃발 영역.
  const cornerHi = height - 5;

  const snapByTick = new Map<number, (typeof log.tickSnapshots)[number]>();
  for (const s of log.tickSnapshots) snapByTick.set(s.tick, s);

  // 검증 대상: goal 이벤트 + 슛 결과 이벤트(detail=saved/off_target).
  //  - goal/saved: 공이 골문 근처(y 26..42, 코너 아님)에 도달했는지(네트/키퍼 dwell).
  //  - off_target: 공이 골라인을 넘어(x<0 또는 x>width) 포스트 바깥(y<30.34 또는 y>37.66)으로
  //    "슉 벗어나는" 프레임이 찍혔는지 + 코너 깃발 직행 0건.
  type Row = { kind: string; tick: number; team: string; x: number; y: number; ok: boolean; corner: boolean; reason: string };
  const rows: Row[] = [];
  for (const e of log.events) {
    let kind: string | null = null;
    if (e.type === "goal") kind = "goal";
    else if (e.type === "shot" && e.detail === "saved") kind = "saved";
    else if (e.type === "shot" && e.detail === "off_target") kind = "off_target";
    if (!kind) continue;
    const snap = snapByTick.get(e.tick);
    if (!snap) {
      rows.push({ kind, tick: e.tick, team: e.team ?? "?", x: NaN, y: NaN, ok: false, corner: false, reason: "스냅샷없음" });
      continue;
    }
    const { x, y } = snap.ball;
    const corner = y < cornerLo || y > cornerHi;
    let ok: boolean;
    let reason = "";
    if (kind === "off_target") {
      const pastLine = x < 0 || x > width;
      const wideOfPost = y < centerY - halfPost || y > centerY + halfPost;
      ok = pastLine && wideOfPost && !corner;
      if (!ok) reason = corner ? "코너!" : !pastLine ? "골라인안" : "포스트안";
    } else {
      ok = y >= yLo && y <= yHi && !corner;
      if (!ok) reason = corner ? "코너!" : "골문밖";
    }
    rows.push({ kind, tick: e.tick, team: e.team ?? "?", x, y, ok, corner, reason });
  }

  const cornerShots = rows.filter((r) => r.corner);
  const allPass = rows.every((r) => r.ok);
  const byKind = (k: string): Row[] => rows.filter((r) => r.kind === k);
  const dist = (k: string): string => {
    const rs = byKind(k).filter((r) => Number.isFinite(r.y));
    if (rs.length === 0) return `${k}: 0건`;
    const ys = rs.map((r) => r.y).sort((a, b) => a - b);
    const min = ys[0]!;
    const max = ys[ys.length - 1]!;
    const mean = Math.round((ys.reduce((s, v) => s + v, 0) / ys.length) * 100) / 100;
    return `${k}: ${rs.length}건  y[min ${min.toFixed(2)} / mean ${mean.toFixed(2)} / max ${max.toFixed(2)}]  코너 ${byKind(k).filter((r) => r.corner).length}건`;
  };

  const L: string[] = [];
  L.push(`=== AC-shot-target: ${label} (${log.configVersion}, seed ${log.seed}) ===`);
  L.push(`판정: goal/saved 는 골문 근처(y ${yLo}..${yHi}) | off_target 은 골라인 너머(x<0 또는 x>${width}) + 포스트 바깥(y<${(centerY - halfPost).toFixed(2)} 또는 y>${(centerY + halfPost).toFixed(2)}) | 코너(y<${cornerLo} 또는 y>${cornerHi})로 간 슛 0건이면 PASS`);
  L.push(`총 슛 결과(goal+saved+off_target): ${rows.length}  |  코너로 간 슛: ${cornerShots.length}건`);
  L.push("");
  L.push(dist("goal"));
  L.push(dist("saved"));
  L.push(dist("off_target"));
  L.push("");
  L.push(`${"결과".padEnd(12)}${"tick".padEnd(8)}${"team".padEnd(6)}${"ball(x,y)".padEnd(20)}판정`);
  for (const r of rows) {
    const pos = Number.isFinite(r.x) ? `(${r.x.toFixed(2)},${r.y.toFixed(2)})` : "스냅샷없음";
    L.push(
      r.kind.padEnd(12) +
        String(r.tick).padEnd(8) +
        r.team.padEnd(6) +
        pos.padEnd(20) +
        (r.ok ? "PASS" : `FAIL(${r.reason})`),
    );
  }
  L.push("");
  L.push(`결과: ${allPass ? "ALL PASS" : "FAIL"} (코너로 간 슛 ${cornerShots.length}건)`);
  return { report: L.join("\n"), allPass };
}

/**
 * 킥오프 검증(AC-kickoff): 골 후(+후반 시작·개시) 정식 킥오프의
 *  1) kickoff MatchEvent 존재(각 골 → goalStoppageTicks 뒤 킥오프 틱),
 *  2) 포메이션 리셋(전/후): 킥오프 직전 틱(세리머니 dwell = 흩어짐) vs 킥오프 틱(t0 슬롯 복귀),
 *  3) 공 = 센터 + 실점팀 소유
 * 를 검증한다. 포메이션 일치는 t0(경기시작 킥오프) 스냅샷 대비, 테이커(센터 이동) 2명 제외 전 선수.
 */
function buildKickoffReport(log: MatchLog, label: string): { report: string; allPass: boolean } {
  const cfg = defaultEngineConfig;
  const stoppage = cfg.setPiece.goalStoppageTicks;
  const cx = cfg.pitch.width / 2;
  const cy = cfg.pitch.height / 2;
  const TOL = 0.1; // 슬롯 일치 허용오차(m). 스냅샷은 cm 반올림 → 크리스프 리셋은 ~0.
  const byTick = new Map<number, (typeof log.tickSnapshots)[number]>();
  for (const s of log.tickSnapshots) byTick.set(s.tick, s);
  const t0 = byTick.get(0);
  const t0Pos = new Map((t0?.players ?? []).map((p) => [p.playerId, p.pos] as const));
  const t0Taker = t0?.ballOwner ?? null;

  /** snap 의 (테이커 2명 제외) 선수들이 t0 슬롯에서 벗어난 최대 거리 + 일치 수/대상 수. */
  const formationDev = (
    snap: (typeof log.tickSnapshots)[number] | undefined,
    koTaker: string | null,
  ): { maxDev: number; matched: number; compared: number } => {
    if (!snap) return { maxDev: Infinity, matched: 0, compared: 0 };
    let maxDev = 0;
    let matched = 0;
    let compared = 0;
    for (const p of snap.players) {
      if (p.playerId === t0Taker || p.playerId === koTaker) continue;
      const base = t0Pos.get(p.playerId);
      if (!base) continue;
      compared++;
      const dev = Math.max(Math.abs(p.pos.x - base.x), Math.abs(p.pos.y - base.y));
      if (dev > maxDev) maxDev = dev;
      if (dev <= TOL) matched++;
    }
    return { maxDev, matched, compared };
  };

  const L: string[] = [];
  L.push(`=== AC-kickoff: ${label} (${log.configVersion}, seed ${log.seed}) ===`);
  L.push(`판정: 각 골 → ${stoppage}틱 뒤 kickoff 이벤트 존재 + 킥오프틱 공=센터(${cx},${cy})·실점팀 소유 + 포메이션 t0 슬롯 복귀(테이커 제외, 허용오차 ${TOL}m)`);
  L.push("");

  const goals = log.events.filter((e) => e.type === "goal");
  L.push(`총 골: ${goals.length}`);
  L.push(
    `${"#".padEnd(3)}${"goalTick".padEnd(10)}${"team".padEnd(6)}${"koTick".padEnd(8)}` +
      `${"koEvt".padEnd(7)}${"ball(x,y)".padEnd(16)}${"소유".padEnd(6)}` +
      `${"전dev(dwell)".padEnd(14)}${"후dev(kickoff)".padEnd(16)}판정`,
  );
  let allPass = true;
  goals.forEach((g, i) => {
    const koTick = g.tick + stoppage;
    const conceding = g.team === "home" ? "away" : "home";
    const koEvt = log.events.find(
      (e) => e.type === "kickoff" && !e.detail && e.tick === koTick && e.team === conceding,
    );
    const koSnap = byTick.get(koTick);
    const koTaker = koSnap?.ballOwner ?? null;
    const before = formationDev(byTick.get(koTick - 1), koTaker); // 세리머니 dwell(흩어짐)
    const after = formationDev(koSnap, koTaker); // 킥오프(리셋)
    const owner = koSnap?.players.find((p) => p.playerId === koSnap.ballOwner);
    const ballCentered =
      !!koSnap && Math.abs(koSnap.ball.x - cx) <= TOL && Math.abs(koSnap.ball.y - cy) <= TOL;
    const ownerOk = owner?.team === conceding;
    const formOk = after.compared > 0 && after.matched === after.compared;
    const pass = !!koEvt && ballCentered && ownerOk && formOk;
    if (!pass) allPass = false;
    const ballStr = koSnap ? `(${koSnap.ball.x.toFixed(1)},${koSnap.ball.y.toFixed(1)})` : "없음";
    L.push(
      String(i + 1).padEnd(3) +
        String(g.tick).padEnd(10) +
        String(g.team).padEnd(6) +
        String(koTick).padEnd(8) +
        (koEvt ? "O" : "X").padEnd(7) +
        ballStr.padEnd(16) +
        (ownerOk ? conceding : `${owner?.team ?? "-"}!`).padEnd(6) +
        `${before.maxDev.toFixed(2)}m`.padEnd(14) +
        `${after.maxDev.toFixed(2)}m(${after.matched}/${after.compared})`.padEnd(16) +
        (pass ? "PASS" : "FAIL"),
    );
  });

  // 후반 시작 킥오프.
  L.push("");
  const total = log.tickSnapshots.length;
  const half = Math.floor(total / 2);
  const shEvt = log.events.find((e) => e.type === "kickoff" && !e.detail && e.tick === half);
  const shSnap = byTick.get(half);
  const shTaker = shSnap?.ballOwner ?? null;
  const shBefore = formationDev(byTick.get(half - 1), shTaker);
  const shAfter = formationDev(shSnap, shTaker);
  const shOwner = shSnap?.players.find((p) => p.playerId === shSnap.ballOwner);
  const shBallCentered =
    !!shSnap && Math.abs(shSnap.ball.x - cx) <= TOL && Math.abs(shSnap.ball.y - cy) <= TOL;
  const shPass =
    !!shEvt && shEvt.team === "away" && shBallCentered && shOwner?.team === "away" &&
    shAfter.compared > 0 && shAfter.matched === shAfter.compared;
  if (!shPass) allPass = false;
  L.push(
    `후반 시작(tick ${half}): koEvt=${shEvt ? "O(away)" : "X"} ` +
      `ball=${shSnap ? `(${shSnap.ball.x.toFixed(1)},${shSnap.ball.y.toFixed(1)})` : "없음"} ` +
      `소유=${shOwner?.team ?? "-"} 전dev=${shBefore.maxDev.toFixed(2)}m ` +
      `후dev=${shAfter.maxDev.toFixed(2)}m(${shAfter.matched}/${shAfter.compared}) => ${shPass ? "PASS" : "FAIL"}`,
  );

  // 개시(t0) 킥오프도 크리스프 포메이션(전 선수 슬롯, 테이커만 센터)인지 참고 출력.
  L.push("");
  L.push(`개시(t0) 킥오프: team=home taker=${t0Taker} ball=${t0 ? `(${t0.ball.x.toFixed(1)},${t0.ball.y.toFixed(1)})` : "없음"} (t0 가 기준 슬롯)`);
  L.push("");
  L.push(`결과: ${allPass ? "ALL PASS" : "FAIL"}  (전dev=세리머니 dwell 흩어짐 → 후dev≈0 = 포메이션 리셋 확인)`);
  return { report: L.join("\n"), allPass };
}

/** 데모 SelectData 에서 GK playerId 집합. */
function demoGkIds(): Set<string> {
  const gk = new Set<string>();
  for (const p of demoSelect.home.players) if (p.position === "GK") gk.add(p.playerId);
  for (const p of demoSelect.away.players) if (p.position === "GK") gk.add(p.playerId);
  return gk;
}

/** 데모 입력에서 수비수(back four, base 진행도<=0.25, GK 제외) playerId 집합 — 오버랩 계측용. */
function demoDefenderIds(): Set<string> {
  const def = new Set<string>();
  for (const inp of [demoHome, demoAway]) {
    for (const p of inp.players) {
      if (p.role !== "GK" && p.basePosition.x <= 0.25) def.add(p.playerId);
    }
  }
  return def;
}

/** 리얼 계측용 StatsOptions. */
function statsOpts(): StatsOptions {
  return {
    defenderIds: demoDefenderIds(),
    pitchWidthM: defaultEngineConfig.pitch.width,
    finalThirdLine: defaultEngineConfig.setPiece.finalThirdLine,
  };
}

/**
 * 변주 OFF 기준(baseline) config — 모든 variety 노브 0 + 1대1 부스트 비활성.
 * 이 config 는 engine@0.3.0 최적수렴 동작과 동일해야 한다(변주 전/후 대조 + 회귀 앵커).
 */
const baselineConfig = {
  ...defaultEngineConfig,
  version: "engine@0.9.0-baseline",
  contest: { ...defaultEngineConfig.contest, oneOnOneXgMult: 1 },
  variety: {
    ...defaultEngineConfig.variety,
    dribbleChainProb: 0,
    defenderOverlapProb: 0,
    decisionTemperature: 0,
    roamNoiseAmp: 0,
  },
};

/** 변주 전/후 핵심 지표 대조 리포트(AC-variety.log). */
function buildVarietyReport(before: MatchStats, after: MatchStats, beforeHash: string, afterHash: string): string {
  const sum = (t: MatchStats, k: keyof MatchStats["home"]): number =>
    (t.home[k] as number) + (t.away[k] as number);
  const avg = (t: MatchStats, k: keyof MatchStats["home"]): number =>
    Math.round(((t.home[k] as number) + (t.away[k] as number)) / 2 * 10) / 10;
  const L: string[] = [];
  L.push("=== HMB S1 엔진 변주(다이나믹) 전/후 대조 — AC-variety ===");
  L.push(`before=engine@0.8.0-baseline(변주 OFF)  after=${defaultEngineConfig.version}(변주 ON)  seed ${demoSeed}`);
  L.push(`baseline lastHash=${beforeHash}  (0.8.0 는 골 후/후반/개시 킥오프 포메이션 리셋으로 이전 앵커와 불일치가 정상)`);
  L.push(`variety(after) lastHash=${afterHash}`);
  L.push("");
  const col = (s: string, w: number): string => s.padEnd(w);
  L.push(col("지표(양팀 합/평균)", 26) + col("before", 12) + col("after", 12) + "해석");
  const rowSum = (label: string, k: keyof MatchStats["home"], note: string): void => {
    L.push(col(label, 26) + col(String(sum(before, k)), 12) + col(String(sum(after, k)), 12) + note);
  };
  const rowAvg = (label: string, k: keyof MatchStats["home"], note: string): void => {
    L.push(col(label, 26) + col(String(avg(before, k)), 12) + col(String(avg(after, k)), 12) + note);
  };
  rowAvg("평균 드리블 체인(틱)", "avgDribbleChain", "롱드리블(연속 돌파)");
  rowSum("최대 드리블 체인(틱)", "maxDribbleChain", "");
  rowSum("드리블 체인 수", "dribbleChains", "");
  rowSum("수비 오버랩(횟수)", "defenderOverlaps", "돌발 전진(뒤공간 노출)");
  rowSum("수비 오버랩(player-틱)", "defenderOverlapTicks", "");
  rowAvg("위치 분산(RMS m)", "posSpreadM", "슬롯 고착 완화(로밍)");
  L.push("");
  rowSum("슛(시도)", "shots", "");
  rowSum("유효슛", "onTarget", "세이브 상황↑");
  rowSum("세이브", "savedShots", "");
  rowSum("off_target", "offTargetShots", "");
  rowSum("1대1 찬스", "oneOnOne", "하이라이트");
  rowSum("슛→코너 전환", "shotToCorner", "");
  rowSum("슛→골킥 전환", "shotToGoalKick", "");
  rowSum("코너", "corners", "");
  rowSum("골", "goals", "");
  return L.join("\n");
}

/**
 * AC-rules.log — 축구 규칙(파울/오프사이드/카드/페널티) 경기당 빈도(벤치마크 대조) +
 * 슛 결정 버그 수정의 정량 근거(파이널서드 후진패스 비율·1대1 슛 before/after).
 *
 * before/after 는 ablation: 동일 config 에서 슛-버그 수정 노브(shootInBox·backwardPassPenalty·
 * oneOnOneShootBias)만 중립화(=OFF)한 것과 default(=ON)를 대조 → 수정의 순효과를 격리.
 * 규칙 빈도는 after(=default, 규칙 ON) 기준. 다중 시드 평균으로 분산 완화.
 */
function buildRulesReport(): string {
  const seeds = ["4815162342", "9999999999", "1234567890", "2718281828", "1414213562", "1618033988", "31415926", "27182818", "16180339", "14142135"];
  const c = (arr: MatchEvent[], p: (e: MatchEvent) => boolean): number => arr.filter(p).length;
  const W = defaultEngineConfig.pitch.width;
  const F3 = defaultEngineConfig.setPiece.finalThirdLine;
  const prog = (side: string, x: number): number => (side === "home" ? x / W : 1 - x / W);

  // ablation OFF = 수정 노브 중립화.
  const offConfig = {
    ...defaultEngineConfig,
    decisionWeights: { ...defaultEngineConfig.decisionWeights, shootInBox: 1, backwardPassPenalty: 0 },
    contest: { ...defaultEngineConfig.contest, oneOnOneShootBias: 1 },
  };

  // 스냅샷 소유권 전이로 완결 패스 방향 판정(파이널서드·스트라이커 후진).
  const passDir = (log: MatchLog): { f3: number; f3b: number; sf3: number; sf3b: number } => {
    let f3 = 0, f3b = 0, sf3 = 0, sf3b = 0;
    let lo: string | null = null, lp: { x: number; y: number } | null = null, lt: string | null = null;
    for (const sn of log.tickSnapshots) {
      const o = sn.ballOwner;
      if (o != null) {
        const p = sn.players.find((q) => q.playerId === o);
        const team = p?.team ?? (o[0] === "H" ? "home" : "away");
        if (lo != null && o !== lo && team === lt && lp && p) {
          const pp = prog(team, lp.x), rp = prog(team, p.pos.x);
          const back = rp < pp;
          // passer(lo) 기준: 파이널서드에서 시작한 완결 패스가 후진(수신자가 덜 전진)인가.
          if (pp >= F3) { f3++; if (back) f3b++; }
          if (lo === "H9" || lo === "A9") { if (pp >= F3) { sf3++; if (back) sf3b++; } }
        }
        lo = o; lp = p ? { x: p.pos.x, y: p.pos.y } : { x: sn.ball.x, y: sn.ball.y }; lt = team;
      }
    }
    return { f3, f3b, sf3, sf3b };
  };

  const R = { fouls: 0, offside: 0, yellow: 0, red: 0, pen: 0, saves: 0, freeKick: 0 };
  let bf3 = 0, bf3b = 0, bsf3 = 0, bsf3b = 0, bOne = 0, bShots = 0, bGoals = 0;
  let af3 = 0, af3b = 0, asf3 = 0, asf3b = 0, aOne = 0, aShots = 0, aGoals = 0;
  let redMatches = 0, penMatches = 0;
  for (const s of seeds) {
    const home = makeTacticalInput("H", s);
    const away = makeTacticalInput("A", s);
    const before = runMatch(s, home, away, demoSelect, offConfig);
    const after = runMatch(s, home, away, demoSelect, defaultEngineConfig);
    const bd = passDir(before), ad = passDir(after);
    bf3 += bd.f3; bf3b += bd.f3b; bsf3 += bd.sf3; bsf3b += bd.sf3b;
    af3 += ad.f3; af3b += ad.f3b; asf3 += ad.sf3; asf3b += ad.sf3b;
    const isShot = (e: MatchEvent): boolean => e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target";
    bOne += c(before.events, (e) => e.type === "shot" && e.detail === "one_on_one");
    aOne += c(after.events, (e) => e.type === "shot" && e.detail === "one_on_one");
    bShots += c(before.events, isShot); aShots += c(after.events, isShot);
    bGoals += c(before.events, (e) => e.type === "goal"); aGoals += c(after.events, (e) => e.type === "goal");
    const e = after.events;
    R.fouls += c(e, (x) => x.type === "foul");
    R.offside += c(e, (x) => x.type === "offside");
    R.yellow += c(e, (x) => x.type === "card" && x.detail === "yellow");
    const rd = c(e, (x) => x.type === "card" && x.detail === "red"); R.red += rd; if (rd > 0) redMatches++;
    const pn = c(e, (x) => x.type === "penalty"); R.pen += pn; if (pn > 0) penMatches++;
    R.saves += c(e, (x) => x.type === "save");
    R.freeKick += c(e, (x) => x.type === "free_kick");
  }
  const n = seeds.length;
  const pct = (x: number, y: number): string => (y > 0 ? ((x / y) * 100).toFixed(1) + "%" : "n/a");
  const per = (v: number): string => (v / n).toFixed(2);
  const col = (s: string, w: number): string => s.padEnd(w);
  const L: string[] = [];
  L.push(`=== HMB S1 엔진 축구 규칙 + 슛 버그 수정 — AC-rules (${defaultEngineConfig.version}, ${n} seeds) ===`);
  L.push("");
  L.push("── 슛 결정 버그 수정 (ablation: 수정 노브 OFF vs ON) ──");
  L.push(col("지표", 30) + col("before(OFF)", 14) + col("after(ON)", 14) + "해석");
  L.push(col("스트라이커 파이널서드 후진패스", 30) + col(pct(bsf3b, bsf3), 14) + col(pct(asf3b, asf3), 14) + "버그: 좋은 위치서 후진 → 감소");
  L.push(col("전체 파이널서드 후진패스", 30) + col(pct(bf3b, bf3), 14) + col(pct(af3b, af3), 14) + "");
  L.push(col("1대1 슛 (경기당)", 30) + col(per(bOne), 14) + col(per(aOne), 14) + "단독찬스 슛 전환↑ (벤치 팀1-3.5)");
  L.push(col("슛 (경기당, 양팀)", 30) + col(per(bShots), 14) + col(per(aShots), 14) + "");
  L.push(col("골 (경기당, 양팀)", 30) + col(per(bGoals), 14) + col(per(aGoals), 14) + "");
  L.push("");
  L.push("── 규칙 이벤트 빈도 (after=default, 규칙 ON) ──");
  L.push(col("이벤트", 20) + col("경기당(양팀)", 16) + col("팀당", 12) + "벤치마크(양팀 / 팀)");
  L.push(col("파울", 20) + col(per(R.fouls), 16) + col(per(R.fouls / 2), 12) + "22-24 / 11-12");
  L.push(col("오프사이드", 20) + col(per(R.offside), 16) + col(per(R.offside / 2), 12) + "- / 1-3");
  L.push(col("옐로카드", 20) + col(per(R.yellow), 16) + col(per(R.yellow / 2), 12) + "3.5-4 / ~2");
  L.push(col("레드카드", 20) + col(per(R.red), 16) + col(per(R.red / 2), 12) + `0.1-0.2 (${redMatches}/${n} 경기)`);
  L.push(col("페널티", 20) + col(per(R.pen), 16) + col(per(R.pen / 2), 12) + `0.2-0.3 (${penMatches}/${n} 경기)`);
  L.push(col("세이브(GK)", 20) + col(per(R.saves), 16) + col(per(R.saves / 2), 12) + "-");
  L.push(col("프리킥(파울+오프사이드)", 20) + col(per(R.freeKick), 16) + col(per(R.freeKick / 2), 12) + "~24 / ~12");
  L.push("");
  L.push("주: 공간 엔진은 공격수 온사이드 런 타이밍을 모델링하지 않아 대부분의 전진 패스가 기하학적으로");
  L.push("   라인 앞이므로, 오프사이드는 config(rules.offside.callProb)로 실제 리그 빈도에 맞춘 호출 게이트를 둔다.");
  return L.join("\n");
}

/**
 * MatchLog 를 dev-viewer/match-log.json 으로 저장하고, 매치 스탯을
 * evidence/S1/AC-stats-v2.log 로 저장한다. 벤치마크 대조 스탯을 summary 로 반환.
 */
export function writeDemo(outPath?: string): { path: string; statsPath: string; summary: Record<string, unknown> } {
  // 뷰어용은 쇼케이스(짧게+골↑), 스탯 증빙은 리얼 config 로 계측.
  const showcase = buildShowcaseLog();
  const log = buildDemoLog(); // 리얼 config — 벤치마크 대조 스탯용
  const here = dirname(fileURLToPath(import.meta.url));
  const path = outPath ?? join(here, "match-log.json");
  writeFileSync(path, JSON.stringify(showcase));

  // 매치 스탯 계측(리얼 config) → evidence/S1/AC-stats-v2.log.
  const opts = statsOpts();
  const stats = computeMatchStats(log, demoGkIds(), opts);
  const report = formatStatsReport(stats, {
    configVersion: log.configVersion,
    seed: log.seed,
    finalScore: log.finalScore,
  });
  const repoRoot = join(here, "..", "..", "..");
  const evidenceDir = join(repoRoot, "evidence", "S1");
  mkdirSync(evidenceDir, { recursive: true });
  const statsPath = join(evidenceDir, "AC-stats-v2.log");
  writeFileSync(statsPath, report + "\n");

  // 변주 전/후 대조(baseline=변주 OFF vs default=변주 ON) → evidence/S1/AC-variety.log.
  const baseLog = runMatch(demoSeed, demoHome, demoAway, demoSelect, baselineConfig);
  const baseStats = computeMatchStats(baseLog, demoGkIds(), opts);
  const baseHash = baseLog.tickSnapshots[baseLog.tickSnapshots.length - 1]?.hash ?? "";
  const afterHash = log.tickSnapshots[log.tickSnapshots.length - 1]?.hash ?? "";
  const varietyPath = join(evidenceDir, "AC-variety.log");
  writeFileSync(varietyPath, buildVarietyReport(baseStats, stats, baseHash, afterHash) + "\n");

  // 골 검증(AC-goal-in-net): 쇼케이스(골 많음)+리얼 두 로그 모두 계측 → evidence/S1/AC-goal-in-net.log.
  const showGoals = buildGoalInNetReport(showcase, "showcase(viewer)");
  const realGoals = buildGoalInNetReport(log, "real(default)");
  const goalNetPath = join(evidenceDir, "AC-goal-in-net.log");
  writeFileSync(goalNetPath, `${showGoals.report}\n\n${realGoals.report}\n`);

  // 슛 도착 검증(AC-shot-target): 슛→세이브/빗맞음 도착이 골문 근처인지 + 코너 순간이동 0건 검증.
  const showShots = buildShotTargetReport(showcase, "showcase(viewer, seed 4815162342)");
  const realShots = buildShotTargetReport(log, "real(default)");
  const shotTargetPath = join(evidenceDir, "AC-shot-target.log");
  writeFileSync(shotTargetPath, `${showShots.report}\n\n${realShots.report}\n`);

  // 축구 규칙 빈도 + 슛 버그 수정 근거(다중 시드) → evidence/S1/AC-rules.log.
  const rulesPath = join(evidenceDir, "AC-rules.log");
  writeFileSync(rulesPath, buildRulesReport() + "\n");

  // 킥오프 검증(AC-kickoff): 골 후/후반/개시 킥오프 이벤트 + 포메이션 리셋(전/후) + 공 센터·실점팀 소유.
  const showKick = buildKickoffReport(showcase, "showcase(viewer, 골 많음)");
  const realKick = buildKickoffReport(log, "real(default)");
  const kickoffPath = join(evidenceDir, "AC-kickoff.log");
  writeFileSync(kickoffPath, `${showKick.report}\n\n${realKick.report}\n`);

  const summary = {
    configVersion: log.configVersion,
    seed: log.seed,
    ticks: log.tickSnapshots.length,
    finalScore: log.finalScore,
    events: log.events.length,
    goals: log.events.filter((e) => e.type === "goal").length,
    // 슛 킥 이벤트만(off_target/saved 결과 이벤트 제외; one_on_one 포함).
    shots: log.events.filter((e) => e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target").length,
    oneOnOne: log.events.filter((e) => e.type === "shot" && e.detail === "one_on_one").length,
    corners: log.events.filter((e) => e.type === "kickoff" && e.detail === "corner").length,
    throwIns: log.events.filter((e) => e.type === "kickoff" && e.detail === "throw_in").length,
    goalKicks: log.events.filter((e) => e.type === "kickoff" && e.detail === "goal_kick").length,
    home: stats.home,
    away: stats.away,
    lastHash: log.tickSnapshots[log.tickSnapshots.length - 1]?.hash,
  };
  return { path, statsPath, summary };
}

// Node 22+ 에서 직접 실행되면 파일을 생성.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { path, summary } = writeDemo();
  // eslint-disable-next-line no-console
  console.log(`[generate-demo] wrote ${path}\n${JSON.stringify(summary, null, 2)}`);
}

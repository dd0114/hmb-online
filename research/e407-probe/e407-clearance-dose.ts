/**
 * #407 0.44.0 — **결판 프로브**: 걷어내기(밴드 5–12.5)와 다양성(HHI)이 **같은 용량에서** 만족되는
 * 지점이 있는가. 분석 전용, 프로덕션 무수정.
 *
 * 배경: `.05` 팔이 걷어내기를 4.25 로 밀어 `behaviour.test.ts` ⓐ 를 red 로 만든다(기준선 green).
 * 값이 용량을 따라 움직이므로(3.66 @.2 · 4.25 @.05) **용량 의존 = 우리 책임**이다.
 * 판정 기준(매니저): **걷어내기 ≥5.0 이면서 HHI ≤0.884**(기준선 0.904 대비 −0.02) 인 용량이 있으면
 * 그것이 팔이고, 없으면 **이 노브 계열에서 출하하지 않는다**.
 *
 * ⚠️ 걷어내기는 `behaviour.test.ts` 와 **같은 자**(`measureBehaviour`·같은 시드 수)로 잰다.
 */
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config";
import { applyConfigOverrides } from "../../packages/engine/src/realism/config-override";
import { REALISM_SEEDS } from "../../packages/engine/src/realism/harness";
import { runMatch } from "../../packages/engine/src/match";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures";
import { measureBehaviour, aggregateBehaviour } from "../../packages/engine/src/realism/behaviour";
import { reconstructTransfers } from "../../packages/engine/src/realism/deepen";
import type { MatchLog, TickSnapshot } from "@hmb/shared";

const select = makeSelectData();
const SEEDS = REALISM_SEEDS.slice(0, 16); // behaviour.test.ts 와 같은 표본
const ROLES = ["GK","LB","LCB","RCB","RB","LCM","CM","RCM","LW","ST","RW"];
const roleOf = (id: string): string => ROLES[Number(id.slice(1))] ?? "?";

function run(ov: Record<string, unknown>): Record<string, number> {
  const cfg = Object.keys(ov).length
    ? (applyConfigOverrides(defaultEngineConfig, ov as never) as EngineConfig)
    : defaultEngineConfig;
  const W = cfg.pitch.width, H = cfg.pitch.height;
  const bd = cfg.rules.penalty.boxDepthM, bh = cfg.rules.penalty.boxHalfWidthM;
  const logs: MatchLog[] = SEEDS.map((s) =>
    runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, cfg));
  const beh = aggregateBehaviour(logs.map((l) => measureBehaviour(l, W)));
  let shots = 0, boxRecv = 0, stBoxRecv = 0;
  const byRole = new Map<string, number>();
  for (const log of logs) {
    const byTick = new Map<number, TickSnapshot>();
    for (const sn of log.tickSnapshots) byTick.set(sn.tick, sn);
    for (const e of log.events) {
      if (e.type !== "shot" || e.detail === "saved" || e.detail === "off_target") continue;
      if (!byTick.get(e.tick) || !e.playerId) continue;
      shots++; const r = roleOf(e.playerId);
      byRole.set(r, (byRole.get(r) ?? 0) + 1);
    }
    for (const t of reconstructTransfers(log, W)) {
      if (!t.completed) continue;
      const prog = t.fromSide === "home" ? t.recvX : W - t.recvX;
      if (prog < W - bd || Math.abs(t.recvY - H / 2) > bh) continue;
      boxRecv++; if (roleOf(t.toId) === "ST") stBoxRecv++;
    }
  }
  let hhi = 0;
  for (const n of byRole.values()) { const s = n / (shots || 1); hhi += s * s; }
  return {
    clearances: beh.clearances,
    shotHHI: hhi,
    boxSTPct: (stBoxRecv / (boxRecv || 1)) * 100,
    boxRecv: boxRecv / (SEEDS.length * 2),
  };
}

const ARMS: { label: string; ov: Record<string, unknown> }[] = [
  // ⚠️ **`ov: {}` 를 기준선으로 쓰면 안 된다** — 이 프로브는 작업 트리에서 도는데 그 트리의
  // `defaultEngineConfig` 는 **이미 0.44.0 팔**이다(그래서 `{}` 는 출하 팔과 같은 값을 낸다).
  // 기준선은 **구 값을 명시적으로 주입**해서 만든다.
  { label: "BASE(0.43.0 구값)", ov: {
    "variety.defenderOverlapProb": 0.1, "variety.overlapBaseLine": 0.4, "rules.foul.base": 0.135 } },
  { label: "출하 팔(현 트리)", ov: {} },
  ...[0.02, 0.03, 0.05, 0.10, 0.20].map((p) => ({
    label: `prob ${p} /.45/f.22`,
    ov: { "variety.defenderOverlapProb": p, "variety.overlapBaseLine": 0.45, "rules.foul.base": 0.22 },
  })),
];
console.log(`# 걷어내기 x 다양성 — 시드 ${SEEDS.length}(behaviour.test.ts 와 동일 표본), engine@${defaultEngineConfig.version}`);
console.log("팔".padEnd(24) + "걷어내기".padStart(12) + "슛HHI".padStart(10) + "박스ST%".padStart(10) + "박스수신".padStart(10) + "  판정");
for (const a of ARMS) {
  const m = run(a.ov);
  const ok = m.clearances >= 5.0 && m.shotHHI <= 0.884;
  console.log(
    a.label.padEnd(24) + m.clearances.toFixed(2).padStart(12) + m.shotHHI.toFixed(3).padStart(10) +
    m.boxSTPct.toFixed(1).padStart(10) + m.boxRecv.toFixed(2).padStart(10) +
    "  " + (a.ov.__proto__ && Object.keys(a.ov).length === 0 ? "(기준선)" : ok ? "✅ 둘 다 만족" : `❌ ${m.clearances < 5 ? "걷어내기<5.0" : ""}${m.clearances < 5 && m.shotHHI > 0.884 ? " + " : ""}${m.shotHHI > 0.884 ? "HHI>0.884" : ""}`),
  );
}

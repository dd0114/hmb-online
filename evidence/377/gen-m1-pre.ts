/**
 * #377 M1-pre 관전 증거 생성기 (#349 재시작 킥 강제 + 프리킥 벽 · #347 킥오프 Law 8).
 *
 * 실행:
 *   npx tsx evidence/377/gen-m1-pre.ts
 * 산출:
 *   evidence/377/m1-pre-match.json   ← 뷰어/하네스로 바로 재생하는 경기 로그
 *   (표는 stdout — evidence/377/M1-pre.md 의 타임스탬프가 이 출력이다)
 *
 * 재생법(뷰어):
 *   cd packages/engine/dev-viewer && node build-standalone.mjs && open viewer-standalone.html
 *   → 뷰어 콘솔에서 `__viewer.seek(<틱>)` (또는 QA 콘솔 탭에 이 로그를 주입)
 *
 * 결정론: 시드·config 고정이라 누가 언제 돌려도 **같은 경기**가 나온다. 아래 틱은 그 경기의 좌표다.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runMatch } from "../../packages/engine/src/match.ts";
import { defaultEngineConfig } from "../../packages/engine/src/config.ts";
import { demoHome, demoAway, demoSelect } from "../../packages/engine/src/fixtures.ts";
import { createPitch } from "../../packages/engine/src/pitch.ts";
import { computeSetPiecePlan, freeKickWallCount } from "../../packages/engine/src/setpiece.ts";
import { deadBallZone } from "../../packages/engine/src/deadball.ts";
import { setDecisionObserver } from "../../packages/engine/src/action.ts";
import { playerKey, type SimState, type SimPlayer } from "../../packages/engine/src/simstate.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** #347/#349 계약 테스트와 같은 데모 픽스처. 34 = 골 7 · PK 3 (관전거리 최다). */
const SEED = "34";
const cfg = defaultEngineConfig;
const pitch = createPitch(cfg);
const S = cfg.fixedScale;

/** 재시작 재개 관측 — 엔진이 **실제로 고른 행동**을 결정 직후에 읽는다(좌표 되추론 금지). */
interface Restart {
  tick: number;
  kind: string;
  action: string;
  side: string;
  /** 프리킥이면: 매핑 요구 벽 인원 / 그 자리에 실제로 서 있던 인원. */
  wallWant?: number;
  wallStanding?: number;
}
const restarts: Restart[] = [];

setDecisionObserver((raw, _o: SimPlayer, kind) => {
  const st = raw as SimState;
  const sp = st.setPiece;
  if (!sp || kind === "hold") return;
  if (!["free_kick", "throw_in", "goal_kick", "kickoff"].includes(sp.kind)) return;
  const r: Restart = { tick: st.tick, kind: sp.kind, action: kind as string, side: sp.side };
  if (sp.kind === "free_kick") {
    const plan = computeSetPiecePlan(st, pitch, cfg, sp, deadBallZone(st, cfg, pitch));
    r.wallWant = freeKickWallCount(pitch, cfg, sp.side, sp.x, sp.y);
    let standing = 0;
    if (plan) {
      const tol = 2.5 * S;
      for (const p of st.players) {
        const slot = plan.slots.get(playerKey(p.side, p.id));
        if (!slot || slot.role !== "wall") continue;
        if (Math.hypot(p.posFx.x - slot.x, p.posFx.y - slot.y) <= tol) standing++;
      }
    }
    r.wallStanding = standing;
  }
  restarts.push(r);
});

const log = runMatch(SEED, demoHome, demoAway, demoSelect, cfg);
setDecisionObserver(null);
writeFileSync(join(here, "m1-pre-match.json"), JSON.stringify(log));

/** 틱 → 화면 표기 시각(m:ss). 뷰어 시계와 같은 스케일(displayMinutes). */
const disp = (tick: number): string => {
  const scale = (cfg.displayMinutes ?? cfg.matchMinutes) / cfg.matchMinutes;
  const sec = Math.round(((tick * cfg.msPerTick) / 1000) * scale);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
const HALF = cfg.pitch.width / 2;
/** 킥오프 틱의 상대 진영 침범 인원(taker 제외) — Law 8. */
const intruders = (tick: number): number => {
  const s = byTick.get(tick);
  if (!s) return -1;
  return s.players.filter(
    (p) => p.playerId !== s.ballOwner && (p.team === "home" ? p.pos.x - HALF : HALF - p.pos.x) > 0.01,
  ).length;
};

const kickoffs = log.events.filter((e) => e.type === "kickoff" && !e.detail);
const fks = restarts.filter((r) => r.kind === "free_kick");
const counts: Record<string, number> = {};
for (const r of restarts) counts[`${r.kind}:${r.action}`] = (counts[`${r.kind}:${r.action}`] ?? 0) + 1;

console.log(`# M1-pre 관전 증거 — seed ${SEED} · ${log.configVersion} · 최종 ${log.finalScore.home}:${log.finalScore.away}`);
console.log(`\n## 재시작 재개 방식 (전 ${restarts.length}건) — 드리블/홀드가 0 이어야 한다 (#349)`);
for (const k of Object.keys(counts).sort()) console.log(`  ${k.padEnd(22)} ${counts[k]}`);

console.log(`\n## 프리킥 — 킥으로 재개 + 벽이 실제로 서 있다 (앞 8건)`);
console.log(`  ${"틱".padStart(5)}  ${"시각".padStart(5)}  재개행동   벽(요구/도착)`);
for (const r of fks.slice(0, 8)) {
  console.log(`  ${String(r.tick).padStart(5)}  ${disp(r.tick).padStart(5)}  ${r.action.padEnd(9)}  ${r.wallWant}/${r.wallStanding}`);
}

console.log(`\n## 킥오프 — 전원 자기 진영 (Law 8, #347)`);
console.log(`  ${"틱".padStart(5)}  ${"시각".padStart(5)}  재개팀   상대진영 침범`);
for (const e of kickoffs) {
  console.log(`  ${String(e.tick).padStart(5)}  ${disp(e.tick).padStart(5)}  ${(e.team ?? "-").padEnd(7)}  ${intruders(e.tick)}명`);
}

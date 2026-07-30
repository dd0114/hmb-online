import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { REALISM_SEEDS, aggregateRealism } from "./harness";
import { aggregateDeepen } from "./deepen";
import { BENCH, benchVerdict } from "./bench";
import { collectChainProbe, renderChainProbe } from "./chain-probe";

/**
 * #279 W2 — **볼 소유자 결정 코어 A/B 비교**(env 가드). npm test 에서는 skip.
 * 실행: HMB_CHAIN=1 npx vitest run packages/engine/src/realism/chain-compare.test.ts
 * → research/engine-chain-compare.data.md 갱신 + 콘솔 요약.
 *
 * 같은 시드·같은 나머지 config 로 `chain.mode` 만 바꿔 돌린다. 오프더볼·경합·공 물리는 동일하므로
 * 차이는 **전적으로 볼 소유자 결정**에서 온다.
 */

const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_CHAIN;
const SEEDS = REALISM_SEEDS.slice(0, Number((process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_CHAIN_SEEDS ?? 20));

function withChain(base: EngineConfig): EngineConfig {
  return { ...base, chain: { ...base.chain, mode: "chain" } };
}

/**
 * engine@0.24.0 부터 **기본값이 chain** 이다(#279 채택). 그래서 대조군은 `defaultEngineConfig`
 * 를 그대로 쓰면 안 된다 — 그러면 양쪽이 같은 코어가 되어 전 지표가 동일해지고(실측: lastHash
 * 까지 같아짐) A/B 표가 조용히 무의미해진다. 대조군은 **명시적으로 weighted** 로 되돌린다.
 */
function withWeighted(base: EngineConfig): EngineConfig {
  return { ...base, chain: { ...base.chain, mode: "weighted" } };
}

function f(v: number, d = 2): string {
  return (Math.round(v * 10 ** d) / 10 ** d).toString();
}

describe("#279 W2 chain-vs-weighted", () => {
  it.skipIf(!GEN)("compares both ball-owner decision cores on identical seeds", () => {
    const weighted = withWeighted(defaultEngineConfig);
    const chain = withChain(defaultEngineConfig);
    // 대조가 실제로 두 코어를 비교하고 있는지 자체 검사(기본값이 또 바뀌어도 조용히 안 깨지게).
    expect(weighted.chain.mode).toBe("weighted");
    expect(chain.chain.mode).toBe("chain");

    // 성능 비교용 타이머(테스트 파일이라 하이진 스캔 대상 아님, 결정론에도 영향 없음).
    const hr = (process as unknown as { hrtime: { bigint: () => bigint } }).hrtime;
    const t0 = hr.bigint();
    const bw = aggregateRealism(weighted, SEEDS);
    const t1 = hr.bigint();
    const bc = aggregateRealism(chain, SEEDS);
    const t2 = hr.bigint();
    const dw = aggregateDeepen(weighted, SEEDS);
    const dc = aggregateDeepen(chain, SEEDS);

    const L: string[] = [];
    L.push(`## 벤치 대조 (팀·경기, 시드 ${SEEDS.length})`);
    L.push(`| 지표 | weighted(현행) | **chain(신)** | 벤치 | weighted 판정 | chain 판정 |`);
    L.push(`|---|---|---|---|---|---|`);
    for (const b of BENCH) {
      const vw = b.key === "goalsPerMatch" ? bw.goalsPerMatch : bw.mean[b.key];
      const vc = b.key === "goalsPerMatch" ? bc.goalsPerMatch : bc.mean[b.key];
      L.push(
        `| ${b.label} | ${f(vw)} | **${f(vc)}** | ${b.lo}–${b.hi}${b.unit ?? ""} | ${benchVerdict(vw, b)} | ${benchVerdict(vc, b)} |`,
      );
    }
    L.push("");
    L.push(`## 구조 지표 (#279 진단 축)`);
    L.push(`| 지표 | weighted | **chain** | 벤치/기준 |`);
    L.push(`|---|---|---|---|`);
    const row = (label: string, a: number, b: number, bench: string): void => {
      L.push(`| ${label} | ${f(a)} | **${f(b)}** | ${bench} |`);
    };
    row("다이렉트 스피드(m/s)", dw.mean.directSpeedMs, dc.mean.directSpeedMs, "PL 1.4–2.1");
    row("시퀀스 인플레이 길이(초)", dw.mean.seqInPlayS, dc.mean.seqInPlayS, "10–16");
    row("시퀀스당 패스", dw.mean.seqPasses, dc.mean.seqPasses, "City 5.1");
    row("시퀀스당 전진(m)", dw.mean.seqProgressM, dc.mean.seqProgressM, "~14");
    row("백패스 %(결과)", dw.mean.backwardPct, dc.mean.backwardPct, "PL 12–18");
    row("백패스 %(의도)", dw.mean.xc.intentBackwardPct, dc.mean.xc.intentBackwardPct, "—");
    row("파이널서드 백패스 %", dw.mean.backPctFinal, dc.mean.backPctFinal, "—");
    row("전진 후보 0개 %", dw.mean.noForwardOptPct, dc.mean.noForwardOptPct, "—");
    row("슛 횡offset p50(m)", dw.mean.xc.shotLatP50, dc.mean.xc.shotLatP50, "박스폭 40.3");
    row("슛 횡offset p90(m)", dw.mean.xc.shotLatP90, dc.mean.xc.shotLatP90, "—");
    row("슛 셀 엔트로피(bit)", dw.mean.shotCellEntropyBits, dc.mean.shotCellEntropyBits, "최대 3.17");
    row("시퀀스 상위5 토큰 %", dw.mean.seqTop5Pct, dc.mean.seqTop5Pct, "낮을수록 다양");
    row("라인 뒤 수신(회)", dw.mean.inBehindPasses, dc.mean.inBehindPasses, "—");
    row("볼 10m 안 수비수", dw.mean.def.pressWithin10, dc.mean.def.pressWithin10, "1+2~3");
    row("태클 이벤트", dw.mean.xc.tackleEvents, dc.mean.xc.tackleEvents, "PL 15–20");
    row("소유 이전 수", dw.mean.passes, dc.mean.passes, "—");
    L.push("");
    // #279 S2 — 생성기별 생성/채택 분포. S5 에서 생성기를 늘렸는데 지표가 안 움직일 때
    // "생성이 0인가, 채택이 0인가"를 **추측하지 않고** 여기서 읽는다.
    L.push(`## 생성기 계측 (chain 코어, 시드 ${SEEDS.length})`);
    L.push(renderChainProbe(collectChainProbe(chain, SEEDS)));
    L.push("");
    const msW = Number(t1 - t0) / 1e6 / SEEDS.length;
    const msC = Number(t2 - t1) / 1e6 / SEEDS.length;
    // ⚠️ 시뮬 시간은 **파일 본문에 넣지 않는다** — 재실행마다 달라져(CPU 경합·머신 상태) 생성물 커밋에
    // 매번 diff 가 나고, "이 파일이 현재 코드로 재현되는가" 검사를 방해한다(독립 검증 M7).
    // 성능은 콘솔로만 흘리고, 판단이 필요하면 **단독 실행으로 교대 측정**해야 한다(경합 시 무의미).
    // eslint-disable-next-line no-console
    console.log(`[perf · 파일에 기록 안 함] weighted ${f(msW, 0)}ms · chain ${f(msC, 0)}ms (×${f(msC / msW)})`);
    L.push(`- lastHash: weighted \`${bw.lastHash}\` · chain \`${bc.lastHash}\` · config \`${defaultEngineConfig.version}\``);

    const text = L.join("\n");
    // eslint-disable-next-line no-console
    console.log(`\n=== #279 CHAIN A/B (${SEEDS.length} seeds) ===\n${text}\n`);
    writeFileSync(
      join(process.cwd(), "research", "engine-chain-compare.data.md"),
      `<!-- generated by chain-compare.test.ts · ${defaultEngineConfig.version} · ${SEEDS.length} seeds -->\n\n${text}\n`,
    );
    expect(bc.teamMatches).toBe(SEEDS.length * 2);
  }, 1_800_000);
});

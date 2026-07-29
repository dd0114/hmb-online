import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultEngineConfig } from "../config";
import { REALISM_SEEDS } from "./harness";
import { aggregateDeepen, type DeepenAgg } from "./deepen";

/**
 * #279 W1 심화 진단 리포트 생성기(env 가드). npm test 에서는 skip.
 * 실행: HMB_DEEPEN=1 npx vitest run packages/engine/src/realism/deepen-report.test.ts
 * → research/engine-deepen-diag.data.md 갱신 + 콘솔 요약.
 */

const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_DEEPEN;

function f(v: number, d = 2): string {
  return (Math.round(v * 10 ** d) / 10 ** d).toString();
}

function body(a: DeepenAgg): string {
  const m = a.mean;
  const s = a.sd;
  const L: string[] = [];
  const row = (label: string, v: number, sd: number, bench: string, note = ""): void => {
    L.push(`| ${label} | ${f(v)} | ${f(sd)} | ${bench} | ${note} |`);
  };
  L.push(`### A. 패스 방향 · 백패스 (팀·경기)`);
  L.push(`| 지표 | 엔진 | ±SD | 벤치/기준 | 비고 |`);
  L.push(`|---|---|---|---|---|`);
  row("소유이전(패스) 수", m.passes, s.passes, "—", "완결+턴오버, 데드볼 제외");
  row("전진 패스 %", m.forwardPct, s.forwardPct, "—", ">+2m");
  row("횡 패스 %", m.lateralPct, s.lateralPct, "—", "±2m");
  row("**백패스 %**", m.backwardPct, s.backwardPct, "PL ~12–18%", "<−2m");
  row("백패스 중 GK 행 %", m.backToGkPct, s.backToGkPct, "—", "");
  row("자기 진영 백패스율 %", m.backPctOwn, s.backPctOwn, "—", "");
  row("중원 백패스율 %", m.backPctMid, s.backPctMid, "—", "");
  row("파이널서드 백패스율 %", m.backPctFinal, s.backPctFinal, "—", "backwardPassPenalty 적용 구간");
  row("전진 패스 평균 전진(m)", m.fwdGainM, s.fwdGainM, "—", "");
  row("프로그레시브 패스(≥10m)", m.progressive, s.progressive, "PL ~35–55", "완결만");
  row("수신 라인 DEF %", m.toDefPct, s.toDefPct, "—", "");
  row("수신 라인 MID %", m.toMidPct, s.toMidPct, "—", "");
  row("수신 라인 FWD %", m.toFwdPct, s.toFwdPct, "—", "");
  row("수신 GK %", m.toGkPct, s.toGkPct, "—", "");
  L.push("");
  L.push(`### B. 의사결정 — 옵션이 애초에 생기는가 (엔진 passOptions/scoreOption 직접 호출)`);
  L.push(`| 지표 | 엔진 | ±SD | 해석 |`);
  L.push(`|---|---|---|---|`);
  L.push(`| 패스 시점 평균 후보 수 | ${f(m.optAll)} | ${f(s.optAll)} | 인식반경(33m) 안 동료 + 롱 후보 |`);
  L.push(`| 그중 전진(>+2m) 후보 | ${f(m.optForward)} | ${f(s.optForward)} | |`);
  L.push(`| 그중 후진(<−2m) 후보 | ${f(m.optBackward)} | ${f(s.optBackward)} | |`);
  L.push(`| **전진 후보 0개인 시점 %** | ${f(m.noForwardOptPct)} | ${f(s.noForwardOptPct)} | 크면 "전진 각이 구조적으로 안 난다" |`);
  L.push(`| **점수 argmax 가 후진인 시점 %** | ${f(m.argmaxBackwardPct)} | ${f(s.argmaxBackwardPct)} | 크면 "옵션은 있는데 점수가 뒤를 고른다" |`);
  L.push(`| 전진옵션 평균점수 − 후진옵션 평균점수 | ${f(m.scoreFwdMinusBack)} | ${f(s.scoreFwdMinusBack)} | 음수 = 후진이 구조적 우위 |`);
  L.push("");
  L.push(`### C. 공간 · 스루패스`);
  L.push(`| 지표 | 엔진 | ±SD | 벤치/기준 |`);
  L.push(`|---|---|---|---|`);
  L.push(`| **라인 브레이크 수신(수비 라인 뒤에서 잡은 완결 패스)** | ${f(m.inBehindPasses)} | ${f(s.inBehindPasses)} | 스루패스 ~1–3/팀 |`);
  L.push(`| 공을 향해 달려간 거리 p50 (m) | ${f(m.runOntoP50)} | ${f(s.runOntoP50)} | 리드패스 폭 |`);
  L.push(`| 공을 향해 달려간 거리 p90 (m) | ${f(m.runOntoP90)} | ${f(s.runOntoP90)} | |`);
  L.push(`| 공격 시 상대 라인 뒤 우리 선수(평균 인원) | ${f(m.runnersBeyondLine)} | ${f(s.runnersBeyondLine)} | 침투 러너 상시성 |`);
  L.push("");
  L.push(`### D. 시퀀스(단조로움)`);
  L.push(`| 지표 | 엔진 | ±SD | 벤치 |`);
  L.push(`|---|---|---|---|`);
  L.push(`| 시퀀스 수 | ${f(m.sequences)} | ${f(s.sequences)} | — |`);
  L.push(`| 시퀀스 길이(전체 틱) | ${f(m.seqTicks)} | ${f(s.seqTicks)} | 데드볼 포함 |`);
  L.push(`| **시퀀스 인플레이 길이(초)** | ${f(m.seqInPlayS)} | ${f(s.seqInPlayS)} | 오픈플레이 ~10–16s |`);
  L.push(`| 시퀀스당 패스 | ${f(m.seqPasses)} | ${f(s.seqPasses)} | 소유당 ~10.9 이벤트 |`);
  L.push(`| 시퀀스당 전진(m) | ${f(m.seqProgressM)} | ${f(s.seqProgressM)} | ~14 m |`);
  L.push(`| 시퀀스 시작 거리(자기골에서 m) | ${f(m.seqStartM)} | ${f(s.seqStartM)} | Opta 39.5–46.2 |`);
  L.push(`| **다이렉트 스피드(m/s 전진)** | ${f(m.directSpeedMs)} | ${f(s.directSpeedMs)} | **Opta PL 1.4–2.1** |`);
  L.push(`| 시퀀스 (시작셀→끝셀) 엔트로피(bit) | ${f(m.seqEntropyBits)} | ${f(s.seqEntropyBits)} | 최대 ~6.5(81토큰) |`);
  L.push(`| 상위 5 토큰 점유율 % | ${f(m.seqTop5Pct)} | ${f(s.seqTop5Pct)} | 크면 같은 장면 반복 |`);
  L.push(`| 슛 출발 셀 엔트로피(bit) | ${f(m.shotCellEntropyBits)} | ${f(s.shotCellEntropyBits)} | 최대 ~3.17(9셀) |`);
  L.push("");
  L.push(`### E. 수비`);
  L.push(`| 지표 | 엔진 | ±SD | 벤치/기준 |`);
  L.push(`|---|---|---|---|`);
  const d = m.def, ds = s.def;
  L.push(`| 볼 5m 안 수비수(평균) | ${f(d.pressWithin5)} | ${f(ds.pressWithin5)} | 1명 압박 + 커버 |`);
  L.push(`| 볼 10m 안 수비수(평균) | ${f(d.pressWithin10)} | ${f(ds.pressWithin10)} | |`);
  L.push(`| **10m 안 아무도 없는 틱 %** | ${f(d.noPressurePct)} | ${f(ds.noPressurePct)} | 무압박 방치 |`);
  L.push(`| 수비 라인 높이(자기골에서 m) | ${f(d.lineHeightM)} | ${f(ds.lineHeightM)} | 미드블록 ~35–45m |`);
  L.push(`| 라인 높이 SD(m) | ${f(d.lineHeightSd)} | ${f(ds.lineHeightSd)} | |`);
  L.push(`| **라인 틱간 이동(m/tick)** | ${f(d.lineStepM)} | ${f(ds.lineStepM)} | 유닛으로 오르내리나 |`);
  L.push(`| 우리 라인 뒤 상대 공격수(평균 인원) | ${f(d.attackersBehindLine)} | ${f(ds.attackersBehindLine)} | 상시 라인 브레이크 |`);
  L.push(`| 수비 변위의 볼 방향 성분 | ${f(d.towardBallFrac)} | ${f(ds.towardBallFrac)} | 1 = 전원 공만 따라감 |`);
  L.push(`| 수비 변위의 자기골 방향 성분 | ${f(d.towardOwnGoalFrac)} | ${f(ds.towardOwnGoalFrac)} | 복귀 성분 |`);
  L.push(`| **PPDA** | ${f(d.ppda)} | ${f(ds.ppda)} | PL ~8–14 |`);
  L.push(`| 수비 액션(태클+인터셉트+파울) | ${f(d.defActions)} | ${f(ds.defActions)} | |`);
  L.push(`| 피슛 시 슈터 최근접 수비 거리 p50(m) | ${f(d.shooterNearestDefM)} | ${f(ds.shooterNearestDefM)} | 압박 밀착도 |`);
  L.push("");
  L.push(`### F. 교차검증 (지표 정의 아티팩트 방지)`);
  L.push(`| 지표 | 엔진 | ±SD | 의미 |`);
  L.push(`|---|---|---|---|`);
  const x = m.xc, xs = s.xc;
  L.push(`| pass 이벤트 | ${f(x.passEvents)} | ${f(xs.passEvents)} | 완결 패스 |`);
  L.push(`| interception 이벤트 | ${f(x.interceptionEvents)} | ${f(xs.interceptionEvents)} | 실패 패스 회수 |`);
  L.push(`| tackle 이벤트 | ${f(x.tackleEvents)} | ${f(xs.tackleEvents)} | PL ~15–20 |`);
  L.push(`| foul 이벤트 | ${f(x.foulEvents)} | ${f(xs.foulEvents)} | PL 11–12 |`);
  L.push(`| shot 이벤트 | ${f(x.shotEvents)} | ${f(xs.shotEvents)} | PL 12–14 |`);
  L.push(`| 소유이전 원인: 완결패스 | ${f(x.transferPass)} | ${f(xs.transferPass)} | |`);
  L.push(`| 소유이전 원인: 인터셉트 | ${f(x.transferIntercept)} | ${f(xs.transferIntercept)} | |`);
  L.push(`| 소유이전 원인: 태클 | ${f(x.transferTackle)} | ${f(xs.transferTackle)} | |`);
  L.push(`| 소유이전 원인: 루즈볼 | ${f(x.transferLoose)} | ${f(xs.transferLoose)} | 이벤트 없는 이전 |`);
  L.push(`| **의도 기준 전진 %** | ${f(x.intentForwardPct)} | ${f(xs.intentForwardPct)} | 선택된 옵션의 forwardGain |`);
  L.push(`| **의도 기준 횡 %** | ${f(x.intentLateralPct)} | ${f(xs.intentLateralPct)} | |`);
  L.push(`| **의도 기준 후진 %** | ${f(x.intentBackwardPct)} | ${f(xs.intentBackwardPct)} | |`);
  L.push(`| 의도 매칭 표본 | ${f(x.intentMatched)} | ${f(xs.intentMatched)} | |`);
  L.push(`| 슛 거리 p50(m) | ${f(x.shotDistP50)} | ${f(xs.shotDistP50)} | shootRange 19 |`);
  L.push(`| 슛 횡offset p50 / p90 (m) | ${f(x.shotLatP50)} / ${f(x.shotLatP90)} | ${f(xs.shotLatP50)} | 중앙 편중도 |`);
  L.push(`| 슛 횡offset SD(m) | ${f(x.shotLatSd)} | ${f(xs.shotLatSd)} | |`);
  L.push(`| 백4 라인 높이(m) | ${f(x.backLineM)} | ${f(xs.backLineM)} | 미드블록 ~30–40 |`);
  L.push(`| 백4 라인 내 산포(m) | ${f(x.backLineSpreadM)} | ${f(xs.backLineSpreadM)} | 작을수록 한 줄 |`);
  L.push(`| **백4 라인 틱간 이동(m/tick)** | ${f(x.backLineStepM)} | ${f(xs.backLineStepM)} | 유닛 이동 속도 |`);
  L.push(`| 인플레이 틱 비율 % | ${f(x.inPlayPct)} | ${f(xs.inPlayPct)} | 벤치 61–64%(55–58분/90) |`);
  L.push(`| 파이널서드 캐리어 중앙편차 p50(m) | ${f(x.carrierLatFinalP50)} | ${f(xs.carrierLatFinalP50)} | 작을수록 중앙 깔때기 |`);
  L.push(`| PPDA 분자(상대 고지대 패스) | ${f(x.ppdaPassesHigh)} | ${f(xs.ppdaPassesHigh)} | |`);
  L.push("");
  L.push(`- 시드 ${a.seeds}개 · 팀-경기 ${a.teamMatches} · lastHash \`${a.lastHash}\` · config \`${defaultEngineConfig.version}\``);
  return L.join("\n");
}

describe("#279 W1 deepen diagnosis", () => {
  it.skipIf(!GEN)("aggregates structural diagnosis over real config seeds", () => {
    const agg = aggregateDeepen(defaultEngineConfig, REALISM_SEEDS);
    const text = body(agg);
    // eslint-disable-next-line no-console
    console.log(`\n=== #279 DEEPEN DIAG (${defaultEngineConfig.version}, ${agg.seeds} seeds) ===\n${text}\n`);
    writeFileSync(
      join(process.cwd(), "research", "engine-deepen-diag.data.md"),
      `<!-- generated by deepen-report.test.ts · ${defaultEngineConfig.version} · ${agg.seeds} seeds -->\n\n${text}\n`,
    );
    expect(agg.teamMatches).toBe(agg.seeds * 2);
  });
});

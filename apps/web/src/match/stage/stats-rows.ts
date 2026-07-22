import type { TeamLiveStats } from "@hmb/viewer-core";

/**
 * 실시간 통계 패널의 행 파생 — **순수 함수**(테스트 대상).
 *
 * ⚠️ 수치 정의는 `@hmb/viewer-core`(= dev-viewer 의 검증된 `stats.mjs`)가 SoT다. 여기서는 **재계산하지
 * 않고 그대로 표시**만 한다. 특히:
 *   · `shots`      = 슛 시도 **총합**
 *   · `onTarget`   = 유효슛(goals + saved) — `shots` 의 **부분집합**
 *   · `offTarget`  = 빗나감 — 역시 부분집합 (`shots === onTarget + offTarget`)
 * 이걸 더하면 시도가 두 번 세어져 QA 뷰어 HUD 와 수치가 갈라진다(실제로 그렇게 틀렸던 적 있음 — #169
 * 독립검증 blocker-1). 대조 테스트 = `stats-rows.test.ts`.
 */
export interface StatRow {
  key: string;
  label: string;
  home: string;
  away: string;
  /** 좌/우 막대 비율 계산용 원시값. */
  hv: number;
  av: number;
}

export function statRows(home: TeamLiveStats, away: TeamLiveStats): StatRow[] {
  return [
    {
      key: "shots",
      // QA 뷰어 HUD 의 "Shots" + "On target" 두 행을 한 줄로 합친 표기(값 정의는 동일).
      label: "슛 (유효)",
      home: `${home.shots} (${home.onTarget})`,
      away: `${away.shots} (${away.onTarget})`,
      hv: home.shots,
      av: away.shots,
    },
    { key: "xg", label: "xG", home: home.xg.toFixed(2), away: away.xg.toFixed(2), hv: home.xg, av: away.xg },
    {
      key: "pass",
      label: "패스 성공률",
      home: `${home.passPct}%`,
      away: `${away.passPct}%`,
      hv: home.passPct,
      av: away.passPct,
    },
    { key: "corners", label: "코너", home: `${home.corners}`, away: `${away.corners}`, hv: home.corners, av: away.corners },
    { key: "fouls", label: "파울", home: `${home.fouls}`, away: `${away.fouls}`, hv: home.fouls, av: away.fouls },
    {
      key: "cards",
      label: "경고 / 퇴장",
      home: `${home.yellow} / ${home.red}`,
      away: `${away.yellow} / ${away.red}`,
      hv: home.yellow + home.red,
      av: away.yellow + away.red,
    },
  ];
}

/** 좌/우 막대 비율(%) — 둘 다 0이면 반반(빈 막대 대신 중립 표시). */
export function share(hv: number, av: number): number {
  const tot = hv + av;
  return tot > 0 ? (hv / tot) * 100 : 50;
}

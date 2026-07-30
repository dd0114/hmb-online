import type { MyRecordResponse, RecordBlock } from "../api/hooks-p286";

/**
 * 내 전적 — **순수 판정** (#286 W5, 설계 §3.7).
 *
 * ⚠️ **승률을 클라가 다시 계산하지 않는다.** 무승부를 0.5승으로 치는지 제외하는지는 **서버
 * 규칙**이고, 여기서 나누는 순간 화면과 서버가 조용히 어긋난다(#262·#245 와 같은 규율).
 * 서버가 `winRate` 를 안 주면 도넛을 그리지 않는다 — 숫자를 지어내느니 없는 편이 낫다.
 */

export interface ModeRow {
  key: "league" | "away" | "practice";
  label: string;
  rec: RecordBlock;
}

/** 모드 표시 순서·이름. 연습이 마지막인 것은 hero Q1(본 게임은 리그·원정)과 같은 뜻이다. */
const MODE_LABELS: ReadonlyArray<{ key: ModeRow["key"]; label: string }> = [
  { key: "league", label: "리그" },
  { key: "away", label: "원정" },
  { key: "practice", label: "연습" },
];

export interface RecordView {
  /** 그릴 게 있는가. false 면 화면은 이 구역을 통째로 생략한다(#319 미착지 대비). */
  usable: boolean;
  overall: RecordBlock | null;
  /** 서버가 준 승률(0~1). **클라가 계산하지 않는다.** */
  winRate: number | null;
  modes: ModeRow[];
  /** 최근 10경기, 최신이 앞. */
  form: Array<"WIN" | "DRAW" | "LOSS">;
  streak: { current: number | null; best: number | null };
}

function block(v: unknown): RecordBlock | null {
  const b = v as Partial<RecordBlock> | null | undefined;
  if (!b || typeof b !== "object") return null;
  if (typeof b.played !== "number") return null;
  return {
    played: b.played,
    wins: typeof b.wins === "number" ? b.wins : 0,
    draws: typeof b.draws === "number" ? b.draws : 0,
    losses: typeof b.losses === "number" ? b.losses : 0,
    winRate: typeof b.winRate === "number" ? b.winRate : null,
  };
}

export function recordView(data: MyRecordResponse | undefined | null): RecordView {
  const overall = block(data?.overall);
  const modes: ModeRow[] = [];
  for (const m of MODE_LABELS) {
    const rec = block(data?.byMode?.[m.key]);
    // 한 판도 안 한 모드는 줄을 만들지 않는다 — 0승0무0패 세 줄은 정보가 아니라 소음이다.
    if (rec && rec.played > 0) modes.push({ key: m.key, label: m.label, rec });
  }
  const form = Array.isArray(data?.recentForm)
    ? data!.recentForm!.filter((f): f is "WIN" | "DRAW" | "LOSS" =>
        f === "WIN" || f === "DRAW" || f === "LOSS",
      )
    : [];
  return {
    usable: overall !== null || modes.length > 0 || form.length > 0,
    overall,
    winRate: typeof overall?.winRate === "number" ? overall.winRate : null,
    modes,
    form,
    streak: {
      current: typeof data?.streak?.current === "number" ? data.streak.current : null,
      best: typeof data?.streak?.best === "number" ? data.streak.best : null,
    },
  };
}

/** 도넛의 `stroke-dasharray` — 둘레 기준. 승률을 **모르면 호출하지 않는다**(화면이 분기한다). */
export function donutDash(winRate: number, circumference: number): string {
  const filled = Math.max(0, Math.min(1, winRate)) * circumference;
  return `${filled} ${circumference - filled}`;
}

/** 폼 한 칸의 표시 문자. 색 하나로만 구분하지 않는다(적록색약 — #262 규율). */
export function formMark(f: "WIN" | "DRAW" | "LOSS"): string {
  return f === "WIN" ? "승" : f === "DRAW" ? "무" : "패";
}

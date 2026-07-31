import { crestInitials, crestSeed } from "../league/daily-reward-logic";
import styles from "./TeamCrest.module.css";

/**
 * 팀 마크 — **생성 크레스트** (#368).
 *
 * ⚠️ **리포에 클럽 엠블럼 아트가 0개다**(클럽명 24종 + 페르소나 7종뿐, `data/players/league.v2.json`).
 * 그래서 마크를 발행물에서 가져오지 않고 **팀 이름에서 결정론적으로 만든다** — 같은 팀은 항상 같은
 * 색·같은 이니셜이고, 발행 대기 없이 지금 화면이 성립한다.
 *
 * <p>실아트가 발행되면 **이 컴포넌트 안만** 갈아끼운다(호출부는 팀 이름만 넘긴다). 그래서 여기에
 * `<img>` 를 넣을 자리를 미리 비워 두지 않는다 — 그때 매핑 규칙까지 같이 정해야 하고, 지금 넣어 두면
 * 쓰지 않는 분기가 낡는다.
 *
 * <p>색은 색조만 이름에서 뽑고 채도·명도는 고정이라 **어떤 이름이 와도 대비가 무너지지 않는다**
 * (해시로 밝기까지 뽑으면 어두운 배경에 검은 마크가 나오는 팀이 생긴다).
 */
export function TeamCrest({
  name,
  size = "md",
  muted = false,
}: {
  name: string | null | undefined;
  /** `sm` = 트랙 칸 아래 · `md` = 목록 행 · `lg` = 포커스 카드 */
  size?: "sm" | "md" | "lg";
  /** 지난 칸의 마크는 흑백으로 — "이미 지나간 것"을 색으로 말한다. */
  muted?: boolean;
}) {
  // 이름이 없으면 **아무것도 그리지 않는다**. 물음표 마크를 띄우면 "상대가 정해졌는데 못 읽었다"로
  // 보이지만, 실제로는 잔여 일정이 없는 정상 상태다(시즌 밖·트랙보다 짧은 일정).
  if (!name) return null;
  const hue = crestSeed(name) % 360;
  return (
    <span
      className={[styles.crest, styles[size], muted ? styles.muted : ""].join(" ")}
      style={{
        // 색조만 데이터에서 — 채도·명도 고정(대비 보장).
        background: `linear-gradient(150deg, hsl(${hue} 62% 46%), hsl(${(hue + 28) % 360} 58% 26%))`,
        boxShadow: `inset 0 0 0 1px hsl(${hue} 70% 62% / 0.5)`,
      }}
      role="img"
      aria-label={`${name} 팀 마크`}
      data-testid="team-crest"
      data-team={name}
    >
      {crestInitials(name)}
    </span>
  );
}

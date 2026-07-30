/**
 * 오토 모드의 순수 화면 규칙 (#249).
 *
 * 서버가 흐름의 SoT 다(`matches.auto_mode` + 전반 종료 경계). 여기 있는 건 **어느 화면에서 토글을
 * 보여주고 어떻게 말할까**뿐 — 판정을 클라가 복제하면 규칙이 바뀔 때 조용히 어긋난다(#217 교훈).
 */

/**
 * 토글을 렌더할 상태.
 *
 * 서버가 받아주는 상태(`BRIEFING/GEN1/FIRST_HALF/HALFTIME`)보다 **좁다** — 감독시간은 일부러 뺐다.
 * 그 화면엔 [후반 시작] 버튼이 이미 있어서 같은 일을 하는 컨트롤이 둘이면 유저가 뭘 눌러야 할지
 * 모른다. 서버가 감독시간에도 받아주는 건 <b>경합 창</b>(전반 막바지에 눌렀는데 그 사이 경계가
 * 넘어간 ≤1초) 때문이고, 그건 화면이 아직 FIRST_HALF 를 그리고 있는 순간이다.
 */
const TOGGLE_STATES = new Set(["BRIEFING", "GEN1", "FIRST_HALF"]);

export function canToggleAuto(state: string | undefined): boolean {
  return state !== undefined && TOGGLE_STATES.has(state);
}

/**
 * 감독 패널(상태 패널)을 열 것인가 — 오토면 열지 않는다.
 *
 * 오토는 서버에서 감독시간을 0초로 열고 같은 스윕에서 후반으로 잇는다. 정상 경로에선 그 상태가
 * 화면에 오지 않지만, 스위퍼와 폴링이 어긋나는 한 프레임이나 두 전이 사이 프로세스 재시작 같은
 * 틈에서는 올 수 있다. 그때 감독 패널이 번쩍이면 "오토인데 감독시간이 열렸다"로 보인다 —
 * 실제로는 이미 지나간 0초짜리다. 이 가드가 그 틈을 화면에서 지운다.
 */
export function suppressHalftimePanel(state: string | undefined, auto: boolean | undefined): boolean {
  return auto === true && (state === "HALFTIME" || state === "H1_BREAK");
}

export type AutoCopy = { label: string; hint: string; pressed: boolean };

/** 토글 문구. 상태가 아니라 **다음에 일어날 일**을 말한다(무엇이 켜졌나 < 뭐가 달라지나). */
export function autoCopy(auto: boolean | undefined): AutoCopy {
  return auto
    ? {
        label: "오토 ON",
        hint: "전반이 끝나면 감독시간 없이 후반이 바로 시작됩니다. 지금 써 둔 후반 지시는 그대로 반영돼요.",
        pressed: true,
      }
    : {
        label: "오토 OFF",
        hint: "전반이 끝나면 감독시간(3분) 동안 후반 지시와 교체를 할 수 있습니다.",
        pressed: false,
      };
}

/**
 * 포지션 **한글 표기** (#406 요구 6 · W6 m7).
 *
 * <h3>왜 web 이 소유하나</h3>
 * <p>포지션 enum(`GK`·`DF`·`MF`·`FW`)의 SoT 는 시드(`data/players/players.v2.*.json`)이고 API 는
 * 그 원문을 그대로 내려 준다. 그 값을 한글로 바꾸는 것은 **표기**이지 데이터가 아니다 —
 * `stage/log-labels.ts` 가 로그 라벨에 세운 것과 같은 경계다(코어·서버는 데이터, 표기는 호스트).
 * QA dev-viewer 는 전면 영어(v3 β)라 코어 쪽에 한글을 넣으면 그쪽 계약이 깨진다.
 *
 * <h3>모르는 값은 원문 그대로</h3>
 * <p>발행측이 포지션을 늘리는 날 화면에 <b>빈칸</b>이 뜨는 것보다 영문 원문이 뜨는 편이 낫다.
 * 그때 여기에 한 줄 더하면 된다(계약이 전수 매핑을 검사하므로 놓치면 red 다).
 *
 * <h3>⚠️ 소비처가 아직 이 카드 하나뿐이다 — 남은 넷은 <b>후속</b>이다 (W7 m-9, 조정 포인트)</h3>
 * 같은 enum 이 그대로 노출되는 자리가 넷 더 있다: `stage/BriefingPanel.tsx`(컨디션·상대분석) ·
 * `deck/PromptFields.tsx` · `stage/SecondHalfBriefPanel.tsx` · `trade/TradePlayerCard.tsx`.
 * 이 함수는 이미 export 라 넓히는 것 자체는 싸다. 그런데도 **이 웨이브에서 하지 않았다**:
 * 앞의 셋은 W6 이 *"#421 겹침 3파일 무접촉"* 으로 일부러 안 건드린 그 파일들이고(동시에 도는
 * 세션과 충돌한다), 요구 6 은 문자 그대로는 **이름** 축이라 포지션 표기는 파생 정리다.
 * → **각 파일을 여는 웨이브가 `positionKo` 로 바꾸고 자기 계약을 박는다**(`playerNameOf` 를
 * 파일별로 박게 한 `apps/web/CLAUDE.md` §"스캐너 밖 — 파일을 넘는 프롭"과 같은 처리).
 */

/** 시드가 쓰는 전 포지션 — 계약이 이 목록으로 전수 검사한다. */
export const POSITIONS = ["GK", "DF", "MF", "FW"] as const;
export type Position = (typeof POSITIONS)[number];

const KO: Record<Position, string> = {
  GK: "골키퍼",
  DF: "수비수",
  MF: "미드필더",
  FW: "공격수",
};

/** 포지션 표기. 값이 없으면 `null`(호출부가 그 자리를 통째로 생략하게), 모르면 원문. */
export function positionKo(pos: string | null | undefined): string | null {
  const raw = pos?.trim();
  if (!raw) return null;
  return KO[raw.toUpperCase() as Position] ?? raw;
}

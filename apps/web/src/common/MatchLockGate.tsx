import type { ReactElement } from "react";
import { Navigate } from "react-router-dom";
import { useActiveMatch } from "../api/hooks";
import { resumePathFor, shouldForceResume } from "./match-lock";

/**
 * 진행 중 매치가 있으면 메타 화면 대신 그 매치로 보낸다 (#217 AC1/AC2).
 *
 * <p>hero 요구의 본체가 여기다 — "경기 도중 뒤로 나가면 끝"이 아니라 <b>어디로 가든 경기로
 * 돌아온다</b>. 새로고침·재로그인·다른 기기가 같은 답을 내는 이유는 판정 입력이 서버 상태
 * ({@code GET /api/me/active-match})뿐이기 때문이다(로컬 저장 0).
 *
 * <p><b>로딩 중에는 아무 것도 하지 않는다</b>: 응답 전에 화면을 내리면 진행 중 매치가 없는
 * 대다수 유저가 매번 로비 깜빡임을 본다. 잠금은 어차피 서버가 409 로 최종 강제한다 —
 * 이 게이트는 <b>안내</b>지 보안 경계가 아니다.
 *
 * <p>강제 이동 조건이 {@code locked} 가 아니라 {@code locked && !abandonable} 인 이유는
 * {@link shouldForceResume} 주석 참조(회수 가능한 사고 매치까지 붙잡으면 탈출구에 못 간다).
 */
export function MatchLockGate({ children }: { children: ReactElement }) {
  const { data: active } = useActiveMatch();
  const path = resumePathFor(active);

  if (shouldForceResume(active) && path) {
    return <Navigate to={path} replace />;
  }
  return children;
}

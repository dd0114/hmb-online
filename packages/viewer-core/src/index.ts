/**
 * @hmb/viewer-core — 관전 화면(게임화면) 렌더/투영 코어.
 *
 * P4-D3: **게임화면이 뷰어 SoT**, QA dev-viewer 는 그 부분집합을 소비한다.
 * 단계(설계 = docs/plan-v5/layout-game-screen.md §4.3):
 *   S1(현재) — 순수 투영(로그 라인·통계 표면)만 이 패키지가 소유. 캔버스는 아직 dev-viewer iframe.
 *   S2 — dev-viewer index.html 의 렌더 코어(draw/camera/fx)를 여기로 추출, QA 는 셸만 남김.
 *   S3 — apps/web 이 iframe 없이 코어를 직접 마운트(브리지·문자열 치환 파이프라인 제거).
 *
 * 규율: 순수·프레임워크 무관·DOM 무관(S2 의 render 는 캔버스 컨텍스트를 인자로 받는다).
 */
export * from "./log-lines";
export * from "./stats";

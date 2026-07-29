/**
 * 로그인 후 **복귀 경로**의 순수 판정 (#298 AC3).
 *
 * 배경: 미로그인으로 공유 딥링크(`/share/notice/{id}`)에 들어오면 `RequireAuth` 가 `/login` 으로
 * 보내는데, 지금까지 **어디로 가려 했는지를 남기지 않아** 로그인 뒤 로비로 착지했다. 목적지를
 * URL 파라미터로 실어 나르는 순간 이 값은 **공격자가 링크 하나로 통제하는 입력**이 된다.
 *
 * ⚠️ **`startsWith("/")` 로 판정하지 마라.** `//evil.test` 는 그 검사를 통과하지만 브라우저는
 * **프로토콜 상대 URL**로 읽어 외부 호스트로 나간다(= 로그인 직후 피싱 페이지 착지). 백슬래시
 * (`/\evil.test`)도 브라우저가 `//` 로 정규화한다. 그래서 여기서는 **화이트리스트**로 좁힌다 —
 * "이 경로가 이 앱의 화면인가"에 답할 수 있는 목록만 통과시킨다.
 *
 * ⚠️ 이 모듈은 `RequireAuth`·`LoginPage` 두 공용 경로가 함께 쓴다. 한쪽만 고치면 회귀가
 * 조용히 생긴다(붙이는 쪽/떼는 쪽이 서로 다른 규칙을 쓰게 된다) — 그래서 **붙이기·풀기·폴백을
 * 한 파일에** 둔다.
 */

/** 복귀 경로를 실어 나르는 쿼리 파라미터 이름. */
export const RETURN_TO_PARAM = "returnTo";

/**
 * 복귀 대상이 없거나 안전하지 않을 때의 착지점.
 *
 * ⚠️ #286 에서 **로비가 홈으로 대체**됐다. 이름은 호환을 위해 남기되 값은 `/home` 이다 —
 * `/lobby` 는 리다이렉트로만 살아 있어서, 폴백을 거기로 두면 착지 때마다 한 번 더 튕긴다.
 */
export const LOBBY_PATH = "/home";

/**
 * 정확히 이 경로일 때만 허용(하위 경로는 허용하지 않는다).
 *
 * ⚠️ #286 개편으로 목적지가 6탭으로 바뀌었다. **구 경로도 남겨 둔다** — 이미 발송된 링크·
 * 북마크가 `returnTo=/codex` 를 실어 올 수 있고, 그건 리다이렉트가 받아 준다. 여기서 거절하면
 * 그 링크는 폴백(홈)으로 조용히 떨어진다.
 */
const EXACT_ALLOWED: readonly string[] = [
  // 현행 (#286)
  "/home",
  "/game",
  "/away",
  "/deck",
  "/players",
  "/recruit",
  "/me",
  "/league",
  // 구 경로 — 리다이렉트로 살아 있다(발송된 링크 보호)
  "/lobby",
  "/shop",
  "/growth",
  "/codex",
  "/trade",
  "/logs",
];

/**
 * 이 접두사로 **시작하고 뒤에 내용이 더 있을 때만** 허용.
 *
 * `/share/notice/` 만 오면(=id 가 없으면) 거절한다 — 목적지가 없는 복귀는 로비와 다를 게 없고,
 * 접두사만 통과시키면 화이트리스트가 넓어지기만 한다.
 */
const PREFIX_ALLOWED: readonly string[] = ["/share/notice/", "/match/"];

/** 복귀 경로에 실릴 수 있는 최대 길이 — 무한정 긴 값을 URL 에 실어 나르지 않는다. */
const MAX_LENGTH = 512;

function isAllowedPath(pathname: string): boolean {
  if (EXACT_ALLOWED.includes(pathname)) return true;
  return PREFIX_ALLOWED.some((p) => pathname.startsWith(p) && pathname.length > p.length);
}

/**
 * 안전하면 **원문 그대로**(쿼리·해시 포함) 돌려주고, 아니면 null.
 *
 * 원문을 그대로 돌려주는 것이 계약이다 — 정규화해서 돌려주면 "쿼리 보존"이 조용히 깨진다.
 */
export function safeReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!raw || raw.length > MAX_LENGTH) return null;
  // 공백·제어문자 = 스킴 위장·헤더 삽입의 흔한 재료. 하나라도 있으면 통째로 거절한다.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  if (!raw.startsWith("/")) return null; // 절대 URL·스킴(javascript:, data:)은 여기서 전부 탈락
  if (raw.startsWith("//")) return null; // 프로토콜 상대 — `startsWith("/")` 만으로는 못 막는다
  if (raw.includes("\\")) return null; // 브라우저가 `\` 를 `/` 로 정규화한다
  if (raw.includes("..")) return null; // 경로 traversal 로 화이트리스트를 우회하지 못하게
  const pathname = raw.split(/[?#]/, 1)[0] ?? "";
  return isAllowedPath(pathname) ? raw : null;
}

/** 안전한 복귀 경로, 없으면 로비. **화면은 이 함수만 부른다**(폴백을 각자 적지 않는다). */
export function resolveReturnTo(raw: unknown): string {
  return safeReturnTo(raw) ?? LOBBY_PATH;
}

/**
 * 로그인 화면으로 보낼 때의 경로 — 갈 곳이 로비(기본 착지)이거나 안전하지 않으면 **파라미터를
 * 붙이지 않는다**. 위험한 값을 URL 에 실어 나르는 것 자체가 리스크이고, 로비는 어차피 폴백이라
 * 붙여봐야 동작이 같다.
 */
export function loginPathWithReturn(target: unknown): string {
  const safe = safeReturnTo(target);
  if (!safe || safe === LOBBY_PATH) return "/login";
  return `/login?${RETURN_TO_PARAM}=${encodeURIComponent(safe)}`;
}

/**
 * Phase-3 API 계약 (web 측 잠정 SoT).
 *
 * ⚠️ 이 파일은 **임시**다. p3srv(server-java Phase3 세션)가 `docs/plan-v4/api/openapi-v3.yaml`
 * 을 발행하면 `npm run gen:types:v3` 생성물(`schema-v3.d.ts`)로 교체하고 이 파일은 배럴로만
 * 남긴다. 지금은 PRD-v4 §1 A/C/E 의 요구를 그대로 타입으로 옮겨 route-mock 으로 개발한다.
 * (도메인 경계: web 은 서버 코드를 만들지 않는다 — 계약 불일치는 이슈 레이즈. CLAUDE.md §10)
 *
 * 통합 시 정합 체크리스트:
 *  - [x] **§A(자체 로그인)** — server-java 구현 대조 완료(아래 §A 주석의 파일 목록). 잠정 아님.
 *  - [ ] §C/§E — 필드명/열거값이 openapi-v3 와 일치하는지
 *  - [ ] 에러 code 가 client.ts 의 ErrorCode 유니온에 포함되는지
 *  - [ ] 여기 선언한 경로 상수가 실제 라우트와 같은지
 */
import type { components } from "./schema";
import type { LeagueSeason } from "./v2";

type WalletInfo = components["schemas"]["WalletInfo"];
type UserRef = components["schemas"]["UserRef"];
type MatchRecordSummary = components["schemas"]["MatchRecordSummary"];

/* ─────────────────────────── A. 자체 로그인 (PRD-v4 §A, P3-D2) ─────────────────────────── */

/**
 * ✅ **이 §A 블록은 더 이상 가정이 아니다** — server-java 구현(main 머지)에 실측 정합시켰다.
 * 대조 SoT (읽고 맞춘 파일):
 *   - `server-java/.../auth/RegisterRequest.java`  → body = {nickname, password}
 *   - `server-java/.../auth/LoginRequest.java`     → body = {nickname, provider, password}
 *   - `server-java/.../auth/AuthErrors.java`       → 409 DUPLICATE_NICKNAME / 401 BAD_CREDENTIALS
 *   - `server-java/.../auth/LocalAuthController.java` → POST /api/auth/register, 응답 = LoginResponse
 *   - `server-java/.../auth/Nicknames.java`        → 식별자 규칙(2~16, \p{L}\p{N}_-)
 *
 * ⚠️ **식별자는 하나다**: 서버에 별도 로그인 id 컬럼이 없고 기존 `users.nickname`(UNIQUE)이
 * 곧 로그인 id 다. 따라서 클라도 "아이디"와 "닉네임"을 나눠 받지 않는다(단일 필드).
 */

/**
 * 로컬(자체) 계정 provider 값. 기존 guest|mock:google|mock:apple 과 **공존**한다
 * (additive — 기존 플로우 무회귀, AC-A1).
 */
export const LOCAL_PROVIDER = "local" as const;
export type LocalProvider = typeof LOCAL_PROVIDER;

export const AUTH_REGISTER_PATH = "/api/auth/register";
export const AUTH_LOGIN_PATH = "/api/auth/login";

/**
 * POST /api/auth/register — 회원가입(= RegisterRequest.java).
 * ⚠️ 비번은 **평문 목업**(P3-D2). 실서비스 전 해시 전환은 백로그 — 서버가 SoT고 클라는
 * 여기서 절대 저장/로깅하지 않는다(AC-A2: 응답·로그 노출 0).
 */
export interface RegisterRequest {
  /** 로그인 id 겸 표시 닉네임. */
  nickname: string;
  password: string;
}

/**
 * POST /api/auth/login (provider="local") — 자체 로그인(= LoginRequest.java).
 * 실패는 전부 401 BAD_CREDENTIALS(서버가 계정 존재 여부를 누설하지 않는다).
 */
export interface LocalLoginRequest {
  nickname: string;
  provider: LocalProvider;
  password: string;
}

/** 두 엔드포인트 공통 응답 — V1 LoginResponse 와 동일 shape(token/user/isNew). */
export type AuthResponse = components["schemas"]["LoginResponse"];

/** 서버 에러 code — AuthErrors.java 상수와 1:1. */
export const AUTH_DUPLICATE_NICKNAME_CODE = "DUPLICATE_NICKNAME"; // 409
export const AUTH_BAD_CREDENTIALS_CODE = "BAD_CREDENTIALS"; // 401

/* ─────────────────────────── C. admin (PRD-v4 §C, P3-D4) ─────────────────────────── */

export const ADMIN_USERS_PATH = "/api/admin/users";

/** GET /api/me 의 Phase3 additive — admin 플래그. 없으면 비admin으로 본다. */
export interface MeResponseP3 {
  user: UserRef & { isAdmin?: boolean; tutorialDone?: boolean };
  wallet: WalletInfo;
  records: MatchRecordSummary;
}

/** GET /api/admin/users?q= — 유저 목록·검색(AC-C1). */
export interface AdminUserRow {
  userId: string;
  nickname: string;
  provider: string;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  createdAt: string;
}

export interface AdminUserListResponse {
  users: AdminUserRow[];
}

/** GET /api/admin/users/{userId} — 보유·덱·전적 상세. */
export interface AdminUserDetail {
  user: AdminUserRow;
  ownedPlayers: number;
  deckFormation: string | null;
  deckStarters: number;
  recentLedger: AdminLedgerEntry[];
}

/** POST /api/admin/users/{userId}/points — 포인트 지급/차감. delta 음수=차감. */
export interface AdminGrantRequest {
  delta: number;
  reason: string;
}

export interface AdminGrantResponse {
  userId: string;
  points: number;
  entry: AdminLedgerEntry;
}

/** admin 액션 원장(감사 로그, AC-C1). */
export interface AdminLedgerEntry {
  id: string;
  delta: number;
  reason: string;
  actor: string;
  createdAt: string;
}

/* ─────────────────────────── E. 리그 시즌 보상 (PRD-v4 §E, P3-D8) ─────────────────────────── */

/**
 * GET /api/league 의 Phase3 additive — 시즌 종료 보상(서버 기구현 AC-F4 의 지급 결과).
 * 멱등: 재진입해도 같은 값이 오고 중복 지급은 없다(AC-E1). status 로 미지급/오류를 노출한다.
 */
export interface LeagueSeasonReward {
  rank: number;
  points: number;
  /**
   * 시즌 종료 시 지급되는 유상재화. **#251 로 "우승만"에서 "완주 전원"으로 바뀌었다** —
   * 완주 기본 + 순위 보너스 가산이라 완주한 모든 순위가 > 0 이다(1등 9,000 / 2등 6,000 /
   * 3등 4,000 / 4등 이하 3,000, 금액 SoT = 서버 economy config). 화면에 **표기**하는 것이 #232,
   * 지급 **연출**은 #214 소관이다 — 받은 재화가 화면에 아예 없던 것이 표기 갭이었다.
   */
  gems?: number | null;
  /**
   * ⚠️ **서버 enum 이 SoT 다: `PENDING | GRANTED | NONE`**(openapi `SeasonReward.status`).
   *
   * `AWARDED`/`FAILED` 는 이 파일이 서버 확인 없이 적어 뒀던 이름이라 실제로는 <b>한 번도 오지 않는다</b>.
   * 그 결과 종료된 시즌의 보상 카드가 전부 "보상이 지급되지 않았습니다"로 떴다(#251 에서 발견 —
   * e2e 목이 서버가 보내지 않는 `AWARDED` 를 쓰고 있어 목-실서버 드리프트로 가려져 있었다).
   * 구 이름은 <b>호환용 별칭</b>으로만 남긴다(잘못된 이름을 지우는 것이 아니라, 서버 이름을 정본으로 승격).
   */
  status: "PENDING" | "GRANTED" | "NONE" | "AWARDED" | "FAILED";
  awardedAt?: string | null;
  /** 지급되지 않았을 때(NONE/FAILED) 화면에 띄울 사유. */
  message?: string | null;
}

/**
 * GET /api/league 응답의 Phase3 확장 뷰.
 *
 * ⚠️ 통합 정합 지점: seasonReward 가 **season 안**인지 **응답 루트**인지 openapi-v3 미발행 상태라
 * 확정되지 않았다. 클라는 둘 다 수용한다(`pickSeasonReward`, season 우선). 발행되면 한쪽으로
 * 좁히고 이 관용 로직을 제거한다.
 */
export interface LeagueResponseP3 {
  season?: (LeagueSeason & { seasonReward?: LeagueSeasonReward | null }) | null;
  seasonReward?: LeagueSeasonReward | null;
}

/* ───────────────── F. 스타터/온보딩 개편 (이슈 #209) ───────────────── */

/**
 * ✅ 서버 구현 대조 완료 (`server-java/.../meta/OnboardingController.java` · `OnboardingService.java`).
 *
 * 가입 지급이 "고정 14장"에서 **기본팩(SILVER/BRONZE) + 최상위 후보 중 1장**(시드 결정론)로 바뀌었고,
 * 덱은 가입이 아니라 **튜토리얼 완료 시점**에 지급된다. 최상위 후보 목록은 서버 코드가 아니라
 * data 발행물(`economy.starterTop`)이라 #207 랜딩 시 데이터만 갈아끼운다 — 클라는 결과만 받는다.
 */
export const STARTER_GRANT_PATH = "/api/me/starter-grant";
export const TUTORIAL_COMPLETE_PATH = "/api/me/tutorial-complete";

/**
 * GET /api/me/starter-grant — 가입 때 받은 최상위 유닛(연출 재료).
 * 개편 이전에 가입한 계정은 `granted=false, player=null` 이다 — 그때는 연출을 생략한다.
 *
 * ⚠️ 이 §F 의 두 타입은 **손으로 적지 않는다** — openapi.yaml 에 스키마를 실었으므로
 * 생성물(`schema.d.ts`)에서 그대로 가져온다(계약 드리프트 0).
 */
export type StarterGrantResponse = components["schemas"]["StarterGrantResponse"];

/**
 * POST /api/me/tutorial-complete — 완료/건너뛰기 저장(멱등).
 * `deckGranted` 는 **이번 호출이 실제로 덱을 만들었는지**다. 이미 덱이 있으면 false 이고
 * 서버는 기존 덱을 절대 덮어쓰지 않는다.
 */
export type TutorialCompleteResponse = components["schemas"]["TutorialCompleteResponse"];

/* ───────────── G. economy 무배포 운영 (#209 B안, admin 전용) ───────────── */

/**
 * 재배포 없이 스타터 최상위 후보를 갈아끼우는 운영 API. 전부 `/api/admin/` 게이트 뒤다.
 *
 * ⚠️ **리로드만으로는 값이 안 바뀐다**는 게 이 API 의 전제다: 발행물은 이미지에 구워져 있어
 * 컨테이너 안에서 불변이다. 서버는 쓰기 가능한 볼륨에 **override 파일**을 만들어 그걸 우선 로드한다
 * → 화면은 값뿐 아니라 **출처(`source`)** 를 반드시 같이 보여줘야 한다("바꿨는데 반영됐나"의 답).
 */
export const ADMIN_ECONOMY_PATH = "/api/admin/economy";
export const ADMIN_ECONOMY_HISTORY_PATH = "/api/admin/economy/history";
export const ADMIN_ECONOMY_RELOAD_PATH = "/api/admin/economy/reload";
export const ADMIN_ECONOMY_STARTER_TOP_PATH = "/api/admin/economy/starter-top";
export const ADMIN_ECONOMY_OVERRIDE_PATH = "/api/admin/economy/override";

/**
 * 세 타입 모두 **손으로 적지 않는다** — openapi.yaml 에 스키마를 실었으므로 생성물에서 가져온다.
 * (앞선 §F 와 같은 원칙: 계약이 두 곳에 있으면 조용히 어긋난다.)
 */
export type AdminEconomyView = components["schemas"]["AdminEconomyView"];

/** PUT /api/admin/economy/starter-top — 후보 교체(사유 필수, 원장에 남는다). */
export type AdminStarterTopRequest = components["schemas"]["AdminStarterTopRequest"];

/** 운영 이력 1행 — 실패도 남는다(`result`). */
export type AdminOpsAuditEntry = components["schemas"]["AdminOpsAuditEntry"];


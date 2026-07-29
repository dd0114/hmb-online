import { useLocation, useNavigate } from "react-router-dom";
import { useNavGuardRun } from "./NavGuard";
import { useAdminFlag } from "../admin/admin-flag";
import { useNavLocked } from "./nav-lock";
import styles from "./AppNav.module.css";

/**
 * 앱 네비게이션 (#286 W2 개편).
 * - 모바일(<1024px): 하단 탭바.
 * - 데스크탑(≥1024px): 좌측 사이드바.
 * 두 표현 모두 같은 항목을 렌더하고 CSS 미디어쿼리로 전환한다(단일 소스).
 *
 * ── 6칸: 홈 · 게임 · 덱 · 선수 · 영입 · 내 정보 ─────────────────────────────
 * 구 7칸(홈·덱·육성·상점·트레이드·로그·도감)에서 **육성은 선수(도감)로 병합**되고
 * **상점+트레이드는 영입**으로, **로그는 내 정보**로 들어갔다(#286 IA).
 *
 * ⚠️ **홈에서는 이 네비가 렌더되지 않는다** — 홈 자체가 내비이기 때문(hero 4R). 그 짝으로
 * 여기 `home` 칸이 **홈으로 돌아올 유일한 경로**다. 홈 라우트의 `nav` 를 끄면서 이 칸까지
 * 지우면 홈이 막힌다. 계약 = `e2e/p286-home-nav.spec.ts`.
 *
 * ⚠️ 라벨은 **축약형**이다(홈 타일은 풀 네임: "덱 구성"·"선수 도감"). 6칸에 풀 네임은
 * 390px 에서 들어가지 않는다 — 둘은 의도적인 짝이다.
 */
export interface NavItem {
  key: string;
  label: string;
  icon: string;
  to: string;
  /** 라우트 미구현('준비중') — 클릭 불가. */
  pending?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", label: "홈", icon: "🏠", to: "/home" },
  { key: "game", label: "게임", icon: "⚽", to: "/game" },
  { key: "deck", label: "덱", icon: "📋", to: "/deck" },
  { key: "players", label: "선수", icon: "👥", to: "/players" },
  { key: "recruit", label: "영입", icon: "✨", to: "/recruit" },
  { key: "me", label: "내 정보", icon: "🙋", to: "/me" },
];

/** 운영자 전용 항목 (PRD-v4 §C) — admin 계정에만 붙인다. 비admin 에겐 DOM 에도 없다. */
export const ADMIN_NAV_ITEM: NavItem = { key: "admin", label: "운영", icon: "🛠", to: "/admin" };

/** 표시할 항목 = 기본 6개 + (admin 이면) 운영. */
export function navItemsFor(isAdmin: boolean): readonly NavItem[] {
  return isAdmin ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;
}

/**
 * 현재 경로가 어느 탭에 속하는지 (prefix 매칭).
 *
 * 리그·원정은 `[게임]` 탭의 **하위 페이지**라 탭 활성 표시가 게임에 남는다 — 유저가 리그
 * 순위표를 보는 동안 어느 탭에 있는지 잃어버리지 않게.
 */
const SUB_ROUTES: Record<string, string> = { "/league": "game", "/away": "game" };

export function activeNavKey(pathname: string, items: readonly NavItem[] = NAV_ITEMS): string | null {
  const sub = Object.entries(SUB_ROUTES).find(
    ([path]) => pathname === path || pathname.startsWith(path + "/"),
  );
  if (sub && items.some((it) => it.key === sub[1])) return sub[1];
  const match = items.find((it) => !it.pending && (pathname === it.to || pathname.startsWith(it.to + "/")));
  return match ? match.key : null;
}

/**
 * 경기 중 잠글 항목인가 — **홈만 열어 둔다**(hero 2R).
 *
 * 홈을 같이 잠그면 [이어하기]/[경기 포기] 카드에도, 로그아웃에도 갈 수 없다 = 계정이 갇힌다.
 * #217 이 "영구 잠금 금지"로 막았던 것과 같은 함정이라 여기서도 탈출구를 남긴다.
 */
export function navItemLocked(key: string, locked: boolean): boolean {
  return locked && key !== "home";
}

export function AppNav() {
  const navigate = useNavigate();
  const runGuard = useNavGuardRun();
  const location = useLocation();
  const items = navItemsFor(useAdminFlag());
  const activeKey = activeNavKey(location.pathname, items);
  const locked = useNavLocked();

  function renderItem(
    item: NavItem,
    cls: string | undefined,
    activeCls: string | undefined,
    pendingCls: string | undefined,
  ) {
    const isActive = item.key === activeKey;
    const isLocked = navItemLocked(item.key, locked);
    const blocked = item.pending || isLocked;
    const className = [cls, isActive ? activeCls : "", blocked ? pendingCls : ""]
      .filter(Boolean)
      .join(" ");
    return (
      <button
        key={item.key}
        type="button"
        className={className}
        data-testid={`nav-${item.key}`}
        data-active={isActive ? "true" : undefined}
        data-locked={isLocked ? "true" : undefined}
        aria-current={isActive ? "page" : undefined}
        aria-disabled={blocked ? "true" : undefined}
        title={isLocked ? "경기가 끝나야 이동할 수 있습니다" : undefined}
        onClick={() => {
          if (blocked) return;
          // Route through the nav guard so a dirty page (e.g. /deck) can confirm before leaving.
          runGuard(() => navigate(item.to));
        }}
      >
        <span className={styles.icon} aria-hidden="true">
          {isLocked ? "🔒" : item.icon}
        </span>
        <span className={styles.itemLabel}>{item.label}</span>
        {item.pending && <span className={styles.pendingBadge}>준비중</span>}
      </button>
    );
  }

  return (
    <>
      <nav className={styles.bottomTab} data-testid="nav-bottom" aria-label="주 메뉴">
        {items.map((it) =>
          renderItem(it, styles.tabItem, styles.tabActive, styles.tabPending),
        )}
      </nav>
      <nav className={styles.sidebar} data-testid="nav-sidebar" aria-label="주 메뉴">
        <div className={styles.sidebarBrand}>HMB</div>
        {items.map((it) =>
          renderItem(it, styles.sideItem, styles.sideActive, styles.sidePending),
        )}
      </nav>
    </>
  );
}

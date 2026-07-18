import { useLocation, useNavigate } from "react-router-dom";
import styles from "./AppNav.module.css";

/**
 * 앱 네비게이션 (P2-D2, LLD-p2-web §7).
 * - 모바일(<1024px): 하단 탭바.
 * - 데스크탑(≥1024px): 좌측 사이드바.
 * 두 표현 모두 같은 항목을 렌더하고 CSS 미디어쿼리로 전환한다(단일 소스).
 *
 * 항목: 홈(로비)/덱/트레이드/로그/도감. 로그(W4)·트레이드(W3) 활성. 상점은 로비 진입 유지,
 * 리그(W5)는 로비 '게임 시작 → 연습/리그' 선택으로 진입(LLD §6).
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
  { key: "home", label: "홈", icon: "🏠", to: "/lobby" },
  { key: "deck", label: "덱", icon: "🃏", to: "/deck" },
  { key: "trade", label: "트레이드", icon: "🔄", to: "/trade" },
  { key: "logs", label: "로그", icon: "📋", to: "/logs" },
  { key: "codex", label: "도감", icon: "📖", to: "/codex" },
];

/** 현재 경로가 어느 탭에 속하는지 (prefix 매칭). */
export function activeNavKey(pathname: string, items: readonly NavItem[] = NAV_ITEMS): string | null {
  const match = items.find((it) => !it.pending && (pathname === it.to || pathname.startsWith(it.to + "/")));
  return match ? match.key : null;
}

export function AppNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeKey = activeNavKey(location.pathname);

  function renderItem(
    item: NavItem,
    cls: string | undefined,
    activeCls: string | undefined,
    pendingCls: string | undefined,
  ) {
    const isActive = item.key === activeKey;
    const className = [cls, isActive ? activeCls : "", item.pending ? pendingCls : ""]
      .filter(Boolean)
      .join(" ");
    return (
      <button
        key={item.key}
        type="button"
        className={className}
        data-testid={`nav-${item.key}`}
        data-active={isActive ? "true" : undefined}
        aria-current={isActive ? "page" : undefined}
        aria-disabled={item.pending ? "true" : undefined}
        onClick={() => {
          if (item.pending) return;
          navigate(item.to);
        }}
      >
        <span className={styles.icon} aria-hidden="true">
          {item.icon}
        </span>
        <span className={styles.itemLabel}>{item.label}</span>
        {item.pending && <span className={styles.pendingBadge}>준비중</span>}
      </button>
    );
  }

  return (
    <>
      <nav className={styles.bottomTab} data-testid="nav-bottom" aria-label="주 메뉴">
        {NAV_ITEMS.map((it) =>
          renderItem(it, styles.tabItem, styles.tabActive, styles.tabPending),
        )}
      </nav>
      <nav className={styles.sidebar} data-testid="nav-sidebar" aria-label="주 메뉴">
        <div className={styles.sidebarBrand}>HMB</div>
        {NAV_ITEMS.map((it) =>
          renderItem(it, styles.sideItem, styles.sideActive, styles.sidePending),
        )}
      </nav>
    </>
  );
}

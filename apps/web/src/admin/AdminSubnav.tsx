import { useLocation, useNavigate } from "react-router-dom";
import { ADMIN_NAV_ITEM, EVENTS_NAV_ITEM } from "../common/AppNav";
import styles from "./AdminSubnav.module.css";

/**
 * 운영 화면 전환 서브탭 (#498, 안 A).
 *
 * <b>왜 있나</b> — 운영 화면은 계속 는다(#492 이벤트 보드가 두 번째였다). 하단 탭바에 한 칸씩
 * 더하는 방식은 8칸에서 320px 칸 폭 <b>40.0px</b> = iOS 44pt·Material 48dp 미달이었고,
 * 다음 화면이면 9칸 35.6px 로 오버플로다. 그래서 하단 탭은 <b>운영 1칸</b>으로 접고 화면 전환을
 * 이 서브탭이 맡는다 — 여기는 가로 스크롤이 되므로 항목 수 상한이 없다.
 *
 * <p><b>라우트가 SoT 다</b> — 이 바는 상태를 갖지 않고 {@link useLocation} 으로 활성 항목을 정한다.
 * 그래야 직접 URL 진입·북마크·뒤로가기에서 표시가 어긋나지 않는다(`/event-board` 는 #492 이후
 * 이미 공유된 주소라 라우트를 없애지 않았다).
 *
 * <p>⚠️ 섹션 탭과 층위가 다르다 — `/admin` 안의 `유저 운영`·`유닛 카탈로그`… 는 <b>한 화면 안의
 * 섹션</b>이고 이 바는 <b>화면</b>을 고른다. 새 운영 <i>섹션</i>을 더할 자리는 저쪽이다.
 */
export interface AdminSubnavItem {
  key: string;
  label: string;
  icon: string;
  to: string;
}

/**
 * 두 화면. 경로는 {@code AppNav} 의 항목 상수에서 가져온다 — 라우트를 두 곳에 적으면 한쪽만
 * 바뀌어 어긋난다(하단탭 활성 표시가 `SUB_ROUTES` 로 같은 경로를 또 참조한다).
 *
 * <p>라벨은 하단탭보다 <b>길다</b>. 하단탭 라벨이 3글자로 묶여 있던 것은 `flex:1 1 0` 균등분할
 * 때문이고, 여기는 폭이 내용에 맞춰 늘어난다 — "운영"보다 "운영 액션"이 이벤트 보드와 대비돼
 * 무엇을 고르는 것인지 분명하다.
 */
export const ADMIN_SUBNAV: readonly AdminSubnavItem[] = [
  { key: "admin", label: "운영 액션", icon: ADMIN_NAV_ITEM.icon, to: ADMIN_NAV_ITEM.to },
  { key: "events", label: "이벤트 보드", icon: EVENTS_NAV_ITEM.icon, to: EVENTS_NAV_ITEM.to },
];

/** 현재 경로가 어느 서브탭인가. 어느 것도 아니면 null(그 화면엔 이 바를 안 그린다). */
export function adminSubnavKey(pathname: string): string | null {
  const hit = ADMIN_SUBNAV.find(
    (it) => pathname === it.to || pathname.startsWith(it.to + "/"),
  );
  return hit ? hit.key : null;
}

export function AdminSubnav() {
  const navigate = useNavigate();
  const activeKey = adminSubnavKey(useLocation().pathname);

  return (
    <nav className={styles.subnav} data-testid="admin-subnav" aria-label="운영 화면">
      {ADMIN_SUBNAV.map((it) => {
        const isActive = it.key === activeKey;
        return (
          <button
            key={it.key}
            type="button"
            className={`${styles.item} ${isActive ? styles.itemActive : ""}`}
            data-testid={`admin-subnav-${it.key}`}
            data-active={isActive ? "true" : undefined}
            aria-current={isActive ? "page" : undefined}
            onClick={() => {
              if (isActive) return;
              navigate(it.to);
            }}
          >
            <span className={styles.icon} aria-hidden="true">
              {it.icon}
            </span>
            {it.label}
          </button>
        );
      })}
    </nav>
  );
}

import type { ReactNode } from "react";
import { AppNav } from "./AppNav";
import styles from "./Layout.module.css";

interface LayoutProps {
  header?: ReactNode;
  children: ReactNode;
  /** 하단탭(모바일)/사이드바(데스크탑) 네비 표시 (LLD-p2-web §7). 몰입 플로우(매치)는 끈다. */
  nav?: boolean;
  /**
   * **본문이 남는 세로를 가져간다**(#455 A1). 기본은 지금까지의 문서 흐름(`display:block`) —
   * 켜면 `main` 이 세로 플렉스가 되어 자식이 `flex:1` 로 바닥까지 찰 수 있다.
   *
   * ⚠️ 이 스위치가 필요한 이유: `main` 이 블록이면 자식의 `height:100%` 가 **자기 형제들을 포함한
   * 내용 높이**로 풀려서, 경기장 아래를 탭이 채우게 만들 방법이 없다(실측 143px 이 남았다).
   * ⚠️ **켜는 화면만 켠다** — 전 페이지 기본으로 바꾸면 문서 흐름에 기대는 화면들이 같이 움직인다.
   */
  fill?: boolean;
}

/** Mobile-first page shell — phone portrait is the base layout (see src/index.css .app-container). */
export function Layout({ header, children, nav = false, fill = false }: LayoutProps) {
  return (
    <div
      className={["app-container", nav && "app-container--nav", fill && "app-container--fill"]
        .filter(Boolean)
        .join(" ")}
    >
      {nav && <AppNav />}
      {header && <header className={styles.header}>{header}</header>}
      <main
        className={[styles.main, nav && styles.mainWithNav, fill && styles.mainFill]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </main>
    </div>
  );
}

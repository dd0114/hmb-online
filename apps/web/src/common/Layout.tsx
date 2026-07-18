import type { ReactNode } from "react";
import { AppNav } from "./AppNav";
import styles from "./Layout.module.css";

interface LayoutProps {
  header?: ReactNode;
  children: ReactNode;
  /** 하단탭(모바일)/사이드바(데스크탑) 네비 표시 (LLD-p2-web §7). 몰입 플로우(매치)는 끈다. */
  nav?: boolean;
}

/** Mobile-first page shell — phone portrait is the base layout (see src/index.css .app-container). */
export function Layout({ header, children, nav = false }: LayoutProps) {
  return (
    <div className={nav ? "app-container app-container--nav" : "app-container"}>
      {nav && <AppNav />}
      {header && <header className={styles.header}>{header}</header>}
      <main className={nav ? `${styles.main} ${styles.mainWithNav}` : styles.main}>{children}</main>
    </div>
  );
}

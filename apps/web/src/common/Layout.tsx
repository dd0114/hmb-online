import type { ReactNode } from "react";
import styles from "./Layout.module.css";

interface LayoutProps {
  header?: ReactNode;
  children: ReactNode;
}

/** Mobile-first page shell — phone portrait is the base layout (see src/index.css .app-container). */
export function Layout({ header, children }: LayoutProps) {
  return (
    <div className="app-container">
      {header && <header className={styles.header}>{header}</header>}
      <main className={styles.main}>{children}</main>
    </div>
  );
}

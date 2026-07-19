import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

interface ModalProps {
  /** Called on Escape / backdrop click (only when `dismissable`). Also the caller's own close control. */
  onClose: () => void;
  /** id of the heading element that names this dialog (aria-labelledby). */
  labelledBy: string;
  children?: ReactNode;
  /** Escape + backdrop-click dismissal. Default true; set false to force an explicit in-dialog action. */
  dismissable?: boolean;
  /** Overlay (backdrop) class — each call site keeps its existing look. */
  overlayClassName?: string;
  /** Dialog-box class. */
  className?: string;
  testId?: string;
  /** Overlay(백드롭) data-testid — 기존 확인 다이얼로그의 백드롭 계약을 그대로 유지하기 위한 훅. */
  overlayTestId?: string;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * 접근성 모달 셸(#73 P1): role/aria-modal/aria-labelledby, 열릴 때 첫 포커스 이동,
 * 닫힐 때 이전 포커스 복원, Escape·백드롭 닫기, Tab 포커스 트랩. 시각은 caller CSS 그대로.
 */
export function Modal({
  onClose,
  labelledBy,
  children,
  dismissable = true,
  overlayClassName,
  className,
  testId,
  overlayTestId,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // 열릴 때 첫 포커서블로 이동하고, 닫힐 때 직전 포커스를 복원한다.
  useEffect(() => {
    const prevFocused = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();
    return () => prevFocused?.focus?.();
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape" && dismissable) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const node = dialogRef.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [dismissable, onClose],
  );

  return (
    <div
      className={overlayClassName}
      data-testid={overlayTestId}
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-testid={testId}
      >
        {children}
      </div>
    </div>
  );
}

import styles from "./ErrorToast.module.css";

interface ErrorToastProps {
  message: string | null | undefined;
  onDismiss?: () => void;
}

export function ErrorToast({ message, onDismiss }: ErrorToastProps) {
  if (!message) return null;
  return (
    <div className={styles.toast} role="alert">
      <span className={styles.message}>{message}</span>
      {onDismiss && (
        <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="닫기">
          ×
        </button>
      )}
    </div>
  );
}

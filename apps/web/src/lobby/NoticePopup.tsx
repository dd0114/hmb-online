import { useState } from "react";
import { Modal } from "../common/Modal";
import { NoticeBody } from "../common/NoticeBody";
import {
  defaultNoticeStores,
  markNoticeClosed,
  markNoticeDismissed,
  noticeMetaText,
  noticeSuppressionKey,
  type Notice,
  type NoticeStores,
} from "./notice-logic";
import styles from "./NoticePopup.module.css";

/** 뒤에 비치는 카드 최대 장수 — 4장이 넘어도 그림자는 2장까지만(그 이상은 시각 소음). */
const MAX_BEHIND = 2;

/**
 * 공지 팝업 — **중첩 스택**(hero Q1 확정).
 *
 * 뒤에 남은 공지가 카드로 겹쳐 보이고, 닫으면 다음 장이 앞으로 나온다. 버튼은 두 개뿐이고
 * **[다음]은 없다** — `닫기` 자체가 "이 장을 처리하고 다음 장"이다.
 *
 * ⚠️ **두 버튼 모두 그 장 하나에만 적용된다**(회차 일괄 아님). 스택 은유상 카드마다 개별
 * 결정이 자연스럽고, 그래야 `24시간 안 보기` 가 **아직 보지도 않은 공지를 삼키지 않는다**.
 */
export function NoticePopup({
  notices,
  onDone,
  stores = defaultNoticeStores(),
  now = () => Date.now(),
}: {
  notices: Notice[];
  onDone: () => void;
  /** 테스트 주입용 — 기본은 브라우저 저장소. */
  stores?: NoticeStores;
  now?: () => number;
}) {
  const [index, setIndex] = useState(0);
  const current = notices[index];
  if (!current) return null;

  const total = notices.length;
  const remaining = total - index - 1;
  const behind = Math.min(remaining, MAX_BEHIND);

  function advance() {
    if (index + 1 >= total) onDone();
    else setIndex((i) => i + 1);
  }

  function close() {
    markNoticeClosed(stores, noticeSuppressionKey(current!));
    advance();
  }

  function dismiss24h() {
    markNoticeDismissed(stores, noticeSuppressionKey(current!), now());
    advance();
  }

  return (
    <Modal
      // 장이 바뀌면 새 카드로 포커스가 옮겨가도록 다시 마운트한다(스크린리더가 새 제목을 읽는다).
      key={current.id}
      onClose={close}
      labelledBy="notice-popup-title"
      overlayClassName={styles.overlay}
      className={styles.stack}
      testId="notice-popup"
      overlayTestId="notice-popup-overlay"
      // 본문에 링크가 있으면 DOM 순서상 그게 첫 포커서블이라 **Enter 한 번에 외부 사이트로 나간다**.
      // 주 동작(닫기)에 포커스를 둔다.
      initialFocus='[data-testid="notice-close"]'
    >
      {/* testid 는 편의가 아니라 **계약의 측정점**이다 — 겹침 "두께"를 픽셀로 단언하려면
          뒤 카드를 개별로 집을 수 있어야 한다(개수만 세면 겹침이 사라져도 green 이었다). */}
      {Array.from({ length: behind }, (_, i) => (
        <div
          key={`behind-${i}`}
          className={`${styles.behind} ${i === 0 ? styles.behind1 : styles.behind2}`}
          data-testid={`notice-behind-${i + 1}`}
          aria-hidden="true"
        />
      ))}

      <div className={styles.card} data-testid="notice-card">
        <div className={styles.top}>
          <span className={styles.kicker}>공지</span>
          {total > 1 && (
            <span className={styles.pager} data-testid="notice-pager">
              {index + 1} / {total}
            </span>
          )}
        </div>

        <h2 id="notice-popup-title" className={styles.title} data-testid="notice-title">
          {current.title}
        </h2>

        {noticeMetaText(current) && (
          <p className={styles.meta} data-testid="notice-meta">
            {noticeMetaText(current)}
          </p>
        )}

        <NoticeBody body={current.body} className={styles.body} testId="notice-body" />

        {total > 1 && (
          <div className={styles.dots} data-testid="notice-dots">
            {notices.map((n, i) => (
              <span
                key={n.id}
                className={`${styles.dot} ${i === index ? styles.dotOn : ""}`}
                data-on={i === index ? "true" : undefined}
              />
            ))}
          </div>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            data-testid="notice-close"
            onClick={close}
          >
            닫기
          </button>
          <button
            type="button"
            className={styles.ghost}
            data-testid="notice-dismiss-24h"
            onClick={dismiss24h}
          >
            24시간 동안 안 보기
          </button>
        </div>
      </div>
    </Modal>
  );
}

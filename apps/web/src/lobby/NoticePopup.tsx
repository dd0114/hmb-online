import { useCallback, useEffect, useRef, useState } from "react";
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
  suppressible = true,
}: {
  notices: Notice[];
  onDone: () => void;
  /** 테스트 주입용 — 기본은 브라우저 저장소. */
  stores?: NoticeStores;
  now?: () => number;
  /**
   * 닫을 때 **억제를 기록하는가**. 기본 true(로비의 저절로 뜨는 팝업).
   *
   * 공유 딥링크(#298)는 false 다 — 유저가 **링크를 눌러 명시적으로 요청한** 공지라 "봤다"를
   * 기록할 대상이 아니다. 기록하면 링크 한 번 눌렀다는 이유로 그 공지가 로비에서 사라지고,
   * 반대로 이미 24h 숨김을 누른 공지를 딥링크로 열었다가 닫으면 억제 만료가 **연장**된다 —
   * 어느 쪽도 유저가 요청한 적 없는 부작용이다.
   *
   * false 면 [24시간 동안 안 보기] 버튼도 그리지 않는다. 아무것도 안 하는 버튼은 거짓말이다.
   */
  suppressible?: boolean;
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
    if (suppressible) markNoticeClosed(stores, noticeSuppressionKey(current!));
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

        <ScrollableBody body={current.body} />

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
          {suppressible && (
            <button
              type="button"
              className={styles.ghost}
              data-testid="notice-dismiss-24h"
              onClick={dismiss24h}
            >
              24시간 동안 안 보기
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * 본문 스크롤 영역 (#292).
 *
 * ⚠️ **스크롤이 되는 것과 스크롤이 된다고 보이는 것은 다른 축이다.** 본문은 #248 때부터
 * `overflow-y:auto` 였지만, 라이브 공지(히어로 이미지 + 패치 목록)는 390×844 첫 화면에
 * **496px 이 접혀 있으면서 아무 신호도 주지 않았다** — 이미지 아래 한 줄만 보이니 그게 본문의
 * 끝처럼 읽힌다(hero 제보의 실체). 그래서 두 층을 같이 건다:
 *
 *  ① **상시 스크롤바** — `::-webkit-scrollbar` 를 명시하면 오버레이(사라지는) 스크롤바 대신
 *    자리를 차지하는 막대가 그려진다.
 *  ② **하단 페이드** — 스크롤바만으로는 **iOS 사파리에서 안 그려진다**(커스텀 스크롤바 미지원).
 *    폰이 주 타깃인 화면에서 한 축만 두면 그 기기에선 고친 게 아니다.
 *
 * 페이드는 **끝에 닿으면 사라진다** — 남아 있으면 다 읽은 뒤에도 "아직 더 있다"고 거짓말한다.
 */
function ScrollableBody({ body }: { body: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const overflow = el.scrollHeight - el.clientHeight;
    // 1px 여유 — 소수점 레이아웃에서 끝에 닿아도 0 이 되지 않는다.
    setMore(overflow > 1 && el.scrollTop < overflow - 1);
  }, []);

  useEffect(() => {
    measure();
    const el = scrollRef.current;
    if (!el) return;
    // 공지 본문은 **이미지가 늦게 온다** — 로드 전에 잰 높이로 판단하면 접힌 본문에 신호가 없다.
    const imgs = Array.from(el.querySelectorAll("img"));
    imgs.forEach((img) => img.addEventListener("load", measure));
    // 뷰포트 회전·주소창 접힘으로 스크롤 영역 자체가 커지면 신호가 사라져야 한다.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    const content = el.firstElementChild;
    if (content) ro?.observe(content);
    return () => {
      imgs.forEach((img) => img.removeEventListener("load", measure));
      ro?.disconnect();
    };
  }, [measure, body]);

  return (
    <div className={styles.bodyArea} data-more={more ? "true" : "false"} data-testid="notice-body-area">
      <div
        ref={scrollRef}
        className={styles.body}
        data-testid="notice-body"
        onScroll={measure}
        // 키보드만 쓰는 사용자도 본문을 내릴 수 있어야 한다(버튼 두 개만 포커서블이면 갇힌다).
        tabIndex={0}
        role="group"
        aria-label="공지 본문"
      >
        <NoticeBody body={body} />
      </div>
    </div>
  );
}

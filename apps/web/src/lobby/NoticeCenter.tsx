import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Modal } from "../common/Modal";
import { NoticeBody } from "../common/NoticeBody";
import {
  defaultNoticeStores,
  markNoticeClosed,
  noticeCenterView,
  noticeMetaText,
  noticeSuppressionKey,
  noticeSuppressionVersion,
  subscribeNoticeSuppression,
  type NoticeStores,
} from "./notice-logic";
import styles from "./NoticeCenter.module.css";

/**
 * 공지 **다시 보기** 진입점 (#248 UX 후속).
 *
 * ### 왜 필요한가
 * 지금까지 공지가 존재하는 화면은 팝업 하나뿐이었다. 닫으면 그 탭 세션에선 끝이고,
 * [닫기]로 억제한 사이 노출 기간이 끝나면 **영영 못 본다**. 점검·보상 공지는
 * "몇 시부터랬지?"를 다시 확인하러 오는 성격이라 한 번 읽고 끝나면 안 된다.
 *
 * ### 설계 결정 (근거를 남긴다)
 *
 * 1. **자리 = 로비 헤더 오른쪽**, 지갑 배지와 [로그아웃] 사이. 공지는 계정/상태 정보에 가깝고
 *    메뉴 버튼(게임 시작·덱·상점·도감)과 성격이 다르다. 다만 390px 헤더는 이미 빡빡해서
 *    (#232 이후 재화 라벨이 넘치는 선존 이슈가 있었다 — 실측 docOverflow 11px) **아이콘 하나
 *    크기로 고정**하고, 넘치지 않음을 e2e 계약으로 박았다.
 *
 * 2. **공지 0건이면 진입점을 숨긴다**(비활성 버튼도, 빈 목록도 아니다). 이유 둘:
 *    ① 0건은 예외가 아니라 **대부분의 시간에 해당하는 정상 상태**다. 그동안 아무것도 못 여는
 *       버튼이 이미 빡빡한 헤더를 영구히 좁힌다.
 *    ② 조회 실패(500·구 서버의 `{}`)와 진짜 0건은 **화면에서 구별할 수 없다**. 빈 목록을 열어
 *       "공지가 없습니다"라고 단언하면 서버가 죽었을 때 거짓말이 된다. 안 보여주는 쪽이 정직하다.
 *    잃는 것 = 발견 가능성인데, 애초에 공지가 없을 때는 열어도 볼 게 없으므로 손해가 아니다.
 *
 * 3. **팝업과 같은 렌더러**(`NoticeBody`)를 쓴다. 따로 만들면 서식·이미지·링크 살균 규칙이
 *    조용히 갈라진다(#248 이 admin 미리보기에 적용한 규율과 같다).
 *
 * 4. **억제는 팝업에만 적용된다** — [닫기]로 억제한 공지도 목록엔 있다(`noticeCenterView`).
 *    거꾸로, 목록에서 **펼쳐 읽으면 그 장을 읽은 것으로 친다**(세션 억제 기록). 안 그러면
 *    "다 읽었는데 점이 안 꺼진다"가 되고, 팝업이 같은 공지를 또 들이민다.
 */
export function NoticeCenter({
  notices,
  stores = defaultNoticeStores(),
  now = () => Date.now(),
}: {
  /** `useActiveNotices()` 의 원시 응답 — **정규화 전**이다(형태를 믿지 않는다). */
  notices: unknown;
  /** 테스트 주입용. */
  stores?: NoticeStores;
  now?: () => number;
}) {
  const [open, setOpen] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  /**
   * 억제 저장소는 React 상태가 아니라 브라우저 저장소이고, **쓰는 쪽이 여기만이 아니다** —
   * 공지 팝업의 [닫기]가 같은 저장소를 쓴다. 로컬 카운터로 자기 쓰기만 반영하면
   * "팝업에서 다 닫았는데 헤더의 점이 그대로"가 된다(e2e 가 실제로 잡았다). 그래서 저장소
   * 버전을 **구독**한다 — 누가 쓰든 여기 숫자가 따라온다.
   */
  const suppressionVersion = useSyncExternalStore(
    subscribeNoticeSuppression,
    noticeSuppressionVersion,
    noticeSuppressionVersion,
  );

  const view = useMemo(
    () => noticeCenterView(notices, now(), stores),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notices, suppressionVersion],
  );

  // ⚠️ 읽음 기록은 **상태 업데이터 안에서 하지 않는다** — 업데이터는 렌더 중에 (StrictMode 에선
  // 두 번) 불릴 수 있고, 그 안에서 외부 스토어를 흔들면 렌더 중 구독자 갱신이 된다.
  const toggle = useCallback(
    (key: string) => {
      if (expandedKey === key) {
        setExpandedKey(null);
        return;
      }
      // 펼친 순간 = 읽은 것 — **탭 세션 범위**로만 기록한다.
      // ⚠️ #473 이후 팝업 [닫기]는 일주일 억제지만 여기는 따라가지 않는다: 목록을 훑다 행을
      // 펼친 것만으로 앞으로 뜰 팝업을 일주일 죽이면, 유저가 요청한 적 없는 부작용이 된다.
      // 읽음(안 읽음 점 해제)과 닫음(억제)은 다른 행위다.
      markNoticeClosed(stores, key);
      setExpandedKey(key);
    },
    [expandedKey, stores],
  );

  // 공지가 0건이면 진입점 자체가 없다(위 설계 결정 2).
  if (view.all.length === 0) return null;

  const unread = view.unread.length;

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        data-testid="notice-center-open"
        data-unread={unread}
        aria-label={unread > 0 ? `공지 — 안 읽음 ${unread}건` : "공지"}
        onClick={() => setOpen(true)}
      >
        <NoticeGlyph />
        {unread > 0 && (
          <span className={styles.dot} data-testid="notice-center-dot" aria-hidden="true" />
        )}
      </button>

      {open && (
        <Modal
          onClose={() => setOpen(false)}
          labelledBy="notice-center-title"
          overlayClassName={styles.overlay}
          className={styles.panel}
          testId="notice-center"
          initialFocus='[data-testid="notice-center-close"]'
        >
          <h2 id="notice-center-title" className={styles.title}>
            공지사항
          </h2>
          {/* 목록만 스크롤한다 — 본문이 아무리 길어도 [닫기]는 화면에 남아야 한다. */}
          <ul className={styles.list} data-testid="notice-center-list">
            {view.all.map((n) => {
              const key = noticeSuppressionKey(n);
              const expanded = expandedKey === key;
              const meta = noticeMetaText(n);
              return (
                <li key={key} className={styles.item} data-testid="notice-center-item" data-id={n.id}>
                  <button
                    type="button"
                    className={styles.itemHead}
                    data-testid="notice-center-item-toggle"
                    aria-expanded={expanded}
                    onClick={() => toggle(key)}
                  >
                    <span className={styles.itemTitle}>
                      {view.unreadKeys.has(key) && (
                        <span
                          className={styles.itemDot}
                          data-testid="notice-center-item-dot"
                          aria-label="안 읽음"
                        />
                      )}
                      {n.title}
                    </span>
                    {meta && <span className={styles.itemMeta}>{meta}</span>}
                  </button>
                  {expanded && (
                    <NoticeBody
                      body={n.body}
                      className={styles.itemBody}
                      testId="notice-center-body"
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className={styles.close}
            data-testid="notice-center-close"
            onClick={() => setOpen(false)}
          >
            닫기
          </button>
        </Modal>
      )}
    </>
  );
}

/** 확성기 글리프 — 이모지는 OS 마다 크기·색이 달라 헤더 폭 예산이 흔들린다. 인라인 SVG 로 고정. */
function NoticeGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M4 9v6h3l7 4V5L7 9H4zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"
        fill="currentColor"
      />
    </svg>
  );
}

import { useNavigate, useParams } from "react-router-dom";
import { useNoticeById } from "../api/notice-hooks";
import { ApiError } from "../api/client";
import { Layout } from "../common/Layout";
import { NoticePopup } from "../lobby/NoticePopup";
import { normalizeNotice } from "../lobby/notice-logic";
import styles from "./ShareNoticePage.module.css";

/**
 * 공지 공유 딥링크 화면 — `/share/notice/{id}` (#298, 에픽 #293).
 *
 * ### 왜 로비에 주입하지 않고 전용 화면인가
 * 로비의 공지 팝업은 **저절로 뜨는** 것이라 억제(닫기/24h)·튜토리얼 홀드·팝업 큐가 전부 걸려
 * 있다(`lobby-popup.ts`·`visibleNotices`). 딥링크는 성격이 정반대다 — **유저가 링크를 눌러
 * 명시적으로 요청한** 공지이고, 그게 이 방문의 목적이다. 로비 큐에 밀어 넣으면 그 규칙들을
 * 하나씩 예외 처리해야 하고, 그 예외가 곧 로비 팝업의 회귀가 된다. 그래서 **표시 경로를 분리**
 * 하고 억제 저장소는 읽지도 쓰지도 않는다(`suppressible={false}`).
 *
 * ### 상태 매핑 — 판정은 서버가 한다
 * LIVE 200 / EXPIRED·OFF **410** / SCHEDULED·DELETED·없는 id **404** (#297 hero 확정).
 * 화면은 기간을 다시 계산하지 않는다 — 그러면 **기기 시계가 진실이 된다**(notice-logic.ts 머리말).
 *
 * ### 흰 화면 금지 (#274 부류)
 * 어느 분기에서도 화면은 비지 않는다: 로딩·만료·없음·손상 응답 전부 **문구 + 하단 네비 + 로비
 * 버튼**을 그린다. 부가 기능의 실패가 막다른 길이 되면 안 된다.
 */

/** 상태별 안내 — **문구가 서로 다른 것이 계약이다**(만료와 오타를 유저가 구분할 수 있어야 한다). */
const COPY = {
  loading: { title: "공지를 불러오는 중…", detail: "" },
  gone: {
    title: "기간이 지난 공지입니다",
    detail: "이 공지는 게시 기간이 끝났거나 내려갔습니다.",
  },
  notfound: {
    title: "찾을 수 없는 공지입니다",
    detail: "링크가 잘못되었거나 삭제된 공지일 수 있습니다.",
  },
  error: {
    title: "공지를 불러오지 못했습니다",
    detail: "잠시 후 다시 시도해 주세요.",
  },
} as const;

type ShareNoticeState = keyof typeof COPY;

/**
 * 응답/에러 → 화면 상태. **순수 판정**이라 여기만 보면 분기 규칙 전체가 보인다.
 *
 * ⚠️ 200 인데 모양이 아닌 경우(구 서버·프록시의 `{}`)를 `notfound` 로 흡수하는 것이 핵심이다 —
 * 여기서 흘리면 `notice.title` 접근이 던져 화면이 통째로 흰 화면이 된다.
 */
export function shareNoticeStateOf(args: {
  hasId: boolean;
  isPending: boolean;
  error: unknown;
}): ShareNoticeState {
  if (!args.hasId) return "notfound";
  if (args.error) {
    const status = args.error instanceof ApiError ? args.error.status : 0;
    if (status === 410) return "gone";
    if (status === 404) return "notfound";
    return "error"; // 500·네트워크 단절 — "없는 공지"라고 거짓말하지 않는다
  }
  if (args.isPending) return "loading";
  // 200 인데 정규화가 못 통과한 응답(`{}` 등) — 흰 화면 대신 안내로 흡수한다.
  return "notfound";
}

export function ShareNoticePage() {
  const { id } = useParams<{ id: string }>();
  const noticeId = (id ?? "").trim();
  const navigate = useNavigate();
  const query = useNoticeById(noticeId);
  const notice = query.error ? null : normalizeNotice(query.data);

  function toLobby() {
    navigate("/lobby", { replace: true });
  }

  if (notice) {
    return (
      // 팝업 뒤에 로비를 흉내 낸 화면을 그리지 않는다 — 이 방문의 목적은 공지 한 건이고,
      // 닫으면 로비로 간다. 네비는 남겨 둔다(공지를 읽고 다른 데로 갈 수 있어야 한다).
      <Layout nav>
        <div className={styles.page} data-testid="share-notice-page" data-state="live">
          <NoticePopup notices={[notice]} onDone={toLobby} suppressible={false} />
        </div>
      </Layout>
    );
  }

  const state = shareNoticeStateOf({
    hasId: noticeId.length > 0,
    isPending: query.isPending,
    error: query.error,
  });
  const copy = COPY[state];

  return (
    <Layout nav>
      <div className={styles.page} data-testid="share-notice-page" data-state={state}>
        <div className={styles.card} data-testid="share-notice-message" data-state={state}>
          <span className={styles.kicker}>공지</span>
          <h1 className={styles.title}>{copy.title}</h1>
          {copy.detail && <p className={styles.detail}>{copy.detail}</p>}
          <button
            type="button"
            className={styles.primary}
            data-testid="share-notice-to-lobby"
            onClick={toLobby}
          >
            로비로 가기
          </button>
        </div>
      </div>
    </Layout>
  );
}

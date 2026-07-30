import { useMemo, useState } from "react";
import { Amount } from "../common/Amount";
import { CURRENCY_GEM, CURRENCY_POINT } from "../common/currency";
import { Modal } from "../common/Modal";
import { NoticeBody } from "../common/NoticeBody";
import { useClaimMail, useMails, useReadMail } from "../api/mail-hooks";
import { useMe, usePlayers } from "../api/hooks";
import type { Mail } from "../api/mails";
import {
  attachmentChips,
  canClaim,
  hasAttachments,
  normalizeMails,
  sentLine,
  stateLabel,
} from "./mail-logic";
import styles from "./MailCenter.module.css";

/**
 * 우편함 진입점 + 목록 + 상세 (#323, hero 확정 = **홈 헤더 ✉️**).
 *
 * ### 자리와 모양 (되돌리려는 사람을 위해)
 * 1. **홈 헤더 왼쪽, 공지 벨 옆**. 첨부는 <b>만료되는 자산</b>이라 발견성이 곧 손해와 직결된다 —
 *    공지(놓쳐도 손해 없음)와 다른 축이다. ⚠️ #248 이 이 자리를 "+8px" 로 측정했지만 **그 전제는
 *    틀렸다**: 실측하니 오른쪽(지갑 2칩 204px + [로그아웃] 62px)이 `flex:0 0 auto` 로 272px 를
 *    고정 점유해 왼쪽 몫이 90px 뿐이었고, 진입점 두 개(56px+gap)를 넣자 닉네임이 22px 로 눌리거나
 *    지갑 위로 **겹쳐 그려졌다**. 그래서 **닉네임을 홈 헤더에서 뺐다**(hero 확정) — 이름은 바로
 *    아래 팀 카드와 [내 정보]가 말한다. 되살리려면 오른쪽에서 먼저 빼라(HomePage.module.css 주석).
 * 2. **뱃지는 숫자, 공지는 점.** 공지는 몇 건인지가 의미 없지만 우편은 <b>숫자가 곧 할 일 개수</b>다.
 *    글리프도 봉투/확성기로 다르다 — 겹치면 "보상 왔다"와 "점검 안내"가 구별되지 않는다.
 * 3. **우편이 0건이면 진입점을 숨긴다**(공지 진입점과 같은 규율). 0건은 예외가 아니라 대부분의
 *    시간이고, 조회 실패(500·구 서버 `{}`)와 진짜 0건은 화면에서 구별할 수 없다 — 빈 목록을 열어
 *    "우편이 없습니다"라고 단언하면 서버가 죽었을 때 거짓말이 된다.
 *
 * ### 상태는 서버가 정한다
 * 목록의 만료·수령 표시는 전부 서버 `state` 다. 화면이 `expiresAt < now` 를 계산하면 기기 시계가
 * 진실이 된다. **만료된 미수령도 목록에 남는다**(hero 확정 ④) — 놓쳤다는 사실이 보여야 다음엔
 * 안 놓친다. 대신 뱃지(`unread`)에는 안 센다: 끌 수 없는 숫자가 남으면 뱃지가 무의미해진다.
 */
export function MailCenter() {
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const read = useReadMail();

  /**
   * 헤더는 `/api/me.mail` 의 두 숫자만으로 그린다 — **목록은 열 때 받는다**(독립검증 MINOR-1:
   * 그 필드를 만들어 놓고 아무도 안 써서 홈 진입마다 본문까지 실린 목록을 받고 있었다).
   *
   * ⚠️ 구 서버(필드 없음)에서는 **목록으로 폴백**한다. web 은 CF Pages 로 서버와 따로 배포되므로
   * 버전 스큐가 실재하고, 그때 우편함이 통째로 사라지면 유저는 받을 게 있는지조차 모른다.
   */
  const summary = me?.mail;
  const { data } = useMails(open || (Boolean(me) && summary === undefined));

  const view = useMemo(() => normalizeMails(data), [data]);
  const unread = summary ? summary.unread : view.unread;
  const total = summary ? summary.total : view.mails.length;

  // 우편이 0건이면 진입점 자체가 없다 — 열린 채로 0건이 되는 창(마지막 우편 수령)만 예외.
  if (total === 0 && !open) {
    return null;
  }

  function openMail(mail: Mail) {
    setExpandedId((cur) => {
      const next = cur === mail.id ? null : mail.id;
      // 펼칠 때만 읽음 기록. 실패해도 화면을 막지 않는다(멱등이라 다음에 다시 쓰인다).
      if (next && mail.state === "UNREAD") {
        read.mutate(mail.id);
      }
      return next;
    });
  }

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        data-testid="mail-center-open"
        data-unread={unread}
        aria-label={unread > 0 ? `우편함 — 받을 것 ${unread}건` : "우편함"}
        onClick={() => setOpen(true)}
      >
        <MailGlyph />
        {unread > 0 && (
          <span className={styles.count} data-testid="mail-center-badge">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <Modal
          onClose={() => setOpen(false)}
          labelledBy="mail-center-title"
          overlayClassName={styles.overlay}
          className={styles.panel}
          testId="mail-center"
          initialFocus='[data-testid="mail-center-close"]'
        >
          <h2 className={styles.title} id="mail-center-title">
            우편함
          </h2>
          <ul className={styles.list} data-testid="mail-list">
            {view.mails.map((mail) => (
              <MailRow
                key={mail.id}
                mail={mail}
                expanded={expandedId === mail.id}
                onToggle={() => openMail(mail)}
              />
            ))}
          </ul>
          <button
            type="button"
            className={styles.close}
            data-testid="mail-center-close"
            onClick={() => setOpen(false)}
          >
            닫기
          </button>
        </Modal>
      )}
    </>
  );
}

function MailRow({
  mail,
  expanded,
  onToggle,
}: {
  mail: Mail;
  expanded: boolean;
  onToggle: () => void;
}) {
  const claim = useClaimMail();
  const chips = attachmentChips(mail.attachments);
  const label = stateLabel(mail);

  return (
    <li
      className={styles.item}
      data-testid="mail-item"
      data-mail-id={mail.id}
      data-state={mail.state}
    >
      <button type="button" className={styles.itemHead} onClick={onToggle} aria-expanded={expanded}>
        <span className={styles.itemTitle}>
          {mail.state === "UNREAD" && <span className={styles.itemDot} aria-label="안 읽음" />}
          {mail.title}
        </span>
        <span className={styles.itemMeta}>{sentLine(mail)}</span>
        {(chips.length > 0 || label) && (
          <span className={styles.chips}>
            {chips.map((chip) => (
              <span key={chip.key} className={styles.chip}>
                {chip.kind === "points" && <Amount code={CURRENCY_POINT} value={chip.value} />}
                {chip.kind === "gems" && <Amount code={CURRENCY_GEM} value={chip.value} />}
                {chip.kind === "player" && <PlayerChip playerId={chip.playerId} count={chip.count} />}
              </span>
            ))}
            {label && (
              <span
                className={mail.state === "EXPIRED" ? styles.tagMuted : styles.tag}
                data-testid="mail-state-label"
              >
                {label}
              </span>
            )}
          </span>
        )}
      </button>

      {expanded && (
        <div className={styles.itemBody}>
          {/* 팝업·공지 센터와 **같은 렌더러**를 쓴다 — 따로 만들면 서식·링크 살균 규칙이 갈라진다. */}
          <NoticeBody body={mail.body} />
          {hasAttachments(mail.attachments) && (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.claim}
                data-testid="mail-claim"
                disabled={!canClaim(mail) || claim.isPending}
                onClick={() => claim.mutate(mail.id)}
              >
                {mail.state === "CLAIMED"
                  ? "수령 완료"
                  : mail.state === "EXPIRED"
                    ? "수령 기간이 지났습니다"
                    : claim.isPending
                      ? "받는 중…"
                      : "받기"}
              </button>
              {/* 서버가 준 문구를 그대로 보여준다 — 410(만료·회수)의 이유가 서버에만 있다. */}
              {claim.isError && (
                <p className={styles.error} data-testid="mail-claim-error">
                  {claim.error instanceof Error ? claim.error.message : "받지 못했습니다"}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * 카드 첨부 한 칩. 이름은 카탈로그에서 찾고, **없으면 id 를 그대로** 보여준다 —
 * 지어낸 이름은 "뭘 받았는지"를 틀리게 말한다(응답 형태를 믿지 않는 규율과 같은 결).
 */
function PlayerChip({ playerId, count }: { playerId: string; count: number }) {
  const { data: players } = usePlayers();
  const roster = Array.isArray(players) ? players : [];
  const name = roster.find((p) => p.id === playerId)?.name;
  return (
    <>
      {name ?? playerId} {count}장
    </>
  );
}

/** 봉투 — 공지의 확성기(`NoticeGlyph`)와 **반드시 달라야** 한다. */
function MailGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Zm2.2.5 6.8 4.9L18.8 7H5.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

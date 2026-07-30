import { useState } from "react";
import { useAdminMailHistory, useAdminMails, useMailOps } from "../api/mail-admin-hooks";
import { formatStamp } from "./admin-logic";
import {
  claimRateText,
  EMPTY_MAIL_FORM,
  mailOpErrorMessage,
  normalizeCampaigns,
  targetSummary,
  toSendBody,
  validateMailForm,
  type MailFormValues,
} from "./mail-admin-logic";
import styles from "./AdminPage.module.css";
import m from "./MailsPanel.module.css";

/**
 * 우편 운영 패널 (#323 W4) — 발송 · 발송 이력(수령률) · 회수 · 액션 이력.
 *
 * <p>공지(#248)와 같은 규율: admin 게이트 뒤 · **사유 필수** · **성공·실패 모두 이력** · 재배포 0.
 * 다른 점 하나 — 이 패널은 <b>재화를 발행</b>한다. 그래서 두 겹을 더 둔다:
 * <ol>
 *   <li><b>전체 발송은 한 번 더 확인</b>받는다. 되돌릴 수 없는 인플레이션이고, 회수는
 *       미수령분만 막는다(이미 받은 사람의 지갑은 손대지 않는다).</li>
 *   <li><b>멱등키를 클라가 만든다.</b> 서버 채번에 맡기면 그 요청은 재전송 보호를 못 받는다 —
 *       네트워크가 끊긴 뒤 [다시]를 누르면 같은 키로 나가 두 번 발행되지 않는다.</li>
 * </ol>
 */
export function MailsPanel() {
  const list = useAdminMails();
  const history = useAdminMailHistory();
  const { send, revoke } = useMailOps();

  const [form, setForm] = useState<MailFormValues>(EMPTY_MAIL_FORM);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** 이 제출의 멱등키 — 실패 후 재시도에 **같은 키**를 써야 두 번 나가지 않는다. */
  const [idemKey, setIdemKey] = useState<string | null>(null);

  const campaigns = normalizeCampaigns(list.data);
  const entries = Array.isArray(history.data) ? history.data : [];
  const validation = validateMailForm(form);
  const target = targetSummary(form);
  const busy = send.isPending || revoke.isPending;

  function set<K extends keyof MailFormValues>(key: K, value: MailFormValues[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function submit() {
    setTouched(true);
    if (!validation.ok) return;
    // 전체 발송은 확인 한 번 더 — 대상이 전원이면 오타의 대가가 회수 불가능한 발행이다.
    if (form.audience === "ALL" && !confirming) {
      setConfirming(true);
      return;
    }
    const key = idemKey ?? crypto.randomUUID();
    setIdemKey(key);
    send.mutate(
      { body: toSendBody(form), idempotencyKey: key },
      {
        onSuccess: () => {
          setNotice("발송했습니다. 아래 이력에서 수령률을 확인하세요.");
          setError(null);
          setForm(EMPTY_MAIL_FORM);
          setTouched(false);
          setConfirming(false);
          setIdemKey(null);   // 다음 발송은 새 키
        },
        onError: (err) => {
          // ⚠️ 키를 버리지 않는다 — 같은 내용의 재시도가 새 키로 나가면 **두 번 발행**된다.
          setError(mailOpErrorMessage(err, "발송하지 못했습니다"));
          setNotice(null);
          setConfirming(false);
        },
      },
    );
  }

  return (
    <section className={styles.section} data-testid="admin-mails">
      <h2 className={styles.sectionTitle}>우편 발송</h2>
      <p className={m.hint}>
        보상(카드·G·Z)을 붙여 보내면 유저가 홈 헤더 ✉️ 에서 [받기]로 수령합니다. 지급은 수령 시점에
        기존 지갑·원장 경로로 일어납니다 — 발송 자체는 재화를 옮기지 않습니다.
      </p>

      <div className={m.form}>
        <div className={m.row}>
          <label className={m.label} htmlFor="mail-audience">대상</label>
          <select
            id="mail-audience"
            className={m.input}
            data-testid="mail-audience"
            value={form.audience}
            onChange={(e) => { set("audience", e.target.value as MailFormValues["audience"]); setConfirming(false); }}
          >
            <option value="USERS">지정 유저</option>
            <option value="ALL">전체 유저</option>
          </select>
          <span className={m.aside} data-testid="mail-target-summary">{target.label}</span>
        </div>

        {form.audience === "USERS" && (
          <div className={m.row}>
            <label className={m.label} htmlFor="mail-userids">유저 id</label>
            <textarea
              id="mail-userids"
              className={m.input}
              data-testid="mail-userids"
              rows={2}
              placeholder="줄바꿈 또는 쉼표로 구분 — [유저] 탭 검색에서 복사"
              value={form.userIds}
              onChange={(e) => set("userIds", e.target.value)}
            />
          </div>
        )}

        <Field id="mail-title" label="제목" error={touched ? validation.errors.title : undefined}>
          <input id="mail-title" className={m.input} data-testid="mail-title"
                 value={form.title} onChange={(e) => set("title", e.target.value)} />
        </Field>

        <Field id="mail-body" label="본문" error={touched ? validation.errors.body : undefined}>
          <textarea id="mail-body" className={m.input} data-testid="mail-body" rows={4}
                    value={form.body} onChange={(e) => set("body", e.target.value)} />
        </Field>

        <div className={m.grid3}>
          <Field id="mail-points" label="G" error={touched ? validation.errors.points : undefined}>
            <input id="mail-points" className={m.input} data-testid="mail-points" inputMode="numeric"
                   placeholder="0" value={form.points} onChange={(e) => set("points", e.target.value)} />
          </Field>
          <Field id="mail-gems" label="Z" error={touched ? validation.errors.gems : undefined}>
            <input id="mail-gems" className={m.input} data-testid="mail-gems" inputMode="numeric"
                   placeholder="0" value={form.gems} onChange={(e) => set("gems", e.target.value)} />
          </Field>
          <Field id="mail-expiry" label="수령 기한(일)" error={touched ? validation.errors.expiresInDays : undefined}>
            <input id="mail-expiry" className={m.input} data-testid="mail-expiry" inputMode="numeric"
                   placeholder="비우면 무기한" value={form.expiresInDays}
                   onChange={(e) => set("expiresInDays", e.target.value)} />
          </Field>
        </div>

        <Field id="mail-players" label="카드" error={touched ? validation.errors.players : undefined}>
          <input id="mail-players" className={m.input} data-testid="mail-players"
                 placeholder="P001:2, P010 (개수 생략 = 1장)"
                 value={form.players} onChange={(e) => set("players", e.target.value)} />
        </Field>

        <Field id="mail-reason" label="운영 사유" error={touched ? validation.errors.reason : undefined}>
          <input id="mail-reason" className={m.input} data-testid="mail-reason"
                 placeholder="감사 원장에 남습니다 (예: v3.02 패치 보상 #323)"
                 value={form.reason} onChange={(e) => set("reason", e.target.value)} />
        </Field>

        {confirming && (
          <p className={m.warn} data-testid="mail-confirm">
            ⚠️ <b>전체 유저</b>에게 보냅니다. 되돌릴 수 없습니다 — 회수는 <b>미수령분만</b> 막고, 이미
            받은 사람의 지갑은 그대로입니다. 한 번 더 [보내기]를 누르면 발송합니다.
          </p>
        )}

        <button type="button" className={m.submit} data-testid="mail-send"
                disabled={busy} onClick={submit}>
          {send.isPending ? "보내는 중…" : confirming ? "정말 전체에게 보내기" : "보내기"}
        </button>

        {error && <p className={m.error} data-testid="mail-error">{error}</p>}
        {notice && <p className={m.ok} data-testid="mail-notice">{notice}</p>}
      </div>

      <h3 className={m.subTitle}>발송 이력</h3>
      {campaigns.length === 0 ? (
        <p className={m.empty} data-testid="mail-campaigns-empty">아직 보낸 우편이 없습니다.</p>
      ) : (
        <ul className={m.list} data-testid="mail-campaigns">
          {campaigns.map((c) => (
            <li key={c.id} className={m.item} data-testid="mail-campaign" data-campaign-id={c.id}>
              <div className={m.itemHead}>
                <b>{c.title}</b>
                <span className={m.badge}>{c.audience === "ALL" ? "전체" : "지정"}</span>
                {c.revokedAt && <span className={m.badgeWarn} data-testid="mail-revoked">회수됨</span>}
              </div>
              <div className={m.itemMeta}>
                {claimRateText(c)} · 열람 {c.readCount} · {c.actor} · {formatStamp(c.createdAt)}
                {c.expiresAt ? ` · 기한 ${formatStamp(c.expiresAt)}` : " · 무기한"}
              </div>
              <div className={m.itemMeta}>사유: {c.reason}</div>
              {!c.revokedAt && (
                <button
                  type="button"
                  className={m.revoke}
                  data-testid="mail-revoke"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt("회수 사유(감사 원장에 남습니다)");
                    if (!reason) return;
                    revoke.mutate(
                      { id: c.id, reason },
                      {
                        onSuccess: () => { setNotice("회수했습니다(미수령분만)."); setError(null); },
                        onError: (err) => setError(mailOpErrorMessage(err, "회수하지 못했습니다")),
                      },
                    );
                  }}
                >
                  회수(미수령분)
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className={m.subTitle}>운영 이력(성공·실패)</h3>
      <ul className={m.audit} data-testid="mail-audit">
        {entries.slice(0, 20).map((e: Record<string, unknown>, i: number) => (
          <li key={String(e.id ?? i)} className={m.auditRow}>
            <span className={String(e.result) === "ok" ? m.ok : m.error}>{String(e.result)}</span>
            <span>{String(e.action)}</span>
            <span className={m.aside}>{String(e.actor ?? "")}</span>
            <span className={m.aside}>{formatStamp(String(e.createdAt ?? ""))}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={m.row}>
      <label className={m.label} htmlFor={id}>{label}</label>
      {children}
      {error && <span className={m.fieldError}>{error}</span>}
    </div>
  );
}

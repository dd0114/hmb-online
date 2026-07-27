import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import {
  newIdempotencyKey,
  useAdminUnitDetail,
  useAdminUnits,
  useCreateUnit,
  useSetUnitActive,
  useUpdateUnit,
} from "../api/admin-unit-hooks";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import { GRADE_COLORS, GRADE_LABELS, GRADE_ORDER } from "../common/grades";
import type { Grade } from "../common/grades";
import { formatStamp } from "./admin-logic";
import {
  ATTRIBUTE_KEYS,
  ATTRIBUTE_LABELS,
  AUDIT_ACTION_LABELS,
  PERSONALITIES,
  PERSONALITY_LABELS,
  POSITIONS,
  UNIT_PAGE_SIZE,
  auditChangeSummary,
  buildCreateRequest,
  buildPatchRequest,
  describeGradeImpact,
  emptyUnitForm,
  formatOvrDelta,
  parseGradeImpact,
  unitFormFromUnit,
  validateUnitCreate,
  validateUnitPatch,
} from "./admin-units-logic";
import type {
  AdminUnit,
  AdminUnitGradeImpact,
  AttributeKey,
  Personality,
  Position,
  UnitFormState,
} from "./admin-units-logic";
import styles from "./AdminPage.module.css";
import u from "./AdminUnits.module.css";

/** 검색 입력 → 질의 반영 지연(ms). AdminPage 유저 검색과 같은 값. */
const SEARCH_DEBOUNCE_MS = 250;

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message || fallback : fallback;
}

function GradeBadge({ grade }: { grade: Grade }) {
  return (
    <span className={u.gradeBadge} style={{ color: GRADE_COLORS[grade] }}>
      {GRADE_LABELS[grade]}
    </span>
  );
}

/**
 * 어드민 유닛 카탈로그 (에픽 #207 파트 A / 웨이브2-C) — **배포 없이** 유닛을 운영하는 최소 화면.
 * 목록·검색·필터 / 상세(현재값 + 보유 규모 + 감사 이력) / 수정 / 활성 토글 / 신규 추가.
 *
 * ⚠️ 이 화면의 핵심은 **등급 하향 영향 확인 플로우**다. 서버는 등급을 낮추는 PATCH 를
 * `confirmImpact` 없이는 409 로 거절하고, 응답 detail 에 실측 영향(보유 유저 수·평균/최악 OVR
 * 델타)을 담아 돌려준다. 그 409 는 **에러가 아니라 질문**이다 — 토스트로 흘려보내면 운영자는
 * "왜 저장이 안 되지"만 보고 정작 몇 명이 얼마나 깎이는지는 영영 모른다.
 * 그래서 여기서는 확인 다이얼로그로 띄우고, 확인해야만 `confirmImpact: true` 로 재요청한다.
 *
 * 재요청은 **새 멱등키**를 쓴다 — 바디에 confirmImpact 가 붙어 내용이 달라지므로 같은 키로
 * 다시 보내면 서버가 "같은 키 다른 내용"으로 보고 또 409 를 낸다(openapi PATCH 주석).
 */
export function AdminUnitsSection() {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [grade, setGrade] = useState<Grade | "">("");
  const [position, setPosition] = useState<Position | "">("");
  const [active, setActive] = useState<boolean | null>(null);
  const [offset, setOffset] = useState(0);

  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<UnitFormState | null>(null);
  const [touched, setTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<UnitFormState>(emptyUnitForm);
  const [createTouched, setCreateTouched] = useState(false);
  const [impact, setImpact] = useState<AdminUnitGradeImpact | null>(null);
  const [toggleTarget, setToggleTarget] = useState<{ row: AdminUnit; next: boolean } | null>(null);
  const [toggleReason, setToggleReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      setTerm(q);
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q]);

  const list = useAdminUnits({ q: term, grade, position, active, offset });
  const detail = useAdminUnitDetail(selected);
  const update = useUpdateUnit();
  const create = useCreateUnit();
  const setActiveMut = useSetUnitActive();

  const unit: AdminUnit | null = detail.data?.unit ?? null;

  // 상세가 도착하면(또는 다른 유닛으로 바뀌면) 편집 폼을 서버 현재값으로 초기화한다.
  // **id 로만** 재초기화한다 — 백그라운드 리페치마다 초기화하면 운영자가 입력하던 값이 날아간다.
  const unitId = unit?.id ?? null;
  useEffect(() => {
    setForm(unit ? unitFormFromUnit(unit) : null);
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId]);

  const validation = unit && form ? validateUnitPatch(form, unit) : null;
  const createValidation = validateUnitCreate(createForm);

  function patchField<K extends keyof UnitFormState>(key: K, value: UnitFormState[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  function patchAttr(key: AttributeKey, value: string) {
    setForm((f) => (f ? { ...f, attributes: { ...f.attributes, [key]: value } } : f));
  }

  /**
   * PATCH 제출. `confirmImpact` 는 운영자가 영향 다이얼로그를 확인한 뒤에만 true 다.
   * 멱등키는 **호출마다 새로** 뽑는다(위 주석 참조).
   */
  function submitPatch(confirmImpact: boolean) {
    if (!unit || !form) return;
    const v = validateUnitPatch(form, unit);
    if (!v.valid) {
      setTouched(true);
      return;
    }
    setNotice(null);
    update.mutate(
      {
        playerId: unit.id,
        body: buildPatchRequest(form, unit, { confirmImpact }),
        idemKey: newIdempotencyKey(),
      },
      {
        onSuccess: (res) => {
          setImpact(null);
          if (res.unit) setForm(unitFormFromUnit(res.unit));
          setTouched(false);
          setNotice(
            res.applied
              ? `${unit.id} 수정 완료 — ${(res.changedFields ?? []).join(", ") || "변경 없음"}`
              : `${unit.id} 재전송 흡수(변경 없음)`,
          );
        },
        onError: (err) => {
          // 등급 하향 409 = 에러가 아니라 "확인이 필요하다"는 신호.
          const parsed = parseGradeImpact(err);
          if (parsed) {
            setImpact(parsed);
            return;
          }
          setImpact(null);
          setError(errMessage(err, "유닛 수정에 실패했습니다"));
        },
      },
    );
  }

  function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateTouched(true);
    if (!createValidation.valid) return;
    setNotice(null);
    create.mutate(
      { body: buildCreateRequest(createForm), idemKey: newIdempotencyKey() },
      {
        onSuccess: (res) => {
          setCreating(false);
          setCreateForm(emptyUnitForm());
          setCreateTouched(false);
          setNotice(`신규 유닛 생성 — ${res.unit?.id ?? ""}`);
        },
        onError: (err) => setError(errMessage(err, "유닛 생성에 실패했습니다")),
      },
    );
  }

  /**
   * 활성 토글도 **사유 필수**다(감사 원장 규약). 그래서 목록에서 바로 누르더라도
   * 사유 입력 다이얼로그를 한 번 거친다 — 브라우저 `prompt` 는 접근성·테스트 양쪽에서 못 쓴다.
   */
  function confirmToggle() {
    if (!toggleTarget) return;
    const reason = toggleReason.trim();
    if (reason === "") return;
    const { row, next } = toggleTarget;
    setNotice(null);
    setActiveMut.mutate(
      { playerId: row.id, active: next, reason, idemKey: newIdempotencyKey() },
      {
        onSuccess: () => {
          setToggleTarget(null);
          setToggleReason("");
          setNotice(`${row.id} ${next ? "활성화" : "비활성화"} 완료`);
        },
        onError: (err) => {
          setToggleTarget(null);
          setError(errMessage(err, "활성 상태 변경에 실패했습니다"));
        },
      },
    );
  }

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const limit = list.data?.limit ?? UNIT_PAGE_SIZE;

  return (
    <div data-testid="admin-units">
      {error && <ErrorToast message={error} onDismiss={() => setError(null)} />}

      <section className={styles.section}>
        <label className={styles.searchLabel} htmlFor="admin-units-search-input">
          유닛 검색 (ID / 이름)
        </label>
        <input
          id="admin-units-search-input"
          className={styles.search}
          data-testid="admin-units-search"
          type="search"
          value={q}
          placeholder="예: P005 또는 유라도나"
          onChange={(e) => setQ(e.target.value)}
        />

        <div className={u.filters}>
          <div className={u.filterRow}>
            <select
              className={u.select}
              data-testid="admin-units-grade"
              aria-label="등급 필터"
              value={grade}
              onChange={(e) => {
                setGrade(e.target.value as Grade | "");
                setOffset(0);
              }}
            >
              <option value="">등급 전체</option>
              {GRADE_ORDER.map((g) => (
                <option key={g} value={g}>
                  {GRADE_LABELS[g]}
                </option>
              ))}
            </select>
            <select
              className={u.select}
              data-testid="admin-units-position"
              aria-label="포지션 필터"
              value={position}
              onChange={(e) => {
                setPosition(e.target.value as Position | "");
                setOffset(0);
              }}
            >
              <option value="">포지션 전체</option>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              className={u.select}
              data-testid="admin-units-active"
              aria-label="활성 필터"
              value={active === null ? "" : String(active)}
              onChange={(e) => {
                const v = e.target.value;
                setActive(v === "" ? null : v === "true");
                setOffset(0);
              }}
            >
              <option value="">활성 전체</option>
              <option value="true">활성만</option>
              <option value="false">비활성만</option>
            </select>
            <button
              type="button"
              className={u.rowBtn}
              data-testid="admin-unit-create-open"
              onClick={() => setCreating((c) => !c)}
            >
              {creating ? "추가 닫기" : "+ 신규 유닛"}
            </button>
          </div>
        </div>

        {notice && (
          <p className={styles.notice} role="status" data-testid="admin-units-notice">
            {notice}
          </p>
        )}

        {list.isLoading && <p className={styles.muted}>불러오는 중…</p>}
        {list.isError && <p className={styles.muted}>유닛 목록을 불러오지 못했습니다</p>}
        {!list.isLoading && !list.isError && items.length === 0 && (
          <p className={styles.muted} data-testid="admin-units-empty">
            조건에 맞는 유닛이 없습니다
          </p>
        )}

        {items.length > 0 && (
          <>
            <div className={styles.tableScroll}>
              <table className={styles.table} data-testid="admin-units-table">
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">이름</th>
                    <th scope="col">포지션</th>
                    <th scope="col">등급</th>
                    <th scope="col">상태</th>
                    <th scope="col">시드</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr
                      key={row.id}
                      className={[
                        row.id === selected ? styles.rowActive : "",
                        row.active ? "" : u.inactiveRow,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      data-testid={`admin-unit-row-${row.id}`}
                      data-active={String(row.active)}
                    >
                      <td className={styles.nowrap}>{row.id}</td>
                      <td>
                        <button
                          type="button"
                          className={styles.linkBtn}
                          data-testid={`admin-unit-select-${row.id}`}
                          onClick={() => {
                            setSelected(row.id);
                            setNotice(null);
                          }}
                        >
                          {row.name}
                        </button>
                      </td>
                      <td>{row.position}</td>
                      <td>
                        <GradeBadge grade={row.grade} />
                      </td>
                      <td>
                        <span
                          className={row.active ? u.activeChip : u.inactiveChip}
                          data-testid={`admin-unit-state-${row.id}`}
                        >
                          {row.active ? "활성" : "비활성"}
                        </span>
                      </td>
                      <td className={styles.nowrap}>
                        {row.adminLocked ? (
                          <span className={u.lockChip}>어드민</span>
                        ) : (
                          row.dataVersion
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className={u.rowBtn}
                          data-testid={`admin-unit-toggle-${row.id}`}
                          onClick={() => {
                            setToggleReason("");
                            setToggleTarget({ row, next: !row.active });
                          }}
                          disabled={setActiveMut.isPending}
                        >
                          {row.active ? "비활성화" : "활성화"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={u.pager}>
              <button
                type="button"
                className={u.rowBtn}
                data-testid="admin-units-prev"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - limit))}
              >
                이전
              </button>
              <span data-testid="admin-units-range">
                {offset + 1}–{offset + items.length} / {total}
              </span>
              <button
                type="button"
                className={u.rowBtn}
                data-testid="admin-units-next"
                disabled={offset + items.length >= total}
                onClick={() => setOffset((o) => o + limit)}
              >
                다음
              </button>
            </div>
          </>
        )}
      </section>

      {creating && (
        <section className={styles.section} data-testid="admin-unit-create">
          <h2 className={styles.sectionTitle}>신규 유닛 추가</h2>
          <form className={styles.grantForm} data-testid="admin-unit-create-form" onSubmit={submitCreate}>
            <UnitFields
              idPrefix="admin-unit-create"
              form={createForm}
              errors={createTouched ? createValidation.errors : {}}
              onChange={(k, v) => setCreateForm((f) => ({ ...f, [k]: v }))}
              onAttrChange={(k, v) =>
                setCreateForm((f) => ({ ...f, attributes: { ...f.attributes, [k]: v } }))
              }
            />
            <button
              type="submit"
              className={styles.primary}
              data-testid="admin-unit-create-submit"
              disabled={!createValidation.valid || create.isPending}
            >
              {create.isPending ? "생성 중…" : "유닛 생성"}
            </button>
          </form>
        </section>
      )}

      {selected && (
        <section className={styles.section} data-testid="admin-unit-detail">
          {detail.isLoading && <p className={styles.muted}>상세 불러오는 중…</p>}
          {detail.isError && <p className={styles.muted}>유닛 상세를 불러오지 못했습니다</p>}

          {unit && form && (
            <>
              <h2 className={styles.sectionTitle}>
                {unit.name}
                <span className={styles.idHint}>{unit.id}</span>
                <GradeBadge grade={unit.grade} />
                {!unit.active && <span className={u.inactiveChip}>비활성</span>}
              </h2>

              <dl className={styles.stats}>
                <div className={styles.stat}>
                  <dt>보유 유저</dt>
                  <dd data-testid="admin-unit-owners">{detail.data?.holdings.owners ?? 0}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>보유 장수</dt>
                  <dd data-testid="admin-unit-copies">{detail.data?.holdings.copies ?? 0}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>시드 버전</dt>
                  <dd data-testid="admin-unit-dataversion">{unit.dataVersion}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>어드민 잠금</dt>
                  <dd data-testid="admin-unit-locked">{unit.adminLocked ? "예" : "아니오"}</dd>
                </div>
              </dl>

              <form
                className={styles.grantForm}
                data-testid="admin-unit-edit-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  setTouched(true);
                  submitPatch(false);
                }}
              >
                <h3 className={styles.formTitle}>유닛 수정</h3>
                <UnitFields
                  idPrefix="admin-unit"
                  form={form}
                  errors={touched ? (validation?.errors ?? {}) : {}}
                  onChange={patchField}
                  onAttrChange={patchAttr}
                />
                {validation?.downgrade && (
                  <p className={u.warn} data-testid="admin-unit-downgrade-warn">
                    등급 하향({GRADE_LABELS[validation.downgrade.from]} →{" "}
                    {GRADE_LABELS[validation.downgrade.to]}) — 저장 시 보유 카드 영향 확인이 필요합니다
                  </p>
                )}
                {touched && validation?.errors.form && (
                  <p className={styles.fieldError} data-testid="admin-unit-form-error">
                    {validation.errors.form}
                  </p>
                )}
                <button
                  type="submit"
                  className={styles.primary}
                  data-testid="admin-unit-submit"
                  disabled={!validation?.valid || update.isPending}
                >
                  {update.isPending ? "저장 중…" : "저장"}
                </button>
              </form>

              <h3 className={styles.formTitle}>변경 이력 (감사 로그)</h3>
              <div className={styles.tableScroll}>
                <table className={styles.table} data-testid="admin-unit-audit">
                  <thead>
                    <tr>
                      <th scope="col">액션</th>
                      <th scope="col">변경</th>
                      <th scope="col">사유</th>
                      <th scope="col">actor</th>
                      <th scope="col">시각</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.data?.recentAudit ?? []).map((e) => (
                      <tr key={e.id} data-testid={`admin-unit-audit-row-${e.id}`}>
                        <td className={styles.nowrap}>{AUDIT_ACTION_LABELS[e.action] ?? e.action}</td>
                        <td>{auditChangeSummary(e)}</td>
                        <td>{e.reason}</td>
                        <td className={styles.nowrap}>{e.actorUserId}</td>
                        <td className={styles.nowrap}>{formatStamp(e.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(detail.data?.recentAudit ?? []).length === 0 && (
                <p className={styles.muted} data-testid="admin-unit-audit-empty">
                  기록된 변경 이력이 없습니다
                </p>
              )}
            </>
          )}
        </section>
      )}

      {toggleTarget && (
        <Modal
          onClose={() => setToggleTarget(null)}
          labelledBy="admin-unit-toggle-title"
          overlayClassName={styles.overlay}
          className={styles.dialog}
          testId="admin-unit-toggle-dialog"
        >
          <h2 id="admin-unit-toggle-title" className={styles.dialogTitle}>
            {toggleTarget.next ? "유닛 활성화" : "유닛 비활성화"}
          </h2>
          <p className={styles.dialogBody}>
            {toggleTarget.row.id} {toggleTarget.row.name} —{" "}
            {toggleTarget.next
              ? "다시 가챠·트레이드·도감 미보유분에 등장합니다."
              : "신규 획득 경로에서만 제외됩니다(보유분·덱·성장 무영향)."}
          </p>
          <div className={styles.field}>
            <label htmlFor="admin-unit-toggle-reason-input">사유 (필수)</label>
            <input
              id="admin-unit-toggle-reason-input"
              className={styles.input}
              data-testid="admin-unit-toggle-reason"
              value={toggleReason}
              onChange={(e) => setToggleReason(e.target.value)}
            />
          </div>
          <div className={styles.dialogActions}>
            <button
              type="button"
              className={styles.ghost}
              data-testid="admin-unit-toggle-cancel"
              onClick={() => setToggleTarget(null)}
            >
              취소
            </button>
            <button
              type="button"
              className={styles.primary}
              data-testid="admin-unit-toggle-ok"
              disabled={toggleReason.trim() === "" || setActiveMut.isPending}
              onClick={confirmToggle}
            >
              적용
            </button>
          </div>
        </Modal>
      )}

      {impact && (
        <Modal
          onClose={() => setImpact(null)}
          labelledBy="admin-unit-impact-title"
          overlayClassName={styles.overlay}
          className={styles.dialog}
          testId="admin-unit-impact"
        >
          <h2 id="admin-unit-impact-title" className={styles.dialogTitle}>
            등급 하향 — 보유 카드 영향 확인
          </h2>
          <p className={styles.dialogBody} data-testid="admin-unit-impact-body">
            {describeGradeImpact(impact)}
          </p>
          <ul className={u.impactList}>
            <li>
              <span>등급</span>
              <strong>
                {GRADE_LABELS[impact.fromGrade]} → {GRADE_LABELS[impact.toGrade]}
              </strong>
            </li>
            <li>
              <span>영향 유저</span>
              <strong data-testid="admin-unit-impact-users">{impact.affectedUsers}명</strong>
            </li>
            <li>
              <span>평균 OVR</span>
              <strong data-testid="admin-unit-impact-avg">
                {impact.computed ? `${formatOvrDelta(impact.avgOvrDelta)} OVR` : "미계산"}
              </strong>
            </li>
            <li>
              <span>최악 OVR</span>
              <strong data-testid="admin-unit-impact-worst">
                {impact.computed ? `${formatOvrDelta(impact.worstOvrDelta)} OVR` : "미계산"}
              </strong>
            </li>
            <li>
              <span>성장 캡</span>
              <strong>{impact.capLowered ? "내려감" : "유지"}</strong>
            </li>
          </ul>
          <div className={styles.dialogActions}>
            <button
              type="button"
              className={styles.ghost}
              data-testid="admin-unit-impact-cancel"
              onClick={() => setImpact(null)}
            >
              취소
            </button>
            <button
              type="button"
              className={styles.primary}
              data-testid="admin-unit-impact-ok"
              onClick={() => submitPatch(true)}
            >
              확인하고 적용
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ───────────────────────── 공용 필드 묶음(수정/생성 동일 폼) ───────────────────────── */

interface UnitFieldsProps {
  idPrefix: string;
  form: UnitFormState;
  errors: {
    name?: string;
    reason?: string;
    attributes?: Partial<Record<AttributeKey, string>>;
  };
  onChange: <K extends keyof UnitFormState>(key: K, value: UnitFormState[K]) => void;
  onAttrChange: (key: AttributeKey, value: string) => void;
}

function UnitFields({ idPrefix, form, errors, onChange, onAttrChange }: UnitFieldsProps) {
  return (
    <>
      <div className={styles.field}>
        <label htmlFor={`${idPrefix}-name-input`}>이름</label>
        <input
          id={`${idPrefix}-name-input`}
          className={styles.input}
          data-testid={`${idPrefix}-name`}
          value={form.name}
          onChange={(e) => onChange("name", e.target.value)}
        />
        {errors.name && <p className={styles.fieldError}>{errors.name}</p>}
      </div>

      <div className={u.filterRow}>
        <select
          className={u.select}
          data-testid={`${idPrefix}-position`}
          aria-label="포지션"
          value={form.position}
          onChange={(e) => onChange("position", e.target.value as Position)}
        >
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className={u.select}
          data-testid={`${idPrefix}-grade`}
          aria-label="등급"
          value={form.grade}
          onChange={(e) => onChange("grade", e.target.value as Grade)}
        >
          {GRADE_ORDER.map((g) => (
            <option key={g} value={g}>
              {GRADE_LABELS[g]}
            </option>
          ))}
        </select>
        <select
          className={u.select}
          data-testid={`${idPrefix}-personality`}
          aria-label="성격"
          value={form.personality}
          onChange={(e) => onChange("personality", e.target.value as Personality)}
        >
          {PERSONALITIES.map((p) => (
            <option key={p} value={p}>
              {PERSONALITY_LABELS[p]}
            </option>
          ))}
        </select>
      </div>

      <label className={u.checkRow}>
        <input
          type="checkbox"
          data-testid={`${idPrefix}-active`}
          checked={form.active}
          onChange={(e) => onChange("active", e.target.checked)}
        />
        활성 (끄면 가챠·트레이드·도감 미보유분에서 제외 — 보유분은 그대로)
      </label>

      <div className={u.attrGrid}>
        {ATTRIBUTE_KEYS.map((k) => (
          <div className={u.attrField} key={k}>
            <label htmlFor={`${idPrefix}-attr-${k}-input`}>{ATTRIBUTE_LABELS[k]}</label>
            <input
              id={`${idPrefix}-attr-${k}-input`}
              className={u.attrInput}
              data-testid={`${idPrefix}-attr-${k}`}
              inputMode="numeric"
              value={form.attributes[k]}
              onChange={(e) => onAttrChange(k, e.target.value)}
            />
            {errors.attributes?.[k] && <p className={styles.fieldError}>{errors.attributes[k]}</p>}
          </div>
        ))}
      </div>

      <div className={styles.field} style={{ marginTop: 10 }}>
        <label htmlFor={`${idPrefix}-reason-input`}>사유 (필수 — 감사 이력에 기록)</label>
        <input
          id={`${idPrefix}-reason-input`}
          className={styles.input}
          data-testid={`${idPrefix}-reason`}
          value={form.reason}
          placeholder="예: 밸런스 조정 — 레전드 상향 롤백"
          onChange={(e) => onChange("reason", e.target.value)}
        />
        {errors.reason && (
          <p className={styles.fieldError} data-testid={`${idPrefix}-reason-error`}>
            {errors.reason}
          </p>
        )}
      </div>
    </>
  );
}

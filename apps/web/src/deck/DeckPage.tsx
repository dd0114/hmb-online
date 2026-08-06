import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useDeck, usePlayers, useUpdateDeck, type CatalogPlayer, type Deck } from "../api/hooks";
import { useRelations, useTodayConditions } from "../api/hooks-v2";
import { usePendingChoices } from "../api/growth-hooks";
import { Layout } from "../common/Layout";
import { TeamMoraleWidget } from "../common/RelationBits";
import { CardGrowthDetail } from "../codex/CardGrowthDetail";
import { useNavLocked } from "../common/nav-lock";
import { useTutorial } from "../common/tutorial-context";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import { usePlayerNames } from "../common/player-names";
import { useNavGuardRun, useRegisterNavGuard, type NavGuard } from "../common/NavGuard";
import {
  emptyDraft,
  STARTER_COUNT,
  toUpdateRequest,
  validateDraft,
  type DeckDraft,
} from "./deck-logic";
import { DEFAULT_TEAM_TACTICS, type EditorState } from "./tactics-logic";
import { isDirty, makeBaseline, type EditorBaseline } from "./preset-selector-logic";
import { canAutoBuild } from "./auto-lineup";
import { canFillEmptySlots, fillEmptySlots } from "./fill-empty";
import { DeckEditor } from "./DeckEditor";
import { useDeckLayout } from "./use-deck-layout";
import { growthReadyIdsOf } from "./growth-ready";
import styles from "./DeckPage.module.css";

interface ServerDeckError {
  rule: string;
  message: string;
  playerId: string | null;
}

function draftFromDeck(deck: Deck | null): DeckDraft {
  // ⚠️ `!deck` 만으로 부족하다 — 200 `{}` 는 truthy 라 통과하고 `slots.map` 이 던진다
  //    (그러면 덱 화면이 흰 화면이다, #286 독립검증 MAJ-3).
  if (!deck || !Array.isArray(deck.slots)) return emptyDraft();
  return {
    formation: deck.formation,
    slots: deck.slots.map((s) => ({
      playerId: s.playerId,
      role: s.role,
      slotIndex: s.slotIndex,
      promptText: s.promptText ?? null,
    })),
  };
}

/**
 * 덱 화면 = **팀 시트 하나** (이슈 #106 R1 재설계).
 *
 * ── 프리셋 UI 를 화면에서 내린 이유 (#106) ─────────────────────────────────────────────────
 * #98 은 이 화면을 "프리셋 중심"(3슬롯 선택기 + 선택 프리셋 요약 카드 + 프롬프트 프리셋 패널)으로
 * 조립했으나, hero 실플레이 판정은 **컨셉이 잡히기 전의 프리셋은 시기상조**였다 — 저장/불러오기/
 * 이력이 먼저 들어와 복잡도만 올리고, 무엇이 무엇을 결정하는지(전술보드가 SoT) 인지선을 끊었다.
 * 그래서 R1 은 **세팅 하나만** 편집·저장한다: 이 화면은 항상 활성 덱(PUT /api/deck)을 대상으로 한다.
 *
 * ⚠️ 삭제가 아니라 **화면에서 내린 것**이다 — 컨셉 확정 후 재도입에 대비해
 *   - 컴포넌트 파일: `SlotSelector.tsx` · `PresetSummary.tsx` · `PresetPanel.tsx` (렌더만 중단, 파일 존치)
 *   - 훅/계약: `useTeamPresets`/`useSaveTeamPreset`/`useApplyTeamPreset`(hooks-v2, `/api/presets/team`),
 *     `usePresets`/`useCreatePreset`/`useDeletePreset`(`/api/presets`), 서버 `userDeckSnapshot`
 *   - 순수 로직: `preset-selector-logic.ts`(dirty 추적은 여기서 계속 쓴다) · `tactics-logic` 스냅샷 직렬화
 *   는 전부 그대로 둔다. 되돌리려면 이 파일에서 다시 렌더하면 된다.
 *
 * dirty 가드(요구 5, #98)는 유지한다 — 프리셋 슬롯 개념만 사라지고(slot=null) 미저장 이탈 확인은 그대로.
 */
export function DeckPage() {
  const navigate = useNavigate();
  const runGuard = useNavGuardRun();
  const { data: deck, isLoading: deckLoading, isError: deckError } = useDeck();
  const { data: players, isLoading: playersLoading } = usePlayers();
  const { data: relations } = useRelations();
  // 당일(KST) 컨디션 — 보드 토큰/리스트/레일 헤드에 표시. 실패해도 화면은 그대로.
  const { data: conditions } = useTodayConditions();
  const updateDeck = useUpdateDeck();
  // #455 A1 — 폭 1023 이하만 책갈피 탭. 데스크탑은 종전 2컬럼 그대로다.
  const deckLayout = useDeckLayout();

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [baseline, setBaseline] = useState<EditorBaseline | null>(null);
  const [aiManaged, setAiManaged] = useState(false);
  const [serverError, setServerError] = useState<ServerDeckError | null>(null);
  const [savedNote, setSavedNote] = useState(false);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);

  /**
   * 덱 없는 유저를 데려온 셋업 진입 (#286 W3.5) — `/deck?setup=1`.
   *
   * 여기서 코치마크를 켜는 이유: 가드는 **홈·게임 탭**에 있는데 코치마크 대상은 **덱 화면**에
   * 있다. 보내는 쪽에서 켜면 아직 도착하지 않은 화면의 스텝을 찾다가 대상 부재로 스킵되고,
   * 유저는 빈 전술보드 앞에 안내 없이 남는다.
   */
  const [searchParams] = useSearchParams();
  const setupFlow = searchParams.get("setup") === "1";
  const { startDeckSetup } = useTutorial();
  const setupStarted = useRef(false);
  useEffect(() => {
    if (!setupFlow || setupStarted.current) return;
    setupStarted.current = true;
    startDeckSetup();
  }, [setupFlow, startDeckSetup]);
  /**
   * 강화 시트 (#286 W3) — **페이지가 소유**한다. 에디터가 들고 있으면 보드 상태가 바뀔 때마다
   * 시트가 같이 흔들리고, 무엇보다 선수 탭과 **같은 컴포넌트**를 연다는 사실이 흐려진다.
   */
  const [growthPlayer, setGrowthPlayer] = useState<CatalogPlayer | null>(null);
  /**
   * 경기 중에는 강화만 잠근다(hero 2R).
   *
   * ⚠️ **덱 전체를 잠그면 안 된다** — 하프타임 지시를 쓰러 오는 자리이기 때문이다. 능력치를
   * 바꾸는 것만 막는다: 진행 중인 시뮬이 이미 그 값으로 돌고 있어 도중에 바뀌면 어긋난다.
   */
  const matchLocked = useNavLocked();
  const growthLockedReason = matchLocked ? "경기 중에는 강화할 수 없습니다" : null;

  /**
   * **강화 가능(선택 대기) 신호** (#455 A2-2) — 토큰·선수 메뉴의 `↑`.
   *
   * ⚠️ **왕복은 1회다.** `GET /api/growth/choices` 는 `playerId` 를 안 주면 그 유저의 **전 카드**를
   * 한 번에 준다(`GrowthService.pendingChoices(userId, null)`) — 선수 11명에게 카드 조회를 각각
   * 때리는 설계가 아니다. 그 사실은 DOM 으로 못 재므로 `p455-a22` ③ 이 **요청 수**를 직접 센다.
   * 쿼리 키(`["growthChoices", null]`)가 결과 화면·보상 봉투와 **같아서** 앱 전역에서 캐시를 공유한다.
   * ⚠️ 무효화는 새로 배선할 것이 없다 — `useApplyChoice` 가 성공·실패 양쪽에서 `["growthChoices"]`
   * 접두를 무효화하므로, 강화 시트에서 선택을 적용하면 이 화면의 뱃지가 저절로 사라진다.
   * ⚠️ 훅을 `DeckEditor` 안으로 내리지 마라 — 그 컴포넌트는 경기전·감독시간과 공유라 조회가
   * 세 화면에 붙는다(그 prop 선언부 주석).
   */
  const { data: openChoices } = usePendingChoices();
  const growthReadyIds = useMemo(() => growthReadyIdsOf(openChoices), [openChoices]);

  // 첫 진입: 활성 덱 하나만 로드한다(프리셋 조회/적용 없음 — #106).
  useEffect(() => {
    if (editor !== null || deckLoading || deckError || playersLoading) return;
    const ed: EditorState = {
      draft: draftFromDeck(deck ?? null),
      tactics: { ...DEFAULT_TEAM_TACTICS },
      // 저장된 팀 문장을 다시 채운다(#253) — 이걸 늘 ""로 시작하면 유저가 쓴 문장이 서버에
      // 남아 있어도 화면엔 없고, 그 상태로 저장하면 전체 교체라 실제로 지워진다.
      teamPrompt: deck?.teamPrompt ?? "",
    };
    setEditor(ed);
    setBaseline(makeBaseline(ed, "", null));
  }, [editor, deck, deckLoading, deckError, playersLoading]);

  const playersById = useMemo(() => {
    const map = new Map<string, CatalogPlayer>();
    for (const p of Array.isArray(players) ? players : []) map.set(p.id, p);
    return map;
  }, [players]);

  const ownedPlayers = useMemo(() => (Array.isArray(players) ? players : []).filter((p) => p.owned), [players]);
  /** 이름은 초크포인트로만(#406 요구 6). */
  const names = usePlayerNames();

  const dirty = editor != null && baseline != null && isDirty(editor, "", baseline);

  // Navigation guard (요구 5): while dirty, defer any in-app navigation to the confirm dialog.
  const guard = useCallback<NavGuard>((commit) => setPendingNav(() => commit), []);
  useRegisterNavGuard(dirty ? guard : null);

  // Best-effort refresh/close guard (browser-native prompt).
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  if (deckLoading || playersLoading || editor === null) {
    return (
      <Layout>
        {deckError ? <ErrorToast message="덱을 불러오지 못했습니다" /> : <p>불러오는 중…</p>}
      </Layout>
    );
  }

  const draft = editor.draft;
  const starterCount = draft.slots.filter((s) => s.role === "starter").length;
  const preIssues = validateDraft(draft, (id) => playersById.get(id)?.position);
  const busy = updateDeck.isPending;

  function mutateEditor(next: EditorState) {
    setEditor(next);
    setSavedNote(false);
    setServerError(null);
  }

  function setServerErrorFrom(err: unknown, fallback: string) {
    if (err instanceof ApiError) {
      const detail = err.detail ?? {};
      setServerError({
        rule: typeof detail.rule === "string" ? detail.rule : err.code,
        message: err.message,
        playerId: typeof detail.playerId === "string" ? detail.playerId : null,
      });
    } else {
      setServerError({ rule: "NETWORK", message: fallback, playerId: null });
    }
  }

  /** "저장" — 활성 덱 하나만 덮어쓴다(PUT /api/deck). 프리셋 슬롯 저장 경로는 화면에서 내렸다(#106). */
  async function handleSave(): Promise<boolean> {
    setServerError(null);
    setSavedNote(false);
    try {
      await updateDeck.mutateAsync(toUpdateRequest(editor!.draft, editor!.teamPrompt));
      setBaseline(makeBaseline(editor!, "", null));
      setSavedNote(true);
      return true;
    } catch (err) {
      setServerErrorFrom(err, "저장에 실패했습니다");
      return false;
    }
  }

  function handleDialogSave() {
    void handleSave().then((ok) => {
      if (!ok) return; // keep dialog open; error shows below
      const go = pendingNav;
      setPendingNav(null);
      go?.();
    });
  }

  function handleDialogDiscard() {
    const go = pendingNav;
    setPendingNav(null);
    go?.();
  }

  const saveDisabled = busy || starterCount !== STARTER_COUNT || preIssues.length > 0;

  const header = (
    <div className={styles.headerRow}>
      <button
        type="button"
        className={styles.back}
        data-testid="deck-back"
        onClick={() => runGuard(() => navigate("/home"))}
      >
        ← 홈
      </button>
      <h1 className={styles.pageTitle}>덱 · 전술보드</h1>
      {dirty && (
        <span className={styles.dirtyBadge} data-testid="deck-dirty-badge">
          미저장
        </span>
      )}
      <button
        type="button"
        className={styles.save}
        data-testid="save-deck"
        disabled={saveDisabled}
        onClick={() => void handleSave()}
      >
        {busy ? "저장 중…" : "저장"}
      </button>
    </div>
  );

  /** 덱 규칙 위반 안내 — 레이아웃에 따라 페이지 형제(stack) 또는 [전체 지시] 탭 꼬리(tabs)로 간다. */
  const preIssueList =
    preIssues.length > 0 ? (
      <ul className={styles.issueList} data-testid="deck-pre-issues">
        {preIssues.map((issue) => (
          <li key={issue.rule + (issue.playerId ?? "")} className={styles.issue}>
            {issue.message}
          </li>
        ))}
      </ul>
    ) : null;

  // `fill` = 문서 스크롤 0(에디터가 화면 높이를 정확히 채운다). 탭 레이아웃의 전제라
  // 데스크탑 stack 에서는 켜지 않는다 — 켜면 2컬럼 화면이 잘린다.
  return (
    <Layout header={header} nav fill={deckLayout === "tabs"}>
      <DeckEditor
        /* #455 A1 — 덱셋팅**만** 탭 레이아웃(경기장 68 상한 + 책갈피 탭 3개). 경기전·감독시간은
           같은 컴포넌트를 쓰지만 기본값 `"stack"` 그대로라 이 웨이브에서 안 움직인다.
           ⚠️ 그리고 **폭 1023 이하에서만** 탭이다 — 데스크탑은 보드 | 레일 2컬럼이 그대로 산다.
           근거·임계는 `use-deck-layout.ts` 머리말(구현이 범위를 넘어 2컬럼을 죽였던 실측 포함). */
        layout={deckLayout}
        /* #455 A2 ①④ — 선수 토큰 탭이 **메뉴 시트**를 연다. `layout` 과 **다른 축**이라 prop 이
           따로다(`DeckEditor` 의 그 선언부에 이유가 있다) — 여기서 같은 조건을 넘기는 것은
           "확정 계약이 폰 덱셋팅 개편"이라는 **스코프 결정**이지 두 축이 같아서가 아니다.
           데스크탑(stack)은 지시 레일이 보드 옆에 상시 서 있어 메뉴가 한 단계를 더할 뿐이다. */
        playerMenu={deckLayout === "tabs"}
        /* 팀 사기 = [세부 전술] 탭 꼬리(#455 A1) — **탭 레이아웃에서만**이다. 아래 주석의
           "프롬프트 우선"과 같은 이유다: 에디터 형제로 두면 폰에서 68px 를 먹어 그만큼 프롬프트
           칸이 줄어든다(실측). stack 은 아래 형제 자리를 그대로 쓴다(BL-1). */
        teamExtra={<TeamMoraleWidget relations={relations} compact />}
        teamPanelNotice={preIssueList}
        onOpenGrowth={(p) => setGrowthPlayer(p)}
        growthLockedReason={growthLockedReason}
        /* 강화 가능 `↑` (#455 A2-2). **`layout` 과 무관하게** 넘긴다 — 정보이지 폰 화면
           개편이 아니다(그 prop 선언부 주석 · `p455-a22` ⑦). */
        growthReadyIds={growthReadyIds}
        state={editor}
        onChange={mutateEditor}
        aiManaged={aiManaged}
        onToggleAi={setAiManaged}
        players={ownedPlayers}
        playersById={playersById}
        relations={relations}
        conditions={conditions}
        errorPlayerId={serverError?.playerId ?? null}
        /**
         * Auto = **빈 자리만 채운다**(#439, hero Q1=ⓑ). 후보 = 보유 선수 전체 — 이미 놓인 선수는
         * `fillEmptySlots` 가 건드리지 않으므로 여기서 미배치로 걸러 줄 필요가 없다.
         * ⚠️ 구 `autoBuildLineup`(전면 재구성)으로 되돌리지 마라 — 그건 전원의 프롬프트를 덮고
         * 팀 전술·팀 문장을 초기화한다(= hero 가 없애라고 한 [초기화] 와 같은 피해).
         */
        onAuto={() => mutateEditor({ ...editor, draft: fillEmptySlots(editor.draft, ownedPlayers) })}
        /**
         * ⚠️ **활성 판정은 실행 함수와 같은 것을 쓴다**(#439 2R major-2). 구 게이트는
         * `canAutoBuild(보유 ≥ 11)` 이었는데, 그건 "전원에서 11명을 새로 짠다"의 조건이지
         * "빈 자리를 채운다"의 조건이 아니다. 그 결과 **완성 덱에서 버튼이 활성인데 눌러도
         * 아무 일도 안 일어났다**(경기전은 같은 상태에서 비활성 + 사유를 말한다 = 두 화면이 갈렸다).
         * `canFillEmptySlots` 가 정확히 이 용도로 있다 — 판정을 두 번 적으면 버튼과 동작이 갈린다.
         */
        autoDisabled={busy || !canFillEmptySlots(editor.draft, ownedPlayers)}
        autoHint={
          canFillEmptySlots(editor.draft, ownedPlayers)
            ? canAutoBuild(ownedPlayers)
              ? "빈 자리를 보유 선수로 자동 배치합니다 (이미 놓인 선수·지시는 그대로)"
              : // 보유가 11 미만이어도 **있는 만큼은 채운다** — 예전엔 이 상태가 통째로 비활성이었다.
                `빈 자리를 채웁니다 — 보유 ${ownedPlayers.length}명이라 선발 ${STARTER_COUNT}명은 다 못 채웁니다`
            : ownedPlayers.length === 0
              ? "보유 선수가 없습니다"
              : /* ⚠️ "채울 빈 자리가 없거나" 를 되살리지 마라 — A3 이후 이 버튼은
                   `hasEmptySlotGap` 일 때만 그려지므로, 이 문장이 화면에 뜨는 순간
                   그 절은 **항상 거짓**이다(A3 독립검증 minor-2). 남는 이유는 하나뿐이다. */
                "보유 선수를 모두 배치했습니다"
        }
      />

      {/* 팀 사기 — #286 에서 로비가 없어지며 갈 곳을 잃었다. 설계(§3.1 "덜어낸 것의 행선지")가
          [덱]으로 지정한 자리다: 사기·컨디션은 **라인업을 짤 때 쓰는 값**이라 여기가 맞다.
          ⚠️ 소비처가 0 이 되면 위젯은 정의만 남고 화면에서 조용히 사라진다(독립검증 W2 BL-1 이
          그 상태를 잡았다) — `deck-teamsheet` 계약이 이제 존재를 지킨다.

          ⚠️ **에디터 위로 올리지 마라.** 처음엔 보드 위에 뒀는데, 그 한 줄이 지시 레일을 통째로
          아래로 밀어 **팀 프롬프트가 하단 탭바에 가렸다**(390px 실측 여백 79 → 11, 요구 ≥24).
          #244 의 "프롬프트는 어디서나 첫 화면에"가 이 위젯보다 우선이다 — 사기는 곁눈질로 보는
          값이고 프롬프트는 이 화면에 온 이유다. 계약 = `p244-prompt-first.spec.ts` AC1·AC13.

          ⚠️ **탭 레이아웃에서만 `teamExtra` 로 옮긴다 — 옮기는 게 아니라 갈래다.** A1 초판이
          이 줄을 지우고 `teamExtra` 만 넘겼는데, `DeckEditor` 는 그 노드를 `tabs` 분기 안에서만
          렌더한다 → **데스크탑(stack)에서 위젯이 통째로 사라졌다**(1024·1280 실측 존재 0,
          독립검증 BL-1 / `p286-home-nav.spec.ts` 가 이미 red 였다). 위 "소비처가 0 이 되면
          조용히 사라진다"가 같은 자리에서 두 번째로 일어난 것이다. 두 갈래 다 계약이 있다. */}
      {deckLayout === "stack" && <TeamMoraleWidget relations={relations} compact />}

      <div className={styles.notes}>
        {/* ⚠️ 탭 레이아웃에서는 이 목록이 **[전체 지시] 탭 안**으로 간다(`teamPanelNotice`).
            페이지 형제로 두면 탭 패널을 짧게 만들어 팀 프롬프트를 밀어내고 **그 위를 덮는다**
            (390×844 빈 덱 실측 — `DeckEditor` 의 그 자리 주석에 수치가 있다). */}
        {deckLayout === "stack" && preIssueList}
        {serverError && (
          <p className={styles.serverError} data-testid="deck-server-error">
            저장 실패 [{serverError.rule}] {serverError.message}
            {serverError.playerId && names.has(serverError.playerId)
              ? ` — ${names.full(serverError.playerId)}`
              : ""}
          </p>
        )}
        {savedNote && (
          <p className={styles.savedNote} data-testid="deck-saved-note">
            저장되었습니다
          </p>
        )}
        {/**
         * 셋업 흐름의 복귀 CTA (#286 W3.5, hero Q9 = A).
         *
         * ⚠️ **자동 이동하지 않는다.** 저장하자마자 게임 탭으로 넘기면 유저는 방금 자동 배치된
         * 덱을 한 번도 못 보고 화면이 바뀐다. 더 손보고 싶은 사람이 그대로 머무를 수 있어야 한다.
         */}
        {setupFlow && savedNote && (
          <button
            type="button"
            className={styles.readyCta}
            data-testid="deck-ready-cta"
            onClick={() => navigate("/game")}
          >
            이제 경기를 시작할 수 있습니다 — 게임 시작하러 가기 ›
          </button>
        )}
      </div>

      {/* 미저장 이탈 확인(요구 5) — a11y 셸은 공통 Modal 재사용(포커스 트랩·Esc=취소·포커스 복원). */}
      {pendingNav && (
        <Modal
          onClose={() => setPendingNav(null)}
          labelledBy="leave-confirm-title"
          overlayClassName={styles.dialogBackdrop}
          overlayTestId="leave-confirm-backdrop"
          className={styles.dialog}
          testId="leave-confirm-dialog"
        >
          <p id="leave-confirm-title" className={styles.dialogText}>
            저장하지 않은 변경사항이 있습니다. 저장할까요?
          </p>
          <div className={styles.dialogActions}>
            <button
              type="button"
              className={styles.dialogSave}
              data-testid="leave-save"
              disabled={saveDisabled}
              onClick={handleDialogSave}
            >
              저장
            </button>
            <button
              type="button"
              className={styles.dialogDiscard}
              data-testid="leave-discard"
              onClick={handleDialogDiscard}
            >
              버리고 이동
            </button>
            <button
              type="button"
              className={styles.dialogCancel}
              data-testid="leave-cancel"
              onClick={() => setPendingNav(null)}
            >
              취소
            </button>
          </div>
        </Modal>
      )}

      {/* 선수 탭이 여는 것과 **같은 컴포넌트**다 — hero 가 말한 "덱과 싱크"가 문서가 아니라
          구조로 보장된다. 출처만 표시해 두 진입점을 계약이 구분할 수 있게 한다. */}
      {growthPlayer && (
        <CardGrowthDetail
          player={growthPlayer}
          source="deck"
          onClose={() => setGrowthPlayer(null)}
        />
      )}
    </Layout>
  );
}

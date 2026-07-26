import { useEffect, useRef, useState } from "react";
import type { CatalogPlayer } from "../api/hooks";
import type { Personality, TeamTactics } from "../api/v2";
import { PersonalityBadge, TrustGauge } from "../common/RelationBits";
import { FullArtCard } from "../common/FullArtCard";
import { conditionLabel } from "../match/condition-clock";
import { PROMPT_MAX_CHARS, type DraftSlot } from "./deck-logic";
import {
  composeLayers,
  DIRECTIVE_CHIPS,
  parseDirectiveText,
  ROLE_OPTIONS,
  setRoleSafely,
  toggleChipSafely,
  type DirectiveEditResult,
  type DirectiveState,
} from "./directives";
import { radioKeyIndex, rovingTabIndex } from "./radio-group";
import { TACTICS_KEYS, TACTICS_LABELS } from "./tactics-logic";
import { STEP_COUNT, STEP_LABELS, stepAriaLabel, stepDisplayOf, valueOfStep } from "./tactics-steps";
import styles from "./DirectiveRail.module.css";

export interface DirectiveRailProps {
  /** 선택된 선수 — null 이면 팀 지시 컨텍스트. */
  player?: CatalogPlayer;
  /** 선택된 선수가 보드에서 차지한 슬롯(프롬프트 편집 대상). 미배치(리스트 대기) 선수는 없다. */
  slot?: DraftSlot;
  /** 보드 토큰에 찍히는 번호와 같은 표기 (레일 헤드 미니 디스크). */
  slotNumber?: string;
  condition?: number;
  trust?: number;
  personality?: Personality;
  /** 팀 지시 */
  tactics: TeamTactics;
  teamPrompt: string;
  aiManaged: boolean;
  onTacticsChange: (tactics: TeamTactics) => void;
  onTeamPromptChange: (text: string) => void;
  onToggleAi: (aiManaged: boolean) => void;
  /** 선수 프롬프트 변경 (slot 이 있을 때만 호출) */
  onPlayerPromptChange: (playerId: string, text: string) => void;
  onRemovePlayer: (playerId: string) => void;
  /** 선수 컨텍스트 닫기 → 팀 지시로 복귀 */
  onClose: () => void;
}

/**
 * ③ 컨텍스트 지시 레일 (이슈 #106 R1).
 *
 * #106 판정 두 가지를 동시에 푸는 블록이다:
 *   (a) "선수 눌렀을 때 선수정보 시트가 뜨는 것도 인지라인을 해친다" → **선수정보 시트(PlayerSheet)를
 *       없애고**, 보드 옆/아래에 **항상 같은 자리**에 있는 레일이 컨텍스트만 갈아끼운다. 선수 신원은
 *       헤드 **한 줄**(`7 · 강태호 · LM · 컨디션 보통`)로 끝 — 보드 맥락이 끊기지 않는다.
 *   (b) "기존 전략 포맷 위에 프롬프트가 extend" → 레일은 위에서부터 익숙한 전술 입력(역할/세부 지시,
 *       팀은 라인·압박·템포·폭)을 세우고, 그 **아래**에 자유 프롬프트("감독의 한마디")를 얹는다.
 *
 * R2 = 레일 내용물을 **A안**으로 만든 웨이브(#106 hero 확정):
 *   · 선수: 역할 세그먼트 → 세부 지시 칩 → 감독의 한마디 → **`AI에 전달될 지시문` 미리보기**
 *     (칩에서 합성된 문장 / 내가 쓴 문장을 라벨·구분선으로 갈라 보여준다. 단색 accent 스킨이라
 *      색으로 못 가르는 대신 라벨 + 좌측 룰 + 들여쓰기로 레이어를 인코딩한다.)
 *   · 팀: 라인/압박/템포/폭 슬라이더 → **5스텝 세그먼트**(0/.25/.5/.75/1) + 팀 한마디.
 *
 * 미리보기 ↔ 전송값 일치는 `composeLayers` 한 곳에서 보장한다 — 화면에 그리는 두 줄과 서버로
 * 보내는 문자열이 같은 호출의 산출물이다(directives.test.ts 불변식).
 *
 * 컨텍스트 규칙: 선택 없음 → 팀 지시 / 보드에서 선수 탭 → 그 선수 지시.
 */
/**
 * radiogroup 컨테이너의 키보드 핸들러 — APG 대로 방향키가 선택을 옮기고 포커스를 따라가게 한다.
 * 이동 후 포커스는 DOM 순서상 i 번째 `[role=radio]` 로 옮긴다(roving tabindex 와 짝).
 */
function radioGroupKeyDown(
  e: React.KeyboardEvent<HTMLDivElement>,
  current: number,
  count: number,
  onSelect: (index: number) => void,
) {
  const next = radioKeyIndex(e.key, current, count);
  if (next === null) return;
  e.preventDefault(); // 방향키의 기본 스크롤을 막는다(독 안에서 특히 거슬린다)
  onSelect(next);
  const radios = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
  radios[next]?.focus();
}

export function DirectiveRail(props: DirectiveRailProps) {
  const { player, slot } = props;
  return (
    <section
      id="directive-rail"
      className={styles.rail}
      data-testid="directive-rail"
      data-mode={player ? "player" : "team"}
    >
      {player ? (
        <PlayerContext key={player.id} {...props} player={player} slot={slot} />
      ) : (
        <TeamContext {...props} />
      )}
    </section>
  );
}

function TeamContext(props: DirectiveRailProps) {
  const { tactics, teamPrompt, aiManaged, onTacticsChange, onTeamPromptChange, onToggleAi } = props;
  return (
    <>
      <div className={styles.head} data-testid="rail-head">
        <span className={styles.mini}>TEAM</span>
        <span className={styles.who}>
          <b data-testid="rail-title">팀 지시</b>
          <span>선수를 누르면 그 선수 지시로 바뀐다</span>
        </span>
      </div>

      <div className={styles.body} data-rail-body>
        <div className={styles.group} data-testid="team-tactics-panel">
          <span className={styles.eyebrow}>
            기본 전술
            <span className={styles.tail} />
            <label className={styles.aiToggle}>
              <input
                type="checkbox"
                data-testid="tactics-ai-toggle"
                checked={aiManaged}
                onChange={(e) => onToggleAi(e.target.checked)}
              />
              AI에 맡기기
            </label>
          </span>
          {/* 5스텝 세그먼트 — 서버 계약은 0..1 실수 그대로이고 위젯만 이산화한다(#106 확정).
              `tactics-{key}` testid 는 그룹으로 유지하고 실제 값은 data-value 로 노출한다. */}
          <div className={aiManaged ? styles.dialsDisabled : undefined} aria-disabled={aiManaged}>
            {TACTICS_KEYS.map((key) => {
              // m2: 서버/프리셋에서 온 중간값(예: 0.6)을 "보통"(=0.5)이 눌린 것처럼 그리면
              // 팀 레이어에서 표시≠전송이 된다. 근사일 때는 눌림이 아니라 **근사 표시**로 그리고
              // 실제 전송값을 배지로 노출한다(값은 사용자가 스텝을 누를 때만 바뀐다).
              const d = stepDisplayOf(key, tactics[key]);
              return (
                <div key={key} className={styles.dial}>
                  <span className={styles.dialLabel}>{TACTICS_LABELS[key]}</span>
                  {/* 5스텝 = **하나만 고르는** 선택지 → radiogroup/radio 가 정확한 시맨틱이다(R3b C).
                      R2 는 toggle 버튼(aria-pressed)으로 그렸는데, 스크린리더가 "5개의 독립 토글"로
                      읽어 "지금 몇 단계인지"가 전달되지 않았다. radio 는 "3/5 선택됨"으로 읽힌다. */}
                  <div
                    className={styles.steps}
                    role="radiogroup"
                    aria-label={TACTICS_LABELS[key]}
                    aria-describedby={d.approx ? `tactics-${key}-approx` : undefined}
                    data-testid={`tactics-${key}`}
                    data-value={tactics[key]}
                    data-step={d.index}
                    data-approx={d.approx ? "true" : "false"}
                    onKeyDown={(e) =>
                      radioGroupKeyDown(e, d.index, STEP_COUNT, (i) =>
                        onTacticsChange({ ...tactics, [key]: valueOfStep(i) }),
                      )
                    }
                  >
                    {STEP_LABELS[key].map((label, i) => (
                      <button
                        key={label}
                        type="button"
                        role="radio"
                        /* roving tabindex — 그룹 전체가 탭스톱 하나(APG). */
                        tabIndex={aiManaged ? -1 : rovingTabIndex(i, d.index)}
                        className={i === d.index && d.approx ? styles.stepApprox : undefined}
                        data-testid={`tactics-${key}-step-${i}`}
                        /* 근사(저장값이 단계 사이)일 때는 **어떤 단계도 선택된 게 아니다**.
                           예전엔 가장 가까운 단계에 `aria-pressed="mixed"` 를 줬는데, SR 은 이를
                           "부분적으로 눌림"(체크박스의 3-state)으로 읽어 "단계 사이 값"이라는 실제
                           의미와 어긋났다 — 게다가 radio 는 mixed 를 지원하지 않는다. 그래서
                           aria-checked=false 로 두고 **말로** 상태를 준다(#106 R3b C). */
                        aria-checked={i === d.index && !d.approx}
                        aria-label={
                          i === d.index && d.approx
                            ? `${stepAriaLabel(key, i)} — 저장된 값 ${d.valueText}은 단계 사이입니다. 누르면 이 단계 값으로 바뀝니다`
                            : stepAriaLabel(key, i)
                        }
                        disabled={aiManaged}
                        onClick={() => onTacticsChange({ ...tactics, [key]: valueOfStep(i) })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {d.approx && (
                    <span
                      className={styles.approxNote}
                      id={`tactics-${key}-approx`}
                      data-testid={`tactics-${key}-approx`}
                      title="저장된 값이 단계와 정확히 맞지 않습니다. 단계를 누르면 그 값으로 바뀝니다."
                    >
                      실제 {d.valueText} · 단계 사이 값
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {aiManaged && (
            <p className={styles.aiNote} data-testid="tactics-ai-note">
              팀 전술을 AI가 결정합니다 (수동 값 미전송).
            </p>
          )}
        </div>

        <div className={styles.mark}>
          <label className={styles.markLabel} htmlFor="team-prompt">
            팀 전체에게
          </label>
          <textarea
            id="team-prompt"
            data-testid="editor-team-prompt"
            className={styles.textarea}
            rows={2}
            maxLength={PROMPT_MAX_CHARS}
            placeholder="팀 전체에 내릴 작전 (예: 초반부터 강하게 압박, 역습 위주)"
            value={teamPrompt}
            onChange={(e) => onTeamPromptChange(e.target.value)}
          />
          <div className={styles.meter}>
            <b>{teamPrompt.length}자</b> / {PROMPT_MAX_CHARS}
          </div>
        </div>
      </div>
    </>
  );
}

interface PlayerContextProps extends DirectiveRailProps {
  player: CatalogPlayer;
}

/**
 * 선수 컨텍스트 — 구 PlayerSheet 의 2계층(전술 지시 / 감독의 한마디)을 그대로 이식하되,
 * 헤드는 **한 줄 신원**으로 축약한다(#106: 선수정보 시트 제거).
 */
function PlayerContext(props: PlayerContextProps) {
  const {
    player, slot, slotNumber, condition, trust, personality,
    onPlayerPromptChange, onRemovePlayer, onClose,
  } = props;
  const promptText = slot?.promptText ?? "";
  const placed = Boolean(slot);

  // 영속된 promptText 를 두 레이어로 **되돌려** 채운다(#106 R2). 안 그러면 저장된 합성문이
  // 통째로 자유 문장으로 들어가 칩을 한 번만 눌러도 문장이 중복 누적된다.
  const [directive, setDirective] = useState<DirectiveState>(() => parseDirectiveText(promptText).state);
  const [freeText, setFreeText] = useState<string>(() => parseDirectiveText(promptText).freeText);
  /**
   * m1 — 방금 **감독의 한마디로 옮겨진** 문장(안내용).
   *
   * 저장 포맷이 단일 문자열이라 "칩이 만든 문장"과 "내가 우연히 똑같이 쓴 문장"은 구별할 수 없다.
   * 그래서 추론된 항목을 끄면 그 문장을 **즉시 자유 문장으로 옮기고**, 이 안내는 무슨 일이
   * 있었는지만 알려준다 — 안내를 놓치거나 덮여도 데이터는 이미 안전하다(재검증 blocker-2).
   */
  const [moved, setMoved] = useState<string | null>(null);
  const movedRef = useRef<HTMLDivElement>(null);

  // 안내는 **보여야** 의미가 있다 — 모바일 독은 내부 스크롤러라 그냥 두면 fold 아래에 뜬다.
  // ("nearest" 는 최소 이동이라 바닥 sticky 미리보기 뒤에 가려 붙었다 → 스크롤러 가운데로.)
  useEffect(() => {
    if (moved) movedRef.current?.scrollIntoView({ block: "center" });
  }, [moved]);

  // 다른 선수로 전환되면 그 선수의 프롬프트로 다시 갈라 담는다(컴포넌트는 key=player.id 로
  // 재마운트되지만 같은 선수의 slot 이 나중에 도착하는 경우를 위해 유지).
  useEffect(() => {
    const parsed = parseDirectiveText(promptText);
    setDirective(parsed.state);
    setFreeText(parsed.freeText);
    setMoved(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.id]);

  function push(nextDirective: DirectiveState, nextFree: string) {
    setDirective(nextDirective);
    setFreeText(nextFree);
    onPlayerPromptChange(player.id, composeLayers(nextDirective, nextFree).text);
  }

  /** 역할·칩 편집 — 추론 문장은 자유 문장으로 **이미 옮겨진 채** 들어온다(소실 경로 없음). */
  function pushEdit(edit: DirectiveEditResult) {
    push(edit.state, edit.freeText);
    if (edit.moved) setMoved(edit.moved);
  }

  // 미리보기와 전송값의 **유일한 출처**. 화면에 그리는 두 줄과 push() 가 보내는 문자열이 같다.
  const roleIndex = Math.max(0, ROLE_OPTIONS.findIndex((r) => r.id === directive.role));
  const composed = composeLayers(directive, freeText);
  const combinedLen = composed.text.length;
  const over = combinedLen > PROMPT_MAX_CHARS;
  const personalityValue = personality ?? player.personality;

  return (
    <>
      {/* 한 줄 신원 = 구 선수정보 시트의 대체물 (#106 요구 2).
          #187: hero 가 "유닛 눌렀을 때 유닛 정보에 풀 일러도 같이" 를 요구했다. 새 시트를
          되살리지 않고 **여기에 카드를 얹는다** — #106 이 시트를 없앤 이유(화면이 점프한다)를
          그대로 지키면서 일러스트만 더한다. 보드 토큰 탭·리스트 탭 둘 다 이 헤드로 들어온다. */}
      <div className={styles.head} data-testid="rail-head">
        {/* ⚠️ `data-rail-art` = **접힌 독에서는 숨는다**(DeckEditor.module.css).
            모바일 독은 접혀도 헤드가 보이는 구조라, 여기에 165px 카드를 상주시키면 접힌 독이
            그만큼 커져 보유 선수 리스트를 덮는다 — #106 R3a/R3b 의 죽은 띠·탭 타깃 계약이 깨진다
            (실제로 deck-teamsheet e2e 5건이 이걸 잡았다). 데스크탑 레일은 항상 펼침이라 늘 보인다. */}
        <span data-rail-art>
          <FullArtCard
            playerId={player.id}
            name={player.name}
            grade={player.grade}
            position={player.position}
            size="rail"
            /* 이름·포지션·컨디션은 바로 옆 한 줄이 말한다 → 아트만(빈 밴드 제거, #187). */
            variant="art"
            className={styles.headArt}
          />
        </span>
        <span className={styles.mini}>{slotNumber ?? "—"}</span>
        <span className={styles.who}>
          <b data-testid="rail-title">{player.name}</b>
          <span data-testid="rail-subtitle">
            {player.position}
            {condition != null ? ` · 컨디션 ${conditionLabel(condition)}` : ""}
            {placed ? "" : " · 배치할 슬롯을 고르세요"}
          </span>
        </span>
        {personalityValue && (
          <span className={styles.relation} data-testid="rail-relation">
            <PersonalityBadge personality={personalityValue} />
            {trust != null && <TrustGauge trust={trust} />}
          </span>
        )}
        <button type="button" className={styles.close} data-testid="rail-close" aria-label="닫고 팀 지시로" onClick={onClose}>
          ×
        </button>
      </div>

      <div className={styles.body} data-rail-body>
        {/* ① 익숙한 전술 포맷 — 역할 세그먼트 */}
        <div className={styles.group} data-testid="rail-tactical-layer">
          <span className={styles.eyebrow}>
            역할<span className={styles.tail} />
          </span>
          {/* 역할 = 배타 선택 → radiogroup/radio (세부 지시 칩은 다중 토글이라 aria-pressed 유지). */}
          <div
            className={styles.seg}
            role="radiogroup"
            aria-label="역할"
            data-testid="rail-role"
            onKeyDown={(e) =>
              radioGroupKeyDown(e, roleIndex, ROLE_OPTIONS.length, (i) =>
                pushEdit(setRoleSafely(directive, freeText, ROLE_OPTIONS[i]!.id)),
              )
            }
          >
            {ROLE_OPTIONS.map((r, i) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                /* roving tabindex — 그룹 전체가 탭스톱 하나(APG). */
                tabIndex={!placed ? -1 : rovingTabIndex(i, roleIndex)}
                data-testid={`rail-role-${r.id}`}
                aria-checked={directive.role === r.id}
                disabled={!placed}
                onClick={() => pushEdit(setRoleSafely(directive, freeText, r.id))}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* ② 세부 지시 칩 (서번트 지시 카탈로그 6종과 1:1) */}
          <span className={styles.eyebrow}>
            세부 지시<span className={styles.tail} />
          </span>
          <div className={styles.chips} role="group" aria-label="세부 지시">
            {DIRECTIVE_CHIPS.map((chip) => {
              const active = directive.chipIds.includes(chip.id);
              return (
                <button
                  key={chip.id}
                  type="button"
                  className={styles.chip}
                  data-testid={`rail-chip-${chip.id}`}
                  aria-pressed={active}
                  disabled={!placed}
                  onClick={() => pushEdit(toggleChipSafely(directive, freeText, chip.id))}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ③ 우리 차별점 레이어 — 자유 문장 */}
        <div className={styles.mark}>
          <span className={styles.markLabel}>감독의 한마디</span>
          <textarea
            className={over ? styles.textareaOver : styles.textarea}
            data-testid="rail-prompt-input"
            aria-label="감독의 한마디"
            rows={3}
            maxLength={PROMPT_MAX_CHARS}
            disabled={!placed}
            placeholder="이 선수에게 자유롭게 한마디 (예: 오늘 너만 믿는다, 과감하게 슛 노려)"
            value={freeText}
            onChange={(e) => push(directive, e.target.value)}
          />
          <div className={styles.meter}>
            <b data-testid="rail-counter">{combinedLen}</b> / {PROMPT_MAX_CHARS} · 이 문장은 그대로 AI에게 전달된다
            {placed && (
              <button
                type="button"
                className={styles.remove}
                data-testid="rail-remove-player"
                onClick={() => onRemovePlayer(player.id)}
              >
                덱에서 제거
              </button>
            )}
          </div>
        </div>

        {/* m1 안내 — 저장된 프롬프트에서 인식해 켰던 항목을 끄면 그 문장을 **감독의 한마디로 옮긴다**.
            (칩이 만든 문장인지 내가 쓴 문장인지 문자열로는 구별할 수 없으므로, 지우는 대신 옮긴다.)
            이 안내는 알림일 뿐이라 놓쳐도 데이터는 이미 위 한마디 칸에 들어가 있다. */}
        {/* 라이브 리전은 **미리 DOM 에 있어야** 한다 — `role="status"` 노드를 내용과 함께 새로
            삽입하면 SR 이 리전 등록 전에 내용이 들어와 읽지 않는 경우가 많다(브라우저/SR 조합에 따라
            무음). 그래서 빈 리전을 상시 유지하고 문장만 갈아끼운다(#106 R3b C). 시각 배너는 아래
            별도로 그린다 — 배너에는 닫기 버튼(포커스 가능)이 있어 `aria-hidden` 을 걸 수 없으므로
            배너 자체는 라이브가 아닌 일반 콘텐츠로 두고, 알림 역할만 이 리전이 진다. */}
        <div className={styles.srOnly} role="status" aria-live="polite" data-testid="rail-moved-live">
          {moved ? `${moved} 문장을 감독의 한마디로 옮겼습니다.` : ""}
        </div>

        {moved && (
          <div ref={movedRef} className={styles.recover} data-testid="rail-moved">
            <p className={styles.recoverText}>
              <b data-testid="rail-moved-phrase">{moved}</b> 문장을 <b>감독의 한마디</b>로 옮겼습니다.
              저장된 프롬프트에서 인식한 문장이라 지우지 않았습니다 — 필요 없으면 위에서 지우세요.
            </p>
            <div className={styles.recoverActions}>
              <button
                type="button"
                className={styles.recoverDismiss}
                data-testid="rail-moved-dismiss"
                aria-label="알림 닫기"
                onClick={() => setMoved(null)}
              >
                ×
              </button>
            </div>
          </div>
        )}

        {/* ④ A안의 핵심 전달물 — 두 레이어가 한 자리에서 **구분된 채** 합쳐진 결과.
            단색 accent 스킨이라 색으로 못 가르므로 라벨 + 좌측 룰 + 들여쓰기로 출처를 인코딩한다.
            여기 보이는 두 줄을 이어붙인 것이 곧 서버로 가는 promptText 다(composeLayers 단일 출처). */}
        <div className={styles.compose} data-testid="rail-compose">
          <span className={styles.cap}>AI에 전달될 지시문</span>
          {composed.directiveText && (
            <div className={styles.cline}>
              <span className={styles.clab}>선택지에서</span>
              <p className={styles.ctext} data-testid="rail-compose-directive">
                {composed.directiveText}
              </p>
            </div>
          )}
          {composed.ownText && (
            <div className={`${styles.cline} ${styles.own}`}>
              <span className={styles.clab}>내가 쓴 문장</span>
              <p className={styles.ctext} data-testid="rail-compose-own">
                {composed.ownText}
              </p>
            </div>
          )}
          {!composed.text && (
            <p className={styles.cempty} data-testid="rail-compose-empty">
              아직 이 선수에게 전달될 지시가 없습니다.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

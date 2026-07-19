import { useEffect, useState } from "react";
import type { CatalogPlayer } from "../api/hooks";
import type { Personality, TeamTactics } from "../api/v2";
import { PersonalityBadge, TrustGauge } from "../common/RelationBits";
import { conditionLabel } from "../match/condition-clock";
import { PROMPT_MAX_CHARS, type DraftSlot } from "./deck-logic";
import {
  composeLayers,
  DIRECTIVE_CHIPS,
  parseDirectiveText,
  ROLE_OPTIONS,
  toggleChip,
  type DirectiveState,
} from "./directives";
import { TACTICS_KEYS, TACTICS_LABELS } from "./tactics-logic";
import { STEP_LABELS, stepAriaLabel, stepIndexOf, valueOfStep } from "./tactics-steps";
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
export function DirectiveRail(props: DirectiveRailProps) {
  const { player, slot } = props;
  return (
    <section className={styles.rail} data-testid="directive-rail" data-mode={player ? "player" : "team"}>
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
              const active = stepIndexOf(tactics[key]);
              return (
                <div key={key} className={styles.dial}>
                  <span className={styles.dialLabel}>{TACTICS_LABELS[key]}</span>
                  <div
                    className={styles.steps}
                    role="group"
                    aria-label={TACTICS_LABELS[key]}
                    data-testid={`tactics-${key}`}
                    data-value={tactics[key]}
                    data-step={active}
                  >
                    {STEP_LABELS[key].map((label, i) => (
                      <button
                        key={label}
                        type="button"
                        data-testid={`tactics-${key}-step-${i}`}
                        aria-pressed={i === active}
                        aria-label={stepAriaLabel(key, i)}
                        disabled={aiManaged}
                        onClick={() => onTacticsChange({ ...tactics, [key]: valueOfStep(i) })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
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

  // 다른 선수로 전환되면 그 선수의 프롬프트로 다시 갈라 담는다(컴포넌트는 key=player.id 로
  // 재마운트되지만 같은 선수의 slot 이 나중에 도착하는 경우를 위해 유지).
  useEffect(() => {
    const parsed = parseDirectiveText(promptText);
    setDirective(parsed.state);
    setFreeText(parsed.freeText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.id]);

  function push(nextDirective: DirectiveState, nextFree: string) {
    setDirective(nextDirective);
    setFreeText(nextFree);
    onPlayerPromptChange(player.id, composeLayers(nextDirective, nextFree).text);
  }

  // 미리보기와 전송값의 **유일한 출처**. 화면에 그리는 두 줄과 push() 가 보내는 문자열이 같다.
  const composed = composeLayers(directive, freeText);
  const combinedLen = composed.text.length;
  const over = combinedLen > PROMPT_MAX_CHARS;
  const personalityValue = personality ?? player.personality;

  return (
    <>
      {/* 한 줄 신원 = 구 선수정보 시트의 대체물 (#106 요구 2) */}
      <div className={styles.head} data-testid="rail-head">
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
          <div className={styles.seg} role="group" aria-label="역할" data-testid="rail-role">
            {ROLE_OPTIONS.map((r) => (
              <button
                key={r.id}
                type="button"
                data-testid={`rail-role-${r.id}`}
                aria-pressed={directive.role === r.id}
                disabled={!placed}
                onClick={() => push({ ...directive, role: r.id }, freeText)}
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
                  onClick={() => push(toggleChip(directive, chip.id), freeText)}
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

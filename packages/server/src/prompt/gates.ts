import type { PromptDelta, TacticalInput, OpponentRosterEntry } from "@hmb/shared";

/**
 * 산출 정합 게이트 (#193 W2b-B3) — 두 kind(team-input · team-input-patch) 공통, **최종 TacticalInput 기준**.
 *
 * 설계 원칙: **값의 '방향'은 강제하지 않는다**(감독 지시 해석의 자유도 불변).
 * 여기서 막는 것은 두 가지뿐 —
 *  - **자기모순**: 조합 자체가 축구적으로 성립하지 않는 것(낮은 라인 + 오프사이드 트랩).
 *  - **물리 파손 / 지시 미이행**: 배치가 깨지거나(동일 좌표 밀집), 마킹 지시를 받고도 대상이 없음.
 *
 * throw 메시지가 곧 피드백이다 — ExecutorLoop.executeWithGate 가 이 문구를 그대로 1회 재시도 프롬프트에
 * 실어 보낸다(기존 경로 재사용, 새 배선 없음).
 */

/** 게이트 임계(하드코딩 금지 — 튜닝은 이 오브젝트에서). */
export const SANITY_GATE_CONFIG = {
  /** G1: 오프사이드 트랩을 켤 수 있는 최소 수비라인 높이. 이 미만 + 트랩 ON = 자기모순. */
  trapMinLineHeight: 0.45,
  /**
   * G3: 두 선수 basePosition 사이의 최소 간격(정규화 좌표 유클리드). 이 미만 = 사실상 같은 점.
   *
   * <p>#324 로 **이 하나가 G3 의 전부**가 됐다. 종전엔 "같은 좌표 문자열에 3명 이상"만 봤는데
   * (`maxPlayersSameSpot: 2`), 라이브에서 블루 월 센터백 <b>둘</b>이 정확히 같은 좌표(0.17, 0.5)를
   * 받아 전반의 24.9% 를 1m 안에 붙어 있었다(대조군 5경기 0.4~1.1%) — 화면에선 백5가 점 4개로 보였다.
   * 인원수를 세는 노브를 1 로 낮춰 봐야 이 간격 검사가 그 경우를 이미 포섭하므로(거리 0 &lt; 임계)
   * 노브만 남기면 <b>되돌려도 아무 테스트가 안 깨지는 공허한 설정</b>이 된다. 그래서 검사를 하나로 합쳤다.
   *
   * <p>보정 근거(라이브 인풋 202개 전수): 결함 9건은 "가장 가까운 두 선수" 거리가 <b>정확히 0</b>,
   * 정상 인풋의 최소값은 <b>0.04</b>. 그 사이가 비어 있어 (0, 0.04) 안의 어떤 값도 오탐 0 이다 —
   * 양쪽 여유가 같은 0.02 를 골랐다(피치로 x 2.1m · y 1.4m 수준).
   */
  minSpotSeparation: 0.02,
} as const;

/** 마킹 동사 — 카탈로그 marking 지시어(stub 과 동일 어휘). 이것만으로는 발동하지 않는다(아래 참조). */
const MARKING_RE = /막아|마크|전담|mark/i;

/**
 * 문장 분리 — 지목은 <b>같은 문장 안</b>에서만 유효하다.
 * "뒷공간을 막아라. A9 는 빠르니 라인을 내려라" 처럼 마킹 동사와 이름이 서로 다른 지시에 있으면
 * 그건 "A9 를 마크하라"가 아니다.
 */
const SENTENCE_SPLIT_RE = /[\n.!?;·]+/;

const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** playerId 는 단어 경계로 매치(A1 이 A10 에 걸리지 않게). */
const mentionsId = (text: string, id: string): boolean =>
  id.trim() !== "" && new RegExp(`\\b${escapeRe(id)}\\b`).test(text);
const mentionsName = (text: string, name: string): boolean => name.trim() !== "" && text.includes(name);

/** 마킹 지목 1건 — 어느 문장에서 누구를(로스터 엔트리) 지목했는지. */
export interface MarkingDesignation {
  sentence: string;
  target: OpponentRosterEntry;
}

/**
 * "마크할 대상을 <b>실제로 지목한</b> 마킹 지시"를 찾는다 — 같은 문장에 (마킹 동사) + (상대 로스터의
 * 이름 또는 playerId) 가 함께 있어야 한다. 없으면 undefined.
 *
 * <p>왜 지목을 요구하나(#193 검증 B-1): 마킹 동사만으로 발동하면 <b>지시가 아닌 것</b>까지 걸린다 —
 * "골을 막아라"(GK 개인 지시) · "뒷공간을 막아라"(공간 차단)는 마킹이 아니고, "상대 에이스를 전담
 * 마크"는 마킹이지만 <b>누구인지는 모델이 판단할 몫</b>이다(자유도 원칙 §2). 게이트가 막아야 하는
 * 것은 "이 선수를 마크하라고 했는데 아무도 마크하지 않았다"는 <b>명시적 지시의 미이행</b>뿐이다.
 */
export function findMarkingDesignation(
  text: string,
  opponentRoster: readonly OpponentRosterEntry[],
): MarkingDesignation | undefined {
  for (const sentence of text.split(SENTENCE_SPLIT_RE)) {
    if (!MARKING_RE.test(sentence)) continue;
    const target = opponentRoster.find(
      (o) => mentionsName(sentence, o.name) || mentionsId(sentence, o.playerId),
    );
    if (target) return { sentence: sentence.trim(), target };
  }
  return undefined;
}

/** 게이트가 보는 요청 컨텍스트(두 kind 공통 부분집합 — 잡 컨텍스트를 그대로 넘겨도 구조적으로 호환). */
export interface SanityGateContext {
  teamPrompt: string;
  playerPrompts: Record<string, string>;
  opponentRoster?: readonly OpponentRosterEntry[];
  promptDelta?: PromptDelta;
}

/**
 * 게이트가 "이번 요청의 지시"로 보는 텍스트.
 *
 * <p><b>델타 모드</b>(promptDelta 있음) = 이번에 <b>바뀐 지시(new)</b>만. 캐리오버 지시(teamPrompt·
 * playerPrompts 에 남아 있는 전반부터의 지시)는 베이스(A/h1 인풋)가 이미 반영한 것이고, 모델에게도
 * 변경분만 제시한다(델타 프롬프트) — 그런데 게이트만 전체로 채점하면 <b>비대칭</b>이 된다(#193 검증
 * M-1): 마킹과 무관한 변경을 낼 때마다 "옛 마킹 지시를 이행하지 않았다"로 계속 실패한다.
 * 삭제된 옛 지시(promptDelta.*.old)는 어느 모드에서도 보지 않는다(철회된 지시를 강제하지 않는다).
 *
 * <p>델타가 없으면(구계약·풀 생성) 기존대로 팀 지시 + 개인 지시 전체.
 */
export function gateContextText(ctx: SanityGateContext): string {
  const d = ctx.promptDelta;
  const isDelta = d !== undefined && (d.team !== undefined || Object.keys(d.players ?? {}).length > 0);
  if (isDelta) {
    const parts: string[] = [];
    if (d?.team?.new) parts.push(d.team.new);
    for (const entry of Object.values(d?.players ?? {})) {
      if (entry.new) parts.push(entry.new);
    }
    return parts.join("\n");
  }
  return [ctx.teamPrompt, ...Object.values(ctx.playerPrompts)].join("\n");
}

/**
 * 최종 TacticalInput 정합 검사. 위반 시 throw(메시지 = 재시도 피드백).
 * 순수 함수 — 두 kind 의 validate 말미에서 호출된다.
 */
export function assertTacticalSanity(input: TacticalInput, ctx: SanityGateContext): void {
  const cfg = SANITY_GATE_CONFIG;

  // ── G1 트랩 자기모순: 라인을 내려 두고 오프사이드 트랩을 켜는 건 성립하지 않는다.
  if (input.team.offsideTrap && input.team.defensiveLineHeight < cfg.trapMinLineHeight) {
    throw new Error(
      `낮은 수비라인(defensiveLineHeight ${input.team.defensiveLineHeight})에서 오프사이드트랩 활성은 자기모순 — ` +
        `트랩을 끄거나 라인을 ${cfg.trapMinLineHeight} 이상으로 올려라`,
    );
  }

  // ── G2 마킹 지시 미이행: **대상을 지목한** 마킹 지시를 받고도 markTarget 이 하나도 없다.
  //    지목이 없는 마킹("에이스를 마크")·비마킹("골을 막아라")은 발동하지 않는다 — 대상 선택은
  //    모델 재량이다(#193 검증 B-1). 상대 로스터가 없으면 애초에 지목이 성립하지 않는다
  //    (유령 id 를 지어내게 만들지 않는다).
  const opponents = ctx.opponentRoster ?? [];
  if (opponents.length > 0) {
    const designation = findMarkingDesignation(gateContextText(ctx), opponents);
    const marks = input.players.filter((p) => p.markTarget !== undefined && p.markTarget !== "").length;
    if (designation && marks === 0) {
      throw new Error(
        `마킹 지시("${designation.sentence}")가 대상 ${designation.target.playerId}` +
          `(${designation.target.name})를 지목했으나 markTarget 미설정 — ` +
          `해당 상대를 맡을 수비수의 markTarget 을 설정하라`,
      );
    }
  }

  // ── G3 배치 파손: 두 선수가 사실상 같은 점에 서면 포메이션이 그만큼 붕괴한다.
  //    (0..1 범위 이탈은 shared clampTacticalInput 이 이미 처리 — 게이트는 밀집만 본다.)
  //    좌표 '문자열 일치'가 아니라 **간격**으로 본다: 문자열로 걸면 0.170 vs 0.171 로 새고,
  //    인원수로 걸면 라이브 결함(정확히 2명)이 통과한다 — 둘 다 실제로 겪은 구멍이다(#324).
  const tooClose: string[] = [];
  for (let i = 0; i < input.players.length; i++) {
    for (let j = i + 1; j < input.players.length; j++) {
      const a = input.players[i]!, b = input.players[j]!;
      const d = Math.hypot(a.basePosition.x - b.basePosition.x, a.basePosition.y - b.basePosition.y);
      if (d < cfg.minSpotSeparation) {
        tooClose.push(
          `${a.playerId}(${a.basePosition.x},${a.basePosition.y})~` +
            `${b.playerId}(${b.basePosition.x},${b.basePosition.y}) 간격 ${d.toFixed(3)}`,
        );
      }
    }
  }
  if (tooClose.length > 0) {
    throw new Error(
      `배치 파손 — 사실상 같은 지점에 선 선수들이 있다: ${tooClose.join(" · ")}. ` +
        `겹친 선수들을 서로 최소 ${cfg.minSpotSeparation} 이상 떨어뜨려 배치하라`,
    );
  }
}

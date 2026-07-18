/**
 * 원탭 디테일 지시 (AC-C4 마킹) — 상대/상황을 대상으로 하는 "한 번 탭으로 프롬프트가 합성되는"
 * 지시들의 일반화된 카탈로그. 마킹이 첫 사례이며, 추후 지시(협공·프리롤 견제 등)는 이 배열에
 * 항목만 더하면 UI 가 그대로 원탭 칩을 노출한다 — PlayerSheet 의 6종 성향칩(directives.ts)과
 * 정합하되, 이쪽은 "특정 대상(target)"을 받는 문맥 지시라 별도 파이프라인으로 둔다.
 *
 * 합성 결과는 내 수비수의 per-player promptText 에 한 줄로 덧붙는다(기존 프롬프트 보존).
 * 이 문자열이 그대로 서버로 전송돼 user_deck_json 의 선수 프롬프트로 영속된다.
 */

export interface OneTapDirective {
  id: string;
  /** 칩 라벨 (대상 이름을 넣어 렌더) */
  label: (targetName: string) => string;
  /** 프롬프트에 덧붙일 자연어 한 줄 */
  synthesize: (targetName: string) => string;
  /** 배정 안내 문구(수비수 자동/수동 배정 설명용) */
  assignHint: (targetName: string, defenderName: string) => string;
}

/** 마킹: "[상대이름] 막아" — 내 수비수에게 대인 마크를 지시. */
export const MARK_DIRECTIVE: OneTapDirective = {
  id: "mark",
  label: (name) => `${name} 마크`,
  synthesize: (name) => `${name} 막아`,
  assignHint: (name, defender) => `${defender} 에게 "${name} 막아" 지시가 배정됩니다`,
};

/** 확장 지점: 새 원탭 지시는 여기 추가하면 UI 가 자동 노출한다. */
export const ONE_TAP_DIRECTIVES: OneTapDirective[] = [MARK_DIRECTIVE];

export function findOneTapDirective(id: string): OneTapDirective | undefined {
  return ONE_TAP_DIRECTIVES.find((d) => d.id === id);
}

/**
 * 합성된 지시를 기존 프롬프트에 덧붙인다. 이미 같은 문장이 있으면 중복 추가하지 않는다(멱등).
 * 기존 자유 프롬프트는 보존하고 새 줄로 이어붙인다.
 */
export function appendDirective(existing: string | null | undefined, fragment: string): string {
  const base = (existing ?? "").trim();
  const line = fragment.trim();
  if (!line) return base;
  if (!base) return line;
  // 동일 문장 중복 방지(줄 단위 비교)
  const has = base.split(/\r?\n/).some((l) => l.trim() === line);
  return has ? base : `${base}\n${line}`;
}

export interface DefenderCandidate {
  playerId: string;
  name: string;
  position: string;
}

/**
 * 자동 배정 대상 수비수를 고른다: DF 우선, 없으면 MF, 그 다음 아무 필드플레이어(GK 제외).
 * 후보 순서를 유지하므로 결정론적(첫 적합 선수). 없으면 undefined.
 */
export function autoAssignDefender(candidates: DefenderCandidate[]): DefenderCandidate | undefined {
  const nonGk = candidates.filter((c) => c.position !== "GK");
  return (
    nonGk.find((c) => c.position === "DF") ??
    nonGk.find((c) => c.position === "MF") ??
    nonGk[0]
  );
}

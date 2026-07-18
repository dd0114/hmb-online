// ai-budget-core — AC-C5 / P2-D8 예산 하네스의 **순수 계측 코어**(부수효과·IO·rng·date 0).
// ai-budget.mjs(CLI + 라이브 claude 콜)와 ai-budget.test.ts(회귀 가드)가 공유한다.
// (.ts 로 두어 vite/vitest·tsx 양쪽에서 동일 해상도 — .mjs→.js 임포트 해상도 불일치 회피.)
import { buildTeamInputPrompt } from "../src/prompt/coach.js";
import { synthesizeDirectivesSection, DIRECTIVES } from "../src/prompt/directives/index.js";
import {
  makeTeamInputContext,
  makeManualTactics,
  makeConditions,
  makeRelations,
  makeOpponentRoster,
} from "../src/executor/test-fixtures.js";

/** 토크나이저 근사 — 문자수/4(영·한 혼합 프롬프트의 보수적 상한 근사). 실측은 --live 의 usage.input_tokens. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const measure = (text: string) => ({ chars: text.length, approxTokens: approxTokens(text) });

/** 고정 teamMorale 픽스처(연승 문맥) — 블록 계측용 대표값. */
const MORALE_FIXTURE = { morale: 66, streak: 2 } as const;

export interface BudgetVariant {
  id: string;
  label: string;
  prompt: string;
}

/**
 * 온/오프 매트릭스 변형 집합. base = Phase2 컨텍스트 전부 off(카탈로그는 안정 프리픽스라 항상 on).
 * 각 +블록 = base 에 그 블록 하나만 켠 컨텍스트. allOn = 전부 on.
 */
export function buildVariants(): BudgetVariant[] {
  const baseCtx = makeTeamInputContext();
  const blockCtx: Record<string, Partial<Parameters<typeof makeTeamInputContext>[0]>> = {
    manualTactics: { manualTactics: makeManualTactics() },
    conditions: { conditions: makeConditions() },
    relations: { relations: makeRelations() },
    teamMorale: { teamMorale: { ...MORALE_FIXTURE } },
    opponentRoster: { opponentRoster: makeOpponentRoster() },
  };
  const allOnCtx = makeTeamInputContext({
    manualTactics: makeManualTactics(),
    conditions: makeConditions(),
    relations: makeRelations(),
    teamMorale: { ...MORALE_FIXTURE },
    opponentRoster: makeOpponentRoster(),
  });

  const variants: BudgetVariant[] = [
    { id: "base", label: "기본(Phase2 컨텍스트 off, 카탈로그 on)", prompt: buildTeamInputPrompt(baseCtx) },
  ];
  for (const [id, ov] of Object.entries(blockCtx)) {
    variants.push({ id, label: `+${id}`, prompt: buildTeamInputPrompt(makeTeamInputContext(ov)) });
  }
  variants.push({ id: "allOn", label: "전부 on", prompt: buildTeamInputPrompt(allOnCtx) });
  return variants;
}

export interface BudgetBlock {
  id: string;
  chars: number;
  approxTokens: number;
  deltaChars: number;
  deltaTokens: number;
  note?: string;
}

export interface BudgetReport {
  mode: string;
  tokenizer: string;
  base: { chars: number; approxTokens: number };
  catalogSection: { chars: number; approxTokens: number };
  baseSansCatalog: { chars: number; approxTokens: number };
  blocks: BudgetBlock[];
  allOn: { chars: number; approxTokens: number; deltaChars: number; deltaTokens: number };
  live: unknown;
}

/**
 * 오프라인 예산 리포트 — 블록별 입력 토큰 증분(근사)을 산출.
 * base 대비 각 +블록의 Δ, 카탈로그 컴포넌트 크기, allOn 총량을 담는다.
 */
export function measureBudget(): BudgetReport {
  const variants = buildVariants();
  const byId = Object.fromEntries(variants.map((v) => [v.id, v]));
  const base = measure(byId.base!.prompt);

  // 카탈로그(full) 컴포넌트: 프롬프트 프리픽스에 상주하는 지시 카탈로그 섹션 자체의 크기.
  const catalogText = synthesizeDirectivesSection(DIRECTIVES);
  const catalogSection = measure(catalogText);
  const baseSansCatalog = {
    chars: base.chars - catalogSection.chars,
    approxTokens: base.approxTokens - catalogSection.approxTokens,
  };

  const blockIds = ["manualTactics", "conditions", "relations", "teamMorale", "opponentRoster"];
  const blocks: BudgetBlock[] = blockIds.map((id) => {
    const m = measure(byId[id]!.prompt);
    return {
      id,
      chars: m.chars,
      approxTokens: m.approxTokens,
      deltaChars: m.chars - base.chars,
      deltaTokens: m.approxTokens - base.approxTokens,
    };
  });
  // 카탈로그(full)는 base 프리픽스에 상주 → base(카탈로그 제외) 대비 증분으로 표기.
  blocks.push({
    id: "catalog(full)",
    chars: base.chars,
    approxTokens: base.approxTokens,
    deltaChars: catalogSection.chars,
    deltaTokens: catalogSection.approxTokens,
    note: "지시 카탈로그 섹션은 안정 프리픽스로 base 에 상주(항상 on). Δ = 카탈로그 제외 base 대비 카탈로그 차지분.",
  });

  const allOn = measure(byId.allOn!.prompt);
  return {
    mode: "offline-approx",
    tokenizer: "chars/4 heuristic (실측 아님 — --live 의 usage.input_tokens 로 채움)",
    base,
    catalogSection,
    baseSansCatalog,
    blocks,
    allOn: {
      chars: allOn.chars,
      approxTokens: allOn.approxTokens,
      deltaChars: allOn.chars - base.chars,
      deltaTokens: allOn.approxTokens - base.approxTokens,
    },
    live: null,
  };
}

import type { Directive } from "./types.js";
import { marking } from "./marking.js";
import { overlap } from "./overlap.js";
import { forwardRun } from "./forward-run.js";
import { longBall } from "./long-ball.js";
import { pressTrigger } from "./press-trigger.js";
import { tempoControl } from "./tempo-control.js";

export type { Directive, DirectiveExample } from "./types.js";

/**
 * 지시 카탈로그 레지스트리 — **명시적 배열**(파일 스캔 아님, 결정론·순서 고정).
 * 지시 추가/제거 = 파일 1개 + 이 배열 1줄. 순서가 프롬프트·스냅샷 순서를 결정한다.
 *
 * marking 을 선두에 둔다(AC-C2 핵심). 나머지는 기존 coach.ts COACH_SYSTEM 인라인 지시성 문구 이식분.
 */
export const DIRECTIVES: readonly Directive[] = [
  marking,
  overlap,
  forwardRun,
  longBall,
  pressTrigger,
  tempoControl,
];

/**
 * 카탈로그 → 프롬프트 "지원 지시" 섹션 문자열. **순수 함수**(부수효과·IO 0).
 *
 * 재사용 계약(A+B 수용): directives 를 인자로 받으므로 현행 단일생성 coach 프롬프트에도,
 * 향후 #82 A+B 린패치 프롬프트에도 동일 카탈로그를 그대로 끼워 넣을 수 있다.
 * A(수동전술 베이스) 프롬프트든 B(관계·사기 델타) 프롬프트든 이 섹션은 불변으로 재사용된다.
 *
 * @param directives  렌더할 지시 목록(기본 = 전체 레지스트리). 부분집합을 넘기면 그만큼만 합성(AC-C3 제거).
 * @param satisfiedContext  이번 요청에 제공된 컨텍스트 키 집합. 주면 미충족 contextNeeds 를 주의 표기.
 */
export function synthesizeDirectivesSection(
  directives: readonly Directive[] = DIRECTIVES,
  satisfiedContext?: ReadonlySet<string>,
): string {
  const lines: string[] = [
    "지원 지시 카탈로그 — 감독의 자연어 지시를 아래 유형으로 해석해 지정된 필드에 반영한다:",
  ];
  for (const d of directives) {
    lines.push("", `[${d.title}] (id: ${d.id})`);
    lines.push(`  해석: ${d.promptGuide}`);
    lines.push(`  출력 필드: ${d.outputFields.join(", ")}`);
    if (d.contextNeeds.length > 0) {
      lines.push(`  필요 컨텍스트: ${d.contextNeeds.join(", ")}`);
      if (satisfiedContext) {
        const missing = d.contextNeeds.filter((c) => !satisfiedContext.has(c));
        if (missing.length > 0) {
          lines.push(`  (주의: ${missing.join(", ")} 미제공 — 이 지시는 이번 요청에서 생략)`);
        }
      }
    }
    lines.push("  예시:");
    for (const ex of d.examples) {
      lines.push(`    · "${ex.instruction}" → ${ex.effect}`);
    }
  }
  return lines.join("\n");
}

/** 카탈로그가 필요로 하는 모든 컨텍스트 키(중복 제거, 등장 순서 유지). 빌더의 컨텍스트 주입 판단용. */
export function collectContextNeeds(directives: readonly Directive[] = DIRECTIVES): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of directives) {
    for (const c of d.contextNeeds) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
  }
  return out;
}

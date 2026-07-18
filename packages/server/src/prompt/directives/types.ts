/**
 * Directive — 지시 카탈로그의 플러그인 단위 (PRD-v3 AC-C3, P2-D6, LLD-p2-servants §1).
 *
 * 지시 1종 = "감독의 자연어 지시 유형"을 AI 가 TacticalInput 필드로 번역하는 법을 담은 순수 데이터.
 * 파일 1개(이 인터페이스 구현) + index.ts 레지스트리 1줄 = 지시 증감(스캔 아님, 결정론 배열).
 *
 * 이 데이터는 프롬프트 합성(synthesizeDirectivesSection)에만 쓰이는 **순수 값** — 부수효과·IO 없음.
 * → coach 빌더(현행 단일생성)에도, 향후 #82 A+B 린패치 프롬프트에도 동일 카탈로그를 재사용한다.
 */

/** few-shot 예시 한 건: 자연어 지시 → 기대 매핑 설명. */
export interface DirectiveExample {
  /** 감독 자연어 지시(원문 형태). */
  instruction: string;
  /** 그 지시가 어떤 TacticalInput 필드로 어떻게 반영되는지 설명(few-shot 근거). */
  effect: string;
}

export interface Directive {
  /** 안정 식별자(레지스트리 키, 스냅샷·제거 테스트 기준). 소문자-하이픈. */
  id: string;
  /** 사람용 한글 라벨(프롬프트 섹션 제목). */
  title: string;
  /**
   * AI 에게 이 지시 유형을 해석하는 법을 설명하는 프롬프트 조각.
   * "어떤 표현이 이 지시인지 + 어느 필드로 어떻게 옮기는지"를 서술.
   */
  promptGuide: string;
  /** 이 지시가 표현되는 TacticalInput 출력 필드(경로 문자열). */
  outputFields: string[];
  /**
   * 이 지시를 완전히 해석하려면 필요한 잡 컨텍스트 키(TeamInputJobContext 필드명).
   * 예: 마킹은 'opponentRoster'(상대 이름→playerId 해석). 없으면 빌더가 생략/주의 표기.
   */
  contextNeeds: string[];
  /** few-shot 예시(1개 이상). */
  examples: DirectiveExample[];
}

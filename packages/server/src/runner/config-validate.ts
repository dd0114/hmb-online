import { defaultEngineConfig, demoSeed, demoHome, demoAway, demoSelect } from "@hmb/engine";
import type { EngineConfigOverrides } from "@hmb/shared";
import {
  applyOverrides,
  inertIssues,
  knobPaths,
  INERT_KNOBS,
  OverrideError,
  type ChangedKnob,
} from "./config-overlay.js";
import { simulate } from "./simulate.js";

/**
 * 계수 오버레이 **드라이런 검증**(#383) — server-java 의 admin 경로가 값을 원장에 쓰기 **전에**
 * 부른다.
 *
 * <b>왜 필요한가</b>: 이 기능은 배포 게이트를 없앤다. 없앤 게이트를 아무것도 대체하지 않으면 오타
 * 한 번이 **그 이후 생성되는 모든 매치**를 죽인다(진행 중 매치는 스냅샷이 보호하지만 신규는 아니다).
 * 그리고 판정은 <b>엔진을 손에 든 쪽</b>만 할 수 있다 — Java 는 엔진을 돌리지 못한다.
 *
 * <b>무엇을 보지 않는가</b>(중요): 밸런스 밴드(슛 수·골 수·패스 성공률…)는 <b>보지 않는다</b>.
 * 밴드를 맞추는 것이 운영자가 이 기능으로 하려는 일이므로, 여기서 밴드를 강제하면 기능이 자기
 * 목적을 막는다. 여기서 막는 것은 <b>"경기가 성립하지 않는 값"</b> 뿐이다.
 */

/** 스모크 시드 — 데모 픽스처 하나 + 파생 하나. 결정론(시계·난수 없음). */
const SMOKE_SEEDS = [demoSeed, `${demoSeed}-smoke2`];

export interface SmokeResult {
  seed: string;
  ticks: number;
  events: number;
  passEventsHome: number;
  passEventsAway: number;
  ownerChanges: number;
}

export interface ValidateResult {
  effectiveConfigHash: string;
  engineVersion: string;
  changed: ChangedKnob[];
  smoke: SmokeResult[];
}

/** 구조 불변식 위반 — "이 값으로는 경기가 성립하지 않는다". */
export class SmokeError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`configOverrides smoke failed: ${issues.join("; ")}`);
    this.name = "SmokeError";
    this.issues = issues;
  }
}

function smokeOnce(seed: string, overrides: EngineConfigOverrides | undefined): SmokeResult {
  const res = simulate({
    seed,
    selectData: demoSelect,
    homeInput: demoHome,
    awayInput: demoAway,
    half: 1,
    ...(overrides === undefined ? {} : { configOverrides: overrides }),
  });
  const events = res.matchLog.events;
  let passHome = 0;
  let passAway = 0;
  for (const e of events) {
    if (e.type !== "pass") continue;
    if (e.team === "home") passHome++;
    else passAway++;
  }
  // 공 소유자가 바뀐 횟수 — "한 선수가 공을 들고 90분 서 있다"(경기 정지)를 잡는 축이다.
  let changes = 0;
  let prev: string | null | undefined;
  for (const s of res.matchLog.tickSnapshots) {
    if (prev !== undefined && s.ballOwner !== prev) changes++;
    prev = s.ballOwner;
  }
  return {
    seed,
    ticks: res.matchLog.tickSnapshots.length,
    events: events.length,
    passEventsHome: passHome,
    passEventsAway: passAway,
    ownerChanges: changes,
  };
}

/**
 * 오버레이를 실제로 돌려 본다. 경로/타입 문제는 {@link applyOverrides} 가 먼저 던지고
 * (`OverrideError`), 여기서는 <b>돌려 본 결과</b>만 판정한다.
 *
 * <b>여기가 무효 노브(#338)의 유일한 게이트다</b>(독립검증 B2). 이 함수는 <b>작성 시점</b>에만
 * 불린다 — server-java 가 원장에 쓰기 전에 부르는 드라이런이다. 같은 판정을 재생 경로
 * ({@link applyOverrides})에 두면 엔진이 노브를 LIVE→INERT 로 옮기는 순간(0.24.0 이 17개를
 * 한 번에 옮긴 전례가 있다) 그 오버레이를 이미 박아 둔 <b>진행 중 매치가 전부 죽는다</b>.
 * 재생은 과거의 값을 그대로 돌리는 일이고, 그 값이 지금 무효라는 사실은 재생을 막을 이유가
 * 되지 못한다(무효라면 경기가 어차피 동일하다).
 */
export function validateOverrides(overrides: EngineConfigOverrides | undefined): ValidateResult {
  // 무효 노브 먼저 — 스모크를 돌리기 전에 잡는다(어차피 경기가 안 바뀌므로 돌릴 이유도 없다).
  const inert = inertIssues(overrides);
  if (inert.length > 0) throw new OverrideError(inert);

  const { config, hash, changed } = applyOverrides(defaultEngineConfig, overrides);

  const smoke: SmokeResult[] = [];
  const issues: string[] = [];
  for (const seed of SMOKE_SEEDS) {
    let r: SmokeResult;
    try {
      r = smokeOnce(seed, overrides);
    } catch (e) {
      issues.push(`seed=${seed}: 시뮬이 예외로 죽었습니다 — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    smoke.push(r);
    if (r.ticks === 0) issues.push(`seed=${seed}: 틱이 하나도 생성되지 않았습니다`);
    if (r.events === 0) issues.push(`seed=${seed}: 이벤트가 하나도 없습니다(경기가 성립하지 않습니다)`);
    if (r.passEventsHome === 0) issues.push(`seed=${seed}: home 팀 패스가 0건입니다`);
    if (r.passEventsAway === 0) issues.push(`seed=${seed}: away 팀 패스가 0건입니다`);
    if (r.ownerChanges === 0) issues.push(`seed=${seed}: 공 소유자가 한 번도 바뀌지 않았습니다(경기가 멈춰 있습니다)`);
  }
  if (issues.length > 0) throw new SmokeError(issues);

  return { effectiveConfigHash: hash, engineVersion: config.version, changed, smoke };
}

/**
 * 오버레이 가능한 리프 전수 + 현재 기본값 — 운영자가 경로 이름을 **추측하지 않게** 한다.
 *
 * <b>무효 노브(#338)는 `knobs` 에 넣지 않는다</b>(독립검증 B1). 목록에 있으면 운영자는 그것을 고르고,
 * 고르면 200 + diff + 새 지문 + 리비전을 받는데 경기는 한 비트도 안 바뀐다 — 이 기능이 막겠다고
 * 선언한 바로 그 실패 모드다. 대신 `inertKnobs` 로 **왜 못 만지는지와 함께** 따로 보여준다:
 * 목록에서 통째로 지우면 "내가 아는 그 노브가 왜 없지?"가 되어 결국 소스를 뒤지게 된다.
 *
 * ⚠️ <b>`knobs` 에 있다 ≠ 경기가 달라진다</b>(독립검증 M5). 이 필터는 엔진 #338 레지스트리
 * <b>등재분만</b> 걷어낸다 — 독립검증 전수 스윕은 등재 밖에서도 완전 무변화 노브를 15개 더
 * 찾았다(**#393** — QA #25 서브). 러너가 자체 판정하지 않는 이유는 "무효"의 SoT 가 엔진이기 때문이고
 * (러너가 흉내내면 두 진실이 갈라진다), 얕은 섭동으로 판정하면 조건부 LIVE 를 무효로
 * 오분류한다(그 스윕도 2시드에서 의심한 26개 중 9개가 8시드에서 뒤집혔다).
 * 그래서 목록으로 약속하지 않고 <b>{@link CATALOG_CAVEAT} 로 응답에 적어 내보낸다</b>.
 */
export const CATALOG_CAVEAT =
  "이 목록은 **설정 가능한 경로**이지 '값을 바꾸면 경기가 달라지는 경로'가 아니다. 여기서 거르는 " +
  "것은 엔진 #338 레지스트리에 **등재된** 무효 노브뿐이고, 등재 밖에도 실행 경로가 없는 노브가 " +
  "더 있다(#383 M5 → **#393**). 적용 확인은 `changed` diff·새 지문이 아니라 **실제 경기 관측**으로 한다 " +
  "— 이 기능이 인용한 사고(#321·#337·#338)가 전부 '신호는 왔는데 경기는 그대로'였다.";

export function knobCatalog(): {
  engineVersion: string;
  caveat: string;
  knobs: { path: string; type: string; value: number | boolean }[];
  inertKnobs: { path: string; value: number | boolean; reason: string }[];
} {
  const all = [...knobPaths(defaultEngineConfig).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const knobs = all
    .filter(([path]) => !INERT_KNOBS.includes(path))
    .map(([path, k]) => ({ path, type: k.type, value: k.value }));
  const inertKnobs = all
    .filter(([path]) => INERT_KNOBS.includes(path))
    .map(([path, k]) => ({
      path,
      value: k.value,
      reason: "사슬 기본(engine 0.24.0+)에서 실행 경로가 없다 — 바꿔도 경기가 비트 동일하다(#338). "
        + "롤백 스위치 chain.mode=\"weighted\" 의 자산이라 남아 있다.",
    }));
  return { engineVersion: defaultEngineConfig.version, caveat: CATALOG_CAVEAT, knobs, inertKnobs };
}

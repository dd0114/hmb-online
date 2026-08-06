import { GRADE_ORDER, type Grade } from "../common/grades";
import type { CatalogPlayer } from "../api/hooks";

/**
 * 선수(도감) 기본 정렬 — **"획득한 좋은 카드 순"** (#457 D, hero 지시).
 *
 * 그전에는 정렬 코드가 **아예 없었다** — 서버가 준 배열 순(= id 순)이라 방금 뽑은 레전드가
 * 목록 한복판에 묻혔다. 유저가 도감을 여는 이유는 "내 좋은 카드 보기"인데 화면은 그 축을
 * 하나도 반영하지 않고 있었다.
 *
 * ## 사다리 (위에서부터, 앞이 먼저)
 * 1. **보유** — 안 가진 카드가 위에 오면 목록 첫 화면이 통째로 남의 카드다.
 * 2. **등급**(`GRADE_ORDER` 역순) — LEGEND → BRONZE.
 * 3. **성(★)** — 있으면 높은 쪽. *(#458 이 카탈로그에 실어 주면 자동으로 살아난다)*
 * 4. **OVR** — 있으면 높은 쪽. 없으면 `attributes` 평균으로 폴백.
 * 5. **중복 보유 수** — 승급 재료가 쌓인 카드가 위로.
 * 6. **id** — 여기까지 같으면 순서가 흔들리지 않게 고정한다(결정론).
 *
 * ⚠️ **`star`·`ovr` 은 오늘 카탈로그에 없다**(단건 `/api/growth/card/{id}` 에만 있다 — 리스트에서
 * N번 부를 수 없다). 그래서 이 함수는 **필드 부재를 정상 상태로** 다룬다: 없으면 그 단을 건너뛴다.
 * #458(server-java additive)이 랜딩하면 **코드 변경 없이** 3·4단이 켜진다 — 그 날 정렬이 조용히
 * 바뀌는 것이 의도다. 값이 오기 전에 `?? 0` 같은 폴백을 넣지 마라: 0 은 "모른다"가 아니라
 * "최하"라서, 성이 있는 카드와 모르는 카드를 **거꾸로** 세운다.
 */

/** 카탈로그 행 + 아직 서버가 안 주는 additive 필드(#458). 부재가 정상이다. */
export type SortablePlayer = CatalogPlayer & { star?: number | null; ovr?: number | null };

const GRADE_RANK: Record<Grade, number> = GRADE_ORDER.reduce(
  (acc, g, i) => ({ ...acc, [g]: i }),
  {} as Record<Grade, number>,
);

/** 능력치 평균 — OVR 폴백. 숫자가 아닌 값(구 서버·목의 `{}`)은 세지 않는다. */
export function attributeAverage(attributes: unknown): number | null {
  if (!attributes || typeof attributes !== "object") return null;
  const nums = Object.values(attributes as Record<string, unknown>).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** 두 값 중 하나라도 모르면 0(= 이 단을 건너뛴다). 둘 다 알 때만 비교한다. */
function desc(a: number | null | undefined, b: number | null | undefined): number {
  if (typeof a !== "number" || typeof b !== "number") return 0;
  return b - a;
}

function powerOf(p: SortablePlayer): number | null {
  return typeof p.ovr === "number" ? p.ovr : attributeAverage(p.attributes);
}

/** 정렬 비교자 — 위 사다리 그대로. `sortByStrength` 가 유일한 소비자지만 계약이 이걸 직접 태운다. */
export function compareByStrength(a: SortablePlayer, b: SortablePlayer): number {
  if (a.owned !== b.owned) return a.owned ? -1 : 1;
  const grade = GRADE_RANK[b.grade as Grade] - GRADE_RANK[a.grade as Grade];
  if (grade !== 0) return grade;
  const star = desc(a.star, b.star);
  if (star !== 0) return star;
  const power = desc(powerOf(a), powerOf(b));
  if (power !== 0) return power;
  const dup = desc(a.ownedCount, b.ownedCount);
  if (dup !== 0) return dup;
  return a.id.localeCompare(b.id);
}

/** 원본을 건드리지 않는다 — 호출부가 `useMemo` 로 감싸는 파생값이다. */
export function sortByStrength<T extends SortablePlayer>(players: readonly T[]): T[] {
  return [...players].sort(compareByStrength);
}

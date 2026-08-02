/**
 * #406 요구 6 — 선수명 **단일 초크포인트**의 계약.
 *
 * <p>이 파일이 지키는 것 세 가지:
 * <ol>
 *   <li><b>폴백 사다리</b> — 카탈로그 → 호출부가 준 이름 → `미상 선수`. <b>playerId 는 절대 안 나온다.</b></li>
 *   <li><b>카탈로그 우선순위</b> — 과거 매치 스냅샷의 옛 영어 이름을 카탈로그 한글 이름이 이긴다(W0 결정).</li>
 *   <li><b>우회 금지</b> — 화면이 `playersById.get(id)?.name ?? id` 를 다시 선언하지 않는다.</li>
 * </ol>
 *
 * <p>기대값은 **리터럴**로 박는다(`apps/web/CLAUDE.md` "초록으로 거짓말하는 방식" #2 — 앱과 같은
 * 상수를 import 하면 값을 바꿔도 통과한다). `UNKNOWN_PLAYER_NAME` 만은 문구 자체가 아니라
 * "id 가 아니다"가 계약이므로 상수를 쓰되 <b>id 와의 대조</b>로 검사한다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildPlayerNames,
  looksLikePlayerId,
  nameEntryOf,
  playerNameOf,
  UNKNOWN_PLAYER_NAME,
} from "./player-names";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");
const repoRoot = join(here, "..", "..", "..", "..");

/** 서버가 `shortName` 을 주기 **전**(#411 스위치 전) 응답 모양 — 지금 라이브가 이것이다. */
const CATALOG_TODAY = [
  { id: "P001", name: "레프 야신", position: "GK", grade: "LEGEND" },
  { id: "P077", name: "크바라츠헬리아", position: "FW", grade: "DIA" },
];

/** `players.v2.5` 스위치 후 응답 모양 — 같은 코드가 그대로 짧은 이름을 쓰기 시작해야 한다. */
const CATALOG_AFTER_SWITCH = [
  { id: "P001", name: "레프 야신", shortName: "야신", position: "GK", grade: "LEGEND" },
  { id: "P077", name: "크바라츠헬리아", shortName: "크바라츠헬리아", position: "FW", grade: "DIA" },
];

describe("두 축 — 풀네임 / 짧은 이름", () => {
  it("shortName 이 있으면 짧은 축이 그걸 쓴다", () => {
    const names = buildPlayerNames(CATALOG_AFTER_SWITCH);
    expect(names.full("P001")).toBe("레프 야신");
    expect(names.short("P001")).toBe("야신");
  });

  /**
   * ⚠️ 서버가 아직 `shortName` 을 안 준다(#411). 그때 짧은 축이 **비면** 로그줄·토큰이 통째로
   * 빈다 — 배포 순서가 뒤집혀도 화면이 성립해야 한다.
   */
  it("shortName 이 없으면 풀네임으로 폴백한다 (#411 스위치 전 무회귀)", () => {
    const names = buildPlayerNames(CATALOG_TODAY);
    expect(names.short("P001")).toBe("레프 야신");
    expect(names.full("P001")).toBe("레프 야신");
  });

  it("관용적으로 읽는다 — 타입에 없는 shortName 도 실려 오면 쓴다", () => {
    // openapi 생성 타입(`schema.d.ts`)엔 shortName 이 없다. 구조 판정이라야 스위치 날 자동으로 산다.
    expect(nameEntryOf({ name: "레프 야신", shortName: "야신" })).toEqual({
      full: "레프 야신",
      short: "야신",
    });
    expect(nameEntryOf({ name: "레프 야신" })).toEqual({ full: "레프 야신", short: "레프 야신" });
    // 공백만 있는 shortName 은 없는 것으로 — 빈 칸이 이름 행세를 하면 화면이 빈다.
    expect(nameEntryOf({ name: "레프 야신", shortName: "   " })?.short).toBe("레프 야신");
    expect(nameEntryOf({ name: "  " })).toBeNull();
    expect(nameEntryOf(null)).toBeNull();
    expect(nameEntryOf("레프 야신")).toBeNull();
  });
});

describe("폴백 사다리 — playerId 는 화면에 나오지 않는다", () => {
  const names = buildPlayerNames(CATALOG_AFTER_SWITCH);

  it("1단 카탈로그", () => {
    expect(names.resolve("P001", "full")).toEqual({ text: "레프 야신", source: "catalog" });
  });

  it("2단 — 카탈로그가 모르는 선수는 호출부가 준 이름", () => {
    expect(names.resolve("P999", "full", "Old English Name")).toEqual({
      text: "Old English Name",
      source: "given",
    });
  });

  it("3단 — 아무것도 없으면 `미상 선수`. **`P999` 가 아니다**", () => {
    const out = names.resolve("P999", "full");
    expect(out.source).toBe("unknown");
    expect(out.text).toBe(UNKNOWN_PLAYER_NAME);
    expect(out.text).not.toBe("P999");
    expect(out.text).not.toMatch(/^[A-Za-z]{1,2}\d+$/);
  });

  /**
   * ★ 백스톱 — 호출부가 옛 습관(`?? playerId`)대로 id 를 넘겨도 화면에 id 가 새면 안 된다.
   * 8개 파일에서 걷어낸 것이 정확히 그 습관이다.
   */
  it("given 으로 넘어온 id 는 이름 행세를 못 한다", () => {
    expect(names.full("P999", "P999")).toBe(UNKNOWN_PLAYER_NAME);
    expect(names.full("P999", "P077")).toBe(UNKNOWN_PLAYER_NAME); // 남의 id 여도 마찬가지
    expect(names.full("H9", "H9")).toBe(UNKNOWN_PLAYER_NAME); // 엔진 픽스처 id
    expect(names.full("P999", "   ")).toBe(UNKNOWN_PLAYER_NAME);
  });

  it("id 로 읽히는 문자열 판정 — 실제 한글 이름은 걸리지 않는다", () => {
    expect(looksLikePlayerId("P077")).toBe(true);
    expect(looksLikePlayerId("H9")).toBe(true);
    expect(looksLikePlayerId("A11")).toBe(true);
    expect(looksLikePlayerId("레프 야신")).toBe(false);
    expect(looksLikePlayerId("야신")).toBe(false);
  });

  it("빈 카탈로그·이상한 응답에서도 터지지 않는다", () => {
    // `/api/players` 가 배열이 아닐 수 있다(구 서버·목의 `{}`) — 여기서 안 막으면 흰 화면이다.
    for (const rows of [null, undefined, {}, "nope", 7]) {
      const book = buildPlayerNames(rows);
      expect(book.size).toBe(0);
      expect(book.full("P001")).toBe(UNKNOWN_PLAYER_NAME);
    }
  });
});

describe("★ 카탈로그 우선순위 — 과거 매치의 박제된 옛 이름을 덮는다 (W0 결정)", () => {
  /**
   * 라이브 `match_halves.select_data_json` 152/152 에 **영어 이름이 박제**돼 있다. 저장은 고치지
   * 않기로 했고(재현 번들은 스냅샷 불변) 그 결정이 web 쪽에서 뜻하는 바가 이 우선순위다.
   * 표본은 그래서 **스냅샷=영문 / 카탈로그=한글** 로 잡는다.
   */
  const names = buildPlayerNames(CATALOG_AFTER_SWITCH);

  it("카탈로그가 아는 선수면 스냅샷 이름을 무시한다", () => {
    expect(names.resolve("P001", "full", "Lev Yashin")).toEqual({
      text: "레프 야신",
      source: "catalog",
    });
    expect(names.short("P001", "Lev Yashin")).toBe("야신");
  });

  it("카탈로그에 없을 때만 스냅샷으로 떨어진다 — 폴백이 죽어 있지 않다", () => {
    expect(names.resolve("P900", "full", "Retired Guy")).toEqual({
      text: "Retired Guy",
      source: "given",
    });
  });

  it("우선순위가 실제로 무언가를 한다 — 두 값이 다른 표본이다(신선도 가드)", () => {
    expect(names.full("P001")).not.toBe("Lev Yashin");
  });
});

describe("playerNameOf — 행을 이미 손에 든 자리(프레젠테이션 컴포넌트)", () => {
  it("같은 두 축을 쓴다", () => {
    const row = { id: "P001", name: "레프 야신", shortName: "야신" };
    expect(playerNameOf(row, "full")).toBe("레프 야신");
    expect(playerNameOf(row, "short")).toBe("야신");
  });

  it("행이 없으면 사다리 끝 — id 가 아니다", () => {
    expect(playerNameOf(undefined, "short")).toBe(UNKNOWN_PLAYER_NAME);
    expect(playerNameOf(undefined, "short", "P077")).toBe(UNKNOWN_PLAYER_NAME);
    expect(playerNameOf(undefined, "short", "Old Name")).toBe("Old Name");
  });
});

describe("카탈로그 표 만들기", () => {
  it("`playersById` Map 도 같은 표를 만든다 — 훅을 못 쓰는 화면이 우회하지 않게", () => {
    const map = new Map<string, unknown>([
      ["P001", { id: "P001", name: "레프 야신", shortName: "야신" }],
    ]);
    const book = buildPlayerNames(map);
    expect(book.size).toBe(1);
    expect(book.short("P001")).toBe("야신");
    expect(book.full("P002")).toBe(UNKNOWN_PLAYER_NAME);
  });

  it("id 없는 행·이름 없는 행은 표에 안 들어간다", () => {
    const book = buildPlayerNames([
      { id: "P001", name: "레프 야신" },
      { id: "", name: "이름은 있는데 id 가 없다" },
      { id: "P002" },
      null,
    ]);
    expect(book.size).toBe(1);
    expect(book.has("P001")).toBe(true);
    expect(book.has("P002")).toBe(false);
  });

  it("같은 배열이면 같은 표를 돌려준다 — 토큰 18칸이 각자 불러도 한 번만 만든다", () => {
    const rows = [{ id: "P001", name: "레프 야신" }];
    expect(buildPlayerNames(rows)).toBe(buildPlayerNames(rows));
    expect(buildPlayerNames([...rows])).not.toBe(buildPlayerNames(rows));
  });
});

/**
 * ★ **우회 금지** — 초크포인트를 만들어 놓고 화면이 옛 패턴을 다시 선언하면 아무것도 안 바뀐다.
 * 이 검사가 없으면 다음 사람이 새 화면에서 `playersById.get(id)?.name ?? id` 를 그대로 쓴다
 * (이 웨이브 전에 8개 파일이 정확히 그 상태였다).
 */
describe("우회 금지 — 이름 조회는 초크포인트로만", () => {
  /**
   * ⚠️ **정규식 스캐너는 폐기했다 — 그게 blocker 였다.**
   *
   * <p>구 스캐너는 `\.get\([^()]*\)\s*[?!]?\.name` 과 `\?\.name\s*\?\?\s*…[Ii]d` 두 줄이었고,
   * **조회와 이름 추출이 같은 식(式)에 붙어 있을 때만** 반응했다. 독립검증이 프로브 8종으로
   * 경계를 재자 <b>4종이 살아남았다</b> — 그중 하나가 트리에 <b>실재</b>했다
   * (`MailCenter.PlayerChip` 의 `const name = roster.find(…)?.name;` + 다음 줄 `name ?? playerId`.
   * 중첩 괄호 `(p) =>` 때문에 `[^()]*` 가 먼저 죽었고, 두 줄로 갈라져 두 번째 정규식도 못 봤다).
   * 그래서 "위반 0"이 초록이었는데 화면엔 `P077` 이 뜰 수 있었다.
   *
   * <p>정규식을 더 늘리는 대신 <b>표현의 모양이 아니라 표현이 하는 일</b>을 금지한다 —
   * <b>"컬렉션에서 행을 찾아 그 행의 `name` 을 꺼내는 것"</b>과 <b>"이름을 id 로 폴백하는 것"</b>.
   * 판정은 TypeScript AST 라 줄바꿈·구조분해·중첩 괄호·주석에 무감각하다(주석 제거 전처리도
   * 필요 없다 — 파서가 애초에 안 본다).
   *
   * <p>⚠️ <b>삼항은 "무감각"이 아니라 축마다 따로 다룬다 — 한때 여기 그냥 "삼항"이라고 적혀
   * 있었는데 거짓이었다.</b> 면역은 <b>사용부</b>(`p ? p.name : id`, 아래 ②')에만 성립했고
   * <b>선언부</b>(`const p = cond ? m.get(id) : undefined`)에는 성립하지 않았다 — `bare()` 가
   * `ConditionalExpression` 을 안 벗겼기 때문이다. 2차 독립검증의 blocker 가 그 구멍이었고
   * (트리에 3건 실재) 지금은 {@link isRowLookup} 이 선언부 삼항을 따라간다.
   *
   * <p>대가: 조회가 <b>선수 카탈로그가 아닌</b> 컬렉션이어도 걸린다(통화·프리셋·이미 초크포인트를
   * 지난 파생 목록). 그건 버그가 아니라 설계다 — 예외는 {@link EXEMPT} 에 <b>사유와 함께</b> 적어
   * "의도된 예외"로 만든다. 조용한 예외를 허용하는 순간 이 계약은 다시 거짓말을 시작한다.
   *
   * <h3>3차에 넓힌 것 — <b>간접 경유</b>(N1~N8)</h3>
   * 3차 독립검증의 blocker 는 "증상은 죽었는데 <b>스캐너 사각</b>으로 다른 우회가 트리에 남아 있다"
   * 였고, 사각의 정체는 <b>{@link isRowLookup} 이 `const x = <조회>` 형태의 지역변수만 추적</b>한
   * 것이다. 조회 결과가 <b>이름을 한 번 갈아타면</b> 그 뒤는 안 보였다 — 그 구멍으로 같은 형태를
   * <b>두 번</b> 놓쳤고, 세 번째에 트리에서 실물이 나왔다(`PresetPanel` 의
   * `slots.map((s) => ({ slot: s, player: m.get(s.playerId) }))` → `({ slot, player }) => player.name`).
   * 그래서 이제 <b>이름으로 흘러가는 값</b>을 따라간다({@link isRowValue}) —
   * <ul>
   *   <li><b>N1 객체 리터럴 프로퍼티 + 구조분해</b> — `{ player: m.get(id) }` 뒤의 `player.name`
   *       (`x.player.name` 도). <b>이게 실재 우회였다.</b></li>
   *   <li><b>N2 배열 구조분해</b> — `const [, row] = Object.entries(byId).find(…)`</li>
   *   <li><b>N3 `let` 재대입</b> — `let p; … p = m.get(id)`</li>
   *   <li><b>N4 spread 사본</b> — `const p = { ...m.get(id) }`</li>
   *   <li><b>N5 파라미터/구조분해 기본값</b> — `function Row({ player = m.get(id) })`</li>
   *   <li><b>N6 `useMemo` 래핑</b> — React 최빈. 인자 함수의 <b>반환식</b>을 본다</li>
   *   <li><b>N8 프롭 전달</b> — `<Token player={row} />` 로 등록된 이름은 <b>같은 파일 안</b>에서 추적</li>
   *   <li>(덤) <b>별칭 n단</b> — `const a = m.get(id); const b = a; b.name`</li>
   * </ul>
   * ⚠️ 호출 프롬프트가 이름 붙인 축은 N1~N6·N8 이고 <b>N7 은 지목되지 않았다</b> — 번호가 비어
   * 있는 것이지 "빠뜨린 것"이 아니다. 실제로 남은 미탐은 전부 아래에 적는다.
   *
   * <h3>⚠️ 이 스캐너가 <b>안 잡는</b> 형태 — 커버리지를 믿지 마라</h3>
   * 오탐 비용만 적고 미탐을 안 적으면 다음 사람이 "스캔이 초록이니 우회가 없다"고 읽는다.
   * 아래 목록은 <b>알면서 남긴 경계</b>다(전부 잡는 것이 목표가 아니다 — 잡히는 형태를 늘릴수록
   * 오탐 예외표가 커진다). <b>이 목록에 없는 형태를 새로 발견하면 여기에 추가해라.</b>
   * <ul>
   *   <li><b>인덱스 접근</b> — `m[id].name` · `Object.fromEntries(…)[id].name` · `filter(…)[0].name`
   *       (`ElementAccessExpression` 은 조회로 안 본다)</li>
   *   <li><b>조회 메서드 한정</b> — {@link LOOKUP_METHODS} 는 <b>`find`·`get` 둘뿐</b>이다.
   *       `filter`·`flatMap`·`at`·`reduce` 는 안 본다.</li>
   *   <li><b>함수 경계</b> — `const rowOf = (id) => roster.find(…)` 뒤의 `rowOf(id).name`.
   *       반환값을 넘어 추적하지 않는다({@link MEMO_WRAPPERS} 에 적힌 래퍼만 예외).</li>
   *   <li><b>메서드 별칭</b> — `const g = m.get.bind(m); g(id).name`(호출부가 `.get` 이 아니다)</li>
   *   <li><b>`name` 필드 이름 고정</b> — `shortName`·`displayName` 우회는 안 걸린다.</li>
   *   <li><b>id 폴백의 우변이 식이면 놓친다</b> — `?? String(id)` · ``?? `${id}` `` ·
   *       `?? s["playerId"]`. 식별자 이름이 id 로 안 끝나도 마찬가지(`?? key`).</li>
   *   <li><b>순회 자체는 조회가 아니다</b> — `roster.map((p) => <b>{p.name}</b>)`. 콜백 파라미터는
   *       배열 원소에 묶이는 것이라 <b>어느 컬렉션에서 왔는지</b>를 이 스캐너는 모른다.
   *       ⚠️ 한때 여기 *"반복이라 안 걸린다"* 고만 적혀 있었는데 <b>그 문장이 실재 우회를 덮고
   *       있었다</b> — 반복 <b>안에서</b> 조회하는 N1 은 이제 걸린다. 면제되는 것은 "이미 손에 든
   *       배열을 그리는 것"뿐이고, 그건 초크포인트를 지난 파생 목록일 수도 있어 사람이 본다.</li>
   *   <li><b>파일을 넘는 프롭</b> — `<CharAvatar name={p.name} />` 처럼 <b>다른 파일</b>의 부품이
   *       받는 행(예: `TradePlayerCard.player`·`PlayerAvatar.player`)은 그 파일 안에 조회가 없어
   *       안 걸린다. N8 은 <b>같은 파일</b>에서만 성립한다.</li>
   *   <li><b>등록 순서 의존</b> — 이름 전파는 소스 순서 1패스라 `b.name` 을 쓰는 코드가
   *       `const b = a` 보다 <b>위</b>에 있어도 잡히지만, `a` 자체가 나중에 선언되면(호이스팅된
   *       함수 안 등) 그 체인은 끊긴다.</li>
   *   <li><b>스코프를 모른다</b>(반대 방향 비용) — `fromLookup`/`fromName` 은 파일 단위 평면
   *       집합이라 같은 이름의 <b>프롭</b>도 같이 걸린다. `TacticsBoard` 의 `PlayerToken.player`
   *       가 그 예이고, 여기선 마침 고치는 게 맞아 그대로 뒀다. N1/N8 로 넓히며 이 비용이 커졌다 —
   *       그래서 `name` 만은 절대 등록하지 않는다({@link addRow}).</li>
   * </ul>
   * 아래 변이 검증의 <b>음성 대조</b>가 이 목록을 <b>계약으로 고정</b>한다 — 스캐너를 넓히면
   * 그 단언이 <b>먼저 깨지며</b> "경계가 움직였으니 이 목록을 갱신하라"고 알려 준다
   * (3차 확장 때 실제로 그렇게 신호가 왔다: `지역변수 2단 경유` 가 먼저 죽었다).
   */
  const ALLOWED = new Set(["common/player-names.ts", "common/player-names.test.ts"]);

  /**
   * 명시적 예외 — **선수 이름이 아닌 `name`**. 키는 `<파일>::<표현>`, 값은 **사유**다.
   * 새로 추가할 땐 "이 `name` 이 playerId 조인이 아님"을 사유로 적어라(파일 통째 면제가 아니다).
   */
  const EXEMPT = new Map<string, string>([
    [
      "common/currency.ts::found.name",
      "재화 표시명(`/api/config` currencies) — playerId 조인이 아니다(#232).",
    ],
    [
      "deck/PresetPanel.tsx::preset.name",
      "프롬프트 프리셋 이름(유저가 지은 문자열) — 선수 카탈로그와 무관하다.",
    ],
    [
      "match/BriefingPanel.tsx::chosen.name",
      "`myDefenders` 는 카탈로그가 아니라 **이미 초크포인트를 지난** 파생 목록이다" +
        "(`name: names.full(s.playerId)`). 삼항 선언부를 보게 되면서 `myDefenders.find(…)` 가" +
        " 조회로 걸린 오탐 — 이 `name` 은 playerId 조인이 아니다.",
    ],
  ]);

  const LOOKUP_METHODS = new Set(["find", "get"]);
  /** 한 겹 감싸는 React 관용구 — 안쪽 **반환식**을 그대로 조회로 본다(N6). */
  const MEMO_WRAPPERS = new Set(["useMemo"]);
  /** `id` · `playerId` · `s.playerId` — 이름 자리에 흘러들면 화면에 `P077` 이 뜨는 값. */
  const ID_LIKE = /(^|[a-z])[Ii]d$/;

  interface Violation {
    kind: "catalog-name" | "id-fallback";
    line: number;
    text: string;
  }

  /**
   * `(x)` · `x!` · `x as T` 를 벗긴다.
   *
   * <p>⚠️ **삼항은 여기서 벗기지 않는다** — 갈래마다 값이 달라 "하나의 값"으로 축약할 수 없다.
   * 삼항이 필요한 자리는 축마다 따로 처리한다: <b>선언부</b>는 {@link isRowLookup},
   * <b>사용부</b>는 아래 ②'. 여기서 통째로 벗기면 `cond ? x.name : y` 가 "이름 값"으로 읽혀
   * `fromName` 이 오염된다.
   */
  function bare(n: ts.Node): ts.Node {
    let cur = n;
    for (;;) {
      if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      return cur;
    }
  }
  /** 위에 더해 `a ?? b` · `a || b` 의 **왼쪽**(= 원래 얻으려던 값)까지 벗긴다. */
  function bareLeft(n: ts.Node): ts.Node {
    let cur = bare(n);
    while (
      ts.isBinaryExpression(cur) &&
      (cur.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        cur.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      cur = bare(cur.left);
    }
    return cur;
  }
  /** `useMemo(() => X, deps)` 처럼 한 겹 감싼 함수 인자의 **반환식**들(중첩 함수는 안 들어간다). */
  function returnedExprs(fn: ts.Node): ts.Expression[] {
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return [];
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
    const out: ts.Expression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionLike(n)) return; // 안쪽 콜백의 return 은 이 함수의 반환이 아니다
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
    return out;
  }

  /**
   * `xs.find(…)` · `m.get(…)` — 컬렉션에서 행 하나를 꺼내는 호출(옵셔널 체이닝 포함).
   *
   * <p><b>삼항 선언부</b>도 조회로 본다 — `cond ? m.get(id) : undefined` 는 갈래 하나가 조회이므로
   * 그 변수에는 <b>조회 결과가 담길 수 있다</b>. 2차 독립검증의 blocker 가 정확히 이 구멍이었다:
   * `bare()` 가 `ConditionalExpression` 을 안 벗겨서
   * `const selectedPlayer = selection.playerId ? playersById.get(selection.playerId) : undefined`
   * 가 통과했고, 그 다음 줄의 `selectedPlayer.name` 이 <b>트리에 실재</b>했다(`DeckEditor` ·
   * `TacticsBoard`). 증상(`P077`)만 죽고 원인 구조는 모양만 바꿔 살아 있었다.
   *
   * <p>3차에 <b>N4 spread 사본</b>과 <b>N6 `useMemo` 래핑</b>이 여기로 들어왔다 — 값의 <b>모양</b>이
   * 바뀌었을 뿐 담긴 것은 여전히 행이다. 이름을 갈아타는 축(N1·N2·N3·N5·N8)은 {@link isRowValue}.
   */
  function isRowLookup(n: ts.Node): boolean {
    const c = bareLeft(n);
    // 갈래 중 **하나라도** 조회면 조회다. 중첩 삼항도 재귀로 따라간다.
    if (ts.isConditionalExpression(c)) return isRowLookup(c.whenTrue) || isRowLookup(c.whenFalse);
    // N4 — spread 사본(`{ ...m.get(id) }`). 사본에도 `name` 이 그대로 실린다.
    if (ts.isObjectLiteralExpression(c)) {
      return c.properties.some((p) => ts.isSpreadAssignment(p) && isRowLookup(p.expression));
    }
    if (!ts.isCallExpression(c)) return false;
    // N6 — `useMemo(() => m.get(id), [id])`. React 화면에서 제일 흔한 한 겹이다.
    if (ts.isIdentifier(c.expression) && MEMO_WRAPPERS.has(c.expression.text)) {
      return c.arguments.some((a) => returnedExprs(a).some(isRowLookup));
    }
    return ts.isPropertyAccessExpression(c.expression) && LOOKUP_METHODS.has(c.expression.name.text);
  }
  function isNameAccess(n: ts.Node): boolean {
    const c = bare(n);
    return ts.isPropertyAccessExpression(c) && c.name.text === "name";
  }
  function isIdLike(n: ts.Node): boolean {
    const c = bare(n);
    if (ts.isIdentifier(c)) return ID_LIKE.test(c.text);
    if (ts.isPropertyAccessExpression(c)) return ID_LIKE.test(c.name.text);
    return false;
  }

  /**
   * 파일 한 개의 위반 목록. **로컬 변수를 추적**하기 때문에 조회와 추출이 다른 줄에 있어도 잡는다
   * (구 정규식이 놓친 축이 정확히 이것이다).
   */
  function violationsIn(code: string, fileName = "probe.tsx"): Violation[] {
    const sf = ts.createSourceFile(
      fileName,
      code,
      ts.ScriptTarget.Latest,
      true,
      /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const fromLookup = new Set<string>(); // 행 조회 결과를 담은 지역변수
    const fromName = new Set<string>(); // `.name` 을 담은 지역변수
    const hits: Violation[] = [];
    const push = (kind: Violation["kind"], n: ts.Node) =>
      hits.push({
        kind,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        text: n.getText(sf).replace(/\s+/g, " ").slice(0, 110),
      });

    /**
     * **행이 담긴 값**인가 — 조회식 그 자체이거나, 조회 결과가 흘러든 이름이다.
     *
     * <p>이름이 파일 단위 평면 집합(`fromLookup`)이라 <b>별칭 한 겹</b>(`const b = a`)과
     * <b>프로퍼티 경유</b>(`x.player.name`)가 같이 따라온다 — 그게 N1/N8 을 잡는 방식이다.
     */
    const isRowValue = (n: ts.Node): boolean => {
      const c = bareLeft(n);
      if (ts.isConditionalExpression(c)) return isRowValue(c.whenTrue) || isRowValue(c.whenFalse);
      if (ts.isIdentifier(c)) return fromLookup.has(c.text);
      if (ts.isPropertyAccessExpression(c) && fromLookup.has(c.name.text)) return true;
      return isRowLookup(c);
    };

    /**
     * ⚠️ `name` 자체는 절대 행 이름으로 등록하지 않는다 — `{ name: player }` 한 줄이 파일 안의
     * <b>모든</b> `.name` 을 위반으로 만들어(평면 집합) 스캐너가 통째로 쓸모없어진다.
     */
    const addRow = (text: string): void => {
      if (text !== "name") fromLookup.add(text);
    };

    /** 이름 하나에 값을 묶는다 — 선언·재대입·파라미터 기본값이 전부 여기로 들어온다. */
    const bind = (name: ts.Node, init: ts.Expression): void => {
      if (isRowValue(init)) {
        if (ts.isIdentifier(name)) addRow(name.text);
        else if (ts.isObjectBindingPattern(name)) {
          // `const { name } = map.get(id) ?? { name: id }`
          for (const el of name.elements) {
            const prop = el.propertyName ?? el.name;
            if (ts.isIdentifier(prop) && prop.text === "name") push("catalog-name", el);
          }
        } else if (ts.isArrayBindingPattern(name)) {
          // N2 — `const [, row] = Object.entries(byId).find(…)`: 어느 원소가 행인지 모르므로 전부 본다.
          for (const el of name.elements) {
            if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
            if (el.name.text === "name") push("catalog-name", el);
            else addRow(el.name.text);
          }
        }
      }
      if (ts.isIdentifier(name) && isNameAccess(bareLeft(init))) fromName.add(name.text);
    };

    const collect = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer) bind(n.name, n.initializer);
      // N5 — 파라미터 기본값 · 구조분해 기본값(`function F({ player = m.get(id) })`)
      if (ts.isParameter(n) && n.initializer) bind(n.name, n.initializer);
      if (ts.isBindingElement(n) && n.initializer) bind(n.name, n.initializer);
      // N3 — `let p; … p = m.get(id)`
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left)
      ) {
        bind(n.left, n.right);
      }
      // N1 — 객체 리터럴 프로퍼티. `slots.map((s) => ({ slot: s, player: m.get(s.playerId) }))` 처럼
      // 조회가 **반복 안**에서 일어나고 소비는 구조분해로 갈라지는 형태가 여기로 걸린다(실재 우회).
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && isRowValue(n.initializer)) {
        addRow(n.name.text);
      }
      // N8 — 프롭 전달. `<PlayerToken player={m.get(id)} />` 뒤의 자식 부품은 다른 파일이라
      // 못 따라가지만, **같은 파일 안**의 소비는 이름으로 이어진다.
      if (
        ts.isJsxAttribute(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        ts.isJsxExpression(n.initializer) &&
        n.initializer.expression &&
        isRowValue(n.initializer.expression)
      ) {
        fromLookup.add(n.name.text);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);

    const isNameValue = (n: ts.Node): boolean => {
      const c = bare(n);
      return isNameAccess(c) || (ts.isIdentifier(c) && fromName.has(c.text));
    };

    const check = (n: ts.Node): void => {
      // ① 컬렉션에서 찾은 행의 이름을 직접 꺼낸다 (한 식이든, 이름 여러 겹을 거치든)
      if (ts.isPropertyAccessExpression(n) && n.name.text === "name") {
        if (isRowValue(n.expression)) push("catalog-name", n);
      }
      // ② 이름 → id 폴백 (`??`/`||`)
      if (
        ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          n.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        isNameValue(n.left) &&
        isIdLike(n.right)
      ) {
        push("id-fallback", n);
      }
      // ②' 같은 폴백의 삼항 표기 (`p ? p.name : id`)
      if (
        ts.isConditionalExpression(n) &&
        ((isNameValue(n.whenTrue) && isIdLike(n.whenFalse)) ||
          (isIdLike(n.whenTrue) && isNameValue(n.whenFalse)))
      ) {
        push("id-fallback", n);
      }
      ts.forEachChild(n, check);
    };
    check(sf);
    return hits;
  }

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  const files = walk(srcDir)
    .map((f) => [f.slice(srcDir.length + 1).replace(/\\/g, "/"), f] as const)
    .filter(([rel]) => !ALLOWED.has(rel));

  /** 전 파일 스캔 — 예외표에 사유가 적힌 것만 뺀다. */
  function offenders(kind?: Violation["kind"]): string[] {
    const out: string[] = [];
    for (const [rel, abs] of files) {
      for (const v of violationsIn(readFileSync(abs, "utf8"), abs)) {
        if (kind && v.kind !== kind) continue;
        if (EXEMPT.has(`${rel}::${v.text}`)) continue;
        out.push(`${rel}:${v.line} [${v.kind}] ${v.text}`);
      }
    }
    return out;
  }

  it("카탈로그 행에서 이름을 직접 꺼내는 화면이 없다", () => {
    expect(offenders("catalog-name"), "이름은 usePlayerNames()/buildPlayerNames()/playerNameOf() 로만").toEqual(
      [],
    );
  });

  it("`이름 ?? <id>` 폴백이 남아 있지 않다 — 그게 화면에 P077 을 띄운 패턴이다", () => {
    expect(offenders("id-fallback"), "폴백 사다리는 player-names 한 곳").toEqual([]);
  });

  /**
   * ★ **변이 검증 — 경계를 넘겨서 잰다.**
   *
   * <p>구 계약의 실패 원인은 "변이가 없어서"가 아니라 <b>변이가 전부 잡히는 형태였기 때문</b>이다.
   * 이 실수를 <b>두 번</b> 반복했다 — 1차는 정규식 시절 인접 6개, 2차는 AST 시절 "새 스캐너가
   * 잡는 15종". 두 번 다 스스로 통과했고 두 번 다 독립검증이 밖에서 태워 잡았다.
   * 그래서 여기엔 <b>구 스캐너가 실제로 놓쳤던 형태</b>를 양성 대조로 넣는다 — 이 목록에서
   * 하나라도 MISS 가 나면 스캐너를 고친 게 아니라 옮긴 것이다.
   */
  it("스캐너가 실제로 그 패턴을 잡는다 (변이 검증 — 구 스캐너 생존 형태 포함)", () => {
    const caught = (code: string) => violationsIn(code).map((v) => v.kind);

    // ── 구 정규식이 놓쳤던 4형태(독립검증 프로브) ─────────────────────────────
    // ⓐ 두 줄 분리 — MailCenter.PlayerChip 의 실제 모양이었다.
    expect(
      caught("const n = roster.find((p) => p.id === playerId)?.name;\nreturn <>{n ?? playerId}</>;"),
      "두 줄로 갈라진 조회→추출",
    ).toContain("catalog-name");
    // ⓑ 구조분해 + 기본값
    expect(caught("const { name } = map.get(id) ?? { name: id };\nreturn <>{name}</>;"), "구조분해").toContain(
      "catalog-name",
    );
    // ⓒ·ⓓ 삼항 (find / get)
    expect(
      caught("const p = roster.find((x) => x.id === id);\nreturn p ? p.name : id;"),
      "삼항 + find",
    ).toContain("catalog-name");
    expect(caught("const row = map.get(id);\nreturn row ? row.name : id;"), "삼항 + get").toContain(
      "catalog-name",
    );

    // ── 2차 독립검증 blocker — **삼항 선언부**(트리에 실재했다) ───────────────
    // 위 ⓒ·ⓓ 는 *사용부* 삼항이라 통과했었다. 조회가 삼항 **안**에 있는 이 형태가 구멍이었다.
    expect(
      caught("const p = cond ? playersById.get(id) : undefined;\nreturn <>{p.name}</>;"),
      "삼항 선언부 (DeckEditor.selectedPlayer 의 실제 모양)",
    ).toContain("catalog-name");
    expect(
      caught("const p = slot ? m.get(slot.playerId) : undefined;\nreturn <b>{`${p.name} 편집 중`}</b>;"),
      "삼항 선언부 + 템플릿 리터럴",
    ).toContain("catalog-name");
    expect(
      caught("const p = a ? undefined : roster.find((x) => x.id === id);\nreturn <>{p.name}</>;"),
      "삼항 선언부 — 조회가 else 갈래",
    ).toContain("catalog-name");
    expect(
      caught("const p = a ? (b ? m.get(id) : undefined) : undefined;\nreturn <>{p.name}</>;"),
      "중첩 삼항 선언부",
    ).toContain("catalog-name");

    // ── 3차 blocker — **간접 경유 N1~N8**(N1 은 트리에 실재했다) ──────────────
    // N1: 조회가 **반복 안**에서 일어나고 소비는 구조분해로 갈라진다 = PresetPanel 의 실제 모양.
    expect(
      caught(
        "const rows = draft.slots.map((s) => ({ slot: s, player: playersById.get(s.playerId) }));\n" +
          "return <>{rows.map(({ slot, player }) => <b key={slot.playerId}>{player.name}</b>)}</>;",
      ),
      "N1 객체리터럴 프로퍼티 + 구조분해 (PresetPanel.deckPlayers 의 실제 모양)",
    ).toContain("catalog-name");
    expect(
      caught("const o = { player: m.get(id) };\nreturn <>{o.player.name}</>;"),
      "N1' 프로퍼티 경유 접근",
    ).toContain("catalog-name");
    expect(
      caught("const [, row] = Object.entries(byId).find(([k]) => k === id) ?? [];\nreturn <>{row.name}</>;"),
      "N2 배열 구조분해",
    ).toContain("catalog-name");
    expect(
      caught("let p;\nif (cond) p = playersById.get(id);\nreturn <>{p.name}</>;"),
      "N3 let 재대입",
    ).toContain("catalog-name");
    expect(caught("const p = { ...m.get(id) };\nreturn <>{p.name}</>;"), "N4 spread 사본").toContain(
      "catalog-name",
    );
    expect(
      caught("function Row({ player = playersById.get(id) }) {\n  return <>{player.name}</>;\n}"),
      "N5 구조분해 기본값",
    ).toContain("catalog-name");
    expect(
      caught("const f = (p = roster.find((x) => x.id === id)) => p.name;"),
      "N5' 파라미터 기본값",
    ).toContain("catalog-name");
    expect(
      caught("const p = useMemo(() => playersById.get(id), [id]);\nreturn <>{p.name}</>;"),
      "N6 useMemo 래핑 (React 최빈)",
    ).toContain("catalog-name");
    expect(
      caught(
        "const p = useMemo(() => {\n  if (!id) return undefined;\n  return playersById.get(id);\n}, [id]);\n" +
          "return <>{p.name}</>;",
      ),
      "N6' useMemo 블록 바디",
    ).toContain("catalog-name");
    expect(
      caught(
        "function Token({ player }) {\n  return <>{player.name}</>;\n}\n" +
          "const row = playersById.get(id);\nconst el = <Token player={row} />;",
      ),
      "N8 프롭 전달 (같은 파일)",
    ).toContain("catalog-name");
    expect(
      caught("const a = map.get(id);\nconst b = a;\nreturn <>{b.name}</>;"),
      "별칭 n단 — 3차 확장으로 음성 대조에서 넘어왔다",
    ).toContain("catalog-name");

    // ── 구 스캐너도 잡던 6형태(회귀 방지) ────────────────────────────────────
    expect(caught("playersById.get(s.playerId)?.name ?? s.playerId")).toContain("catalog-name");
    expect(caught("const x = playersById.get(errorPlayerId)!.name;")).toContain("catalog-name");
    expect(caught("const nameOf = (id: string) => playersById.get(id)?.name ?? id;")).toContain("catalog-name");
    expect(caught("<>{player?.name ?? playerId}</>"), "프롭에서 온 행이어도 id 폴백은 금지").toContain(
      "id-fallback",
    );
    expect(caught("const o = { label: p?.name ?? id };")).toContain("id-fallback");
    expect(caught("<>{playersById.get(playerId)?.name ?? playerId}</>")).toContain("catalog-name");

    // ── 오탐 대조 — 초크포인트를 쓰는 정상 코드·다른 필드는 안 걸린다 ─────────
    for (const clean of [
      "const names = usePlayerNames();\nreturn <>{names.short(playerId)}</>;",
      "names.full(scorer.playerId, scorer.name)",
      "playersById.get(id)?.position",
      "<>{props.name}</>",
      "const t = notices.find((x) => x.id === id)?.title ?? id;",
    ]) {
      expect(caught(clean), clean).toEqual([]);
    }
  });

  /**
   * ★ <b>음성 대조 — 안 잡히는 형태를 계약으로 고정한다.</b>
   *
   * <p>이 세션은 같은 실수를 두 번 했다: 자체 변이 검증에 <b>잡히는 형태만</b> 넣어 스스로를
   * 통과시켰고, 두 번 다 독립검증이 밖에서 태워 미탐을 찾았다(2차 = 24종 중 <b>13종 MISS</b>).
   * 그래서 <b>안 잡힌다는 사실 자체</b>를 단언한다 — 목록은 위 머리말 "이 스캐너가 안 잡는 형태".
   *
   * <p>이건 "이래도 된다"는 승인이 아니라 <b>경계 표시</b>다. 두 가지를 한다:
   * <ol>
   *   <li>다음 사람이 이 스캐너의 커버리지를 <b>과신하지 않게</b> 한다 — 초록은 "우회 0"이 아니라
   *       "<b>이 형태의</b> 우회 0"이다. 새 화면 리뷰는 여전히 사람이 한다.</li>
   *   <li>스캐너를 넓히면 <b>여기가 먼저 깨진다</b> → 경계가 움직였으니 머리말 목록과 이 단언을
   *       같이 갱신하라는 신호. 조용히 넓어지면 예외표만 늘고 아무도 이유를 모른다.</li>
   * </ol>
   */
  it("경계 — 이 형태들은 **안 잡힌다**(음성 대조, 미탐 목록 = 머리말)", () => {
    const caught = (code: string) => violationsIn(code).map((v) => v.kind);
    const missed: Array<[string, string]> = [
      ["인덱스 접근", "return <>{byId[playerId].name}</>;"],
      ["filter(…)[0]", "return <>{roster.filter((p) => p.id === playerId)[0].name}</>;"],
      [
        "Object.fromEntries + 인덱스",
        "const byId = Object.fromEntries(rows.map((r) => [r.id, r]));\nreturn <>{byId[playerId].name}</>;",
      ],
      [
        "헬퍼 1겹 감싸기",
        "const rowOf = (id) => roster.find((p) => p.id === id);\nreturn <>{rowOf(playerId).name}</>;",
      ],
      ["get 별칭 변수", "const g = map.get.bind(map);\nconst p = g(id);\nreturn <>{p.name}</>;"],
      ["shortName 필드 우회", "return <>{playersById.get(id)?.shortName ?? id}</>;"],
      ["?? String(id)", "return <>{p?.name ?? String(playerId)}</>;"],
      ["?? `${id}`", "return <>{p?.name ?? `${playerId}`}</>;"],
      ["?? key (id 로 안 끝나는 식별자)", "return <>{p?.name ?? key}</>;"],
      ["?? s[\"playerId\"] (인덱스 우변)", 'return <>{p?.name ?? s["playerId"]}</>;'],
      // ⚠️ 면제 사유가 **"반복이라 조회가 아니다"가 아니다** — 반복 안에서 조회하는 N1 은 위
      // 양성 대조에서 잡힌다. 여기서 안 걸리는 건 "이미 손에 든 배열을 그리는 것"뿐이다.
      [".map 순회 렌더(조회 없음)", "return <>{roster.map((p) => <b key={p.id}>{p.name}</b>)}</>;"],
      // 파일을 넘는 프롭 — 받는 쪽 파일에 조회가 없다(`TradePlayerCard.player` 가 그 모양).
      ["다른 파일에서 온 프롭", "function Card({ player }) {\n  return <>{player.name}</>;\n}"],
    ];
    for (const [label, code] of missed) {
      expect(caught(code), `미탐 목록에 적힌 형태다 — 잡히기 시작했으면 머리말을 갱신해라: ${label}`).toEqual(
        [],
      );
    }
    // 목록이 통째로 비거나 줄어드는 방향(= 경계 계약이 조용히 사라지는 것)도 막는다.
    expect(missed.length, "머리말 미탐 목록과 같이 움직인다").toBeGreaterThanOrEqual(10);
  });

  /**
   * 예외표가 **살아 있는 사유**인지 확인한다 — 사라진 코드에 대한 면제가 남으면, 다음 사람이
   * 그 파일에 진짜 위반을 적었을 때 조용히 통과할 수 있다.
   */
  it("명시적 예외는 전부 실재하고 사유가 적혀 있다", () => {
    const seen = new Set<string>();
    for (const [rel, abs] of files) {
      for (const v of violationsIn(readFileSync(abs, "utf8"), abs)) seen.add(`${rel}::${v.text}`);
    }
    for (const [key, reason] of EXEMPT) {
      expect(seen.has(key), `예외가 코드에 없다(지워라): ${key}`).toBe(true);
      expect(reason.length, `사유 없는 예외: ${key}`).toBeGreaterThan(10);
    }
  });

  it("창구를 실제로 쓰는 화면이 여럿이다 — 만들어만 두고 아무도 안 쓰는 상태가 아니다", () => {
    // 여기만 주석을 지운다 — 창구 **이름을 언급한** 설명 문장이 소비처로 집계되면 안 된다
    // (위 위반 스캔은 AST 라 주석을 애초에 안 본다).
    const codeOf = (path: string) =>
      readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    // 창구는 셋이다: 훅(`usePlayerNames`) · 순수 빌더(`buildPlayerNames`) · 행 직접(`playerNameOf`).
    // 셋 다 같은 사다리·같은 두 축을 쓴다 — 화면 사정에 따라 진입점만 다르다.
    const users = files
      .filter(([, abs]) => /\b(usePlayerNames|buildPlayerNames|playerNameOf)\s*\(/.test(codeOf(abs)))
      .map(([rel]) => rel)
      .filter((rel) => !rel.endsWith(".test.ts"))
      .sort();
    expect(users.length, `창구 소비처: ${users.join(", ")}`).toBeGreaterThanOrEqual(8);
    // 훅 경로가 죽어 있지 않다(화면이 카탈로그를 실제로 구독한다).
    expect(users.filter((r) => /LogPanel|BriefingPanel|HalftimePanel/.test(r)).length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * 발행물과의 정합 — 계약이 공허하지 않다. `shortName` 축이 **실제로 짧다**는 것,
 * 그리고 밀집 UI 가 견뎌야 할 길이 상한이 무엇인지를 데이터에서 확인한다.
 */
describe("발행물 정합 (data/players 최신 시드)", () => {
  const seedFile = readdirSync(join(repoRoot, "data", "players"))
    .filter((f) => /^players\.v[\d.]+\.json$/.test(f))
    .sort((a, b) => {
      const num = (f: string) => f.slice(9, -5).split(".").map(Number);
      const [x, y] = [num(a), num(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      }
      return 0;
    })
    .pop()!;
  const seed = JSON.parse(
    readFileSync(join(repoRoot, "data", "players", seedFile), "utf8"),
  ) as Array<Record<string, unknown>>;

  it("최신 시드는 한글 이름 + shortName 을 싣는다", () => {
    const book = buildPlayerNames(seed);
    expect(book.size).toBeGreaterThan(150);
    const withShort = seed.filter((p) => typeof p.shortName === "string" && p.shortName !== p.name);
    expect(withShort.length, "짧은 축이 실제로 다른 값인 선수").toBeGreaterThan(100);
  });

  it("짧은 이름 길이 분포가 밀집 UI 가정 안에 있다 (1~7자)", () => {
    const book = buildPlayerNames(seed);
    const lengths = seed.map((p) => book.short(String(p.id)).length);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...lengths), "8자 이상이 생기면 로그줄 폭 계약을 다시 재라").toBeLessThanOrEqual(7);
    // 풀네임은 더 길다 = 두 축을 나눈 이유가 데이터에 실재한다.
    expect(Math.max(...seed.map((p) => book.full(String(p.id)).length))).toBeGreaterThan(
      Math.max(...lengths),
    );
  });
});

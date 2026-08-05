/**
 * 스태틱 모드 판정 (#444) — "백엔드가 없는 빌드"인가.
 *
 * <b>왜 필요한가</b>: 제출 요건 1 은 GitHub Pages 에서 **바로 플레이되는 빌드**다. Pages 는 정적
 * 호스팅이라 `/api` 를 받아 줄 서버가 없다. 그래서 이 빌드는 `apiFetch` 안에서 네트워크 대신
 * **브라우저 안의 목 백엔드**(`src/static/router.ts`)로 간다 — 화면·훅·뷰어는 한 줄도 안 바뀐다.
 *
 * <b>라이브 빌드 영향 0</b>: 플래그가 꺼져 있으면 `isStaticMode()` 는 상수 false 로 접히고,
 * 목 백엔드 모듈은 **동적 import** 라 번들에 들어가지도 않는다(계약 = `static-mode.test.ts`).
 */

/** 빌드 플래그. `VITE_STATIC_MODE=1` 로 구운 산출물만 스태틱이다. */
function buildFlag(): boolean {
  const raw: unknown = import.meta.env?.VITE_STATIC_MODE;
  return raw === "1" || raw === "true";
}

/**
 * 빌드 타임에 vite `define` 이 꽂아 넣는 리터럴(`vite.config.ts`). 번들러 밖(Node)에는 없다.
 */
declare const __HMB_STATIC_BUILD__: boolean;

/**
 * ⚠️ **컴파일 타임 상수**여야 한다 — 목 백엔드를 부르는 `import()` 를 이 상수로 감싸면, 플래그가
 * 없는 라이브 프로덕션 빌드에서 그 가지가 **죽은 코드**가 되어 rollup 이 청크 자체를 지운다.
 * `isStaticMode()`(런타임 함수)로 감싸면 청크가 **실려는 나가고 안 쓰일 뿐**이다(실측 157 kB).
 * dev 는 `?static=1` 스위치를 살려야 하므로 `import.meta.env.DEV` 를 같이 연다.
 */
export const STATIC_BUILD_ENABLED: boolean =
  // `typeof` 가드는 **접힘을 깨지 않는다**(치환 후 `typeof false` 는 rollup 이 접는다) —
  // 그리고 Node 에서 이 파일을 import 하는 경로를 살린다: playwright e2e 가 `char-assets-store`
  // → `client.ts` → 여기까지 타고 들어오는데 거기엔 정의가 없다.
  // ⚠️ `import.meta.env.DEV` 를 직접 쓰면 그 Node 경로가 통째로 죽고(실측 TypeError),
  //    `import.meta.env?.DEV` 로 바꾸면 이번엔 **접힘이 깨져** 청크가 실려 나간다(실측 157 kB).
  //    둘 다 만족하는 형태가 이 define 이다.
  typeof __HMB_STATIC_BUILD__ === "undefined" ? false : __HMB_STATIC_BUILD__;

/**
 * dev 편의 스위치. `?static=1` 로 켜고 `?static=0` 으로 끈다(localStorage 에 남는다).
 * ⚠️ **빌드 플래그가 켜져 있으면 끌 수 없다** — Pages 산출물에서 스태틱을 끄면 존재하지 않는
 * 백엔드로 요청이 나가 앱이 통째로 죽는다.
 */
const OVERRIDE_KEY = "hmb.static.mode";

function readOverride(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const param = new URLSearchParams(window.location.search).get("static");
    if (param === "1" || param === "0") {
      window.localStorage.setItem(OVERRIDE_KEY, param);
      return param === "1";
    }
    const stored = window.localStorage.getItem(OVERRIDE_KEY);
    if (stored === "1" || stored === "0") return stored === "1";
  } catch {
    // 프라이빗 모드 등에서 localStorage 가 던진다 — 판정은 빌드 플래그로 폴백한다.
  }
  return null;
}

let cached: boolean | null = null;

/** 이 실행이 스태틱 모드인가. 부팅 1회 판정 후 고정(중간에 바뀌면 캐시가 갈린다). */
export function isStaticMode(): boolean {
  if (cached === null) cached = STATIC_BUILD_ENABLED && (buildFlag() || readOverride() === true);
  return cached;
}

/** 테스트 전용 — 모듈 캐시 리셋. */
export function __resetStaticMode(): void {
  cached = null;
}

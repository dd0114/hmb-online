import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 모달 층위 계약 (#457 C2).
 *
 * **왜 소스 스캔인가.** hero 제보(*"뽑고 나면 확인버튼이 안보여. 하단 바에 가려져"*)의 원인은
 * 연출이 아니라 **스태킹 순서**였다: 하단 탭바가 `z-index: 20` 인데 뽑기 결과 오버레이가
 * `z-index: 10` 이라 **모달이 네비 아래**로 깔렸다(`common/Modal` 은 포털이 아니라 인라인 렌더라
 * 부모 스태킹이 그대로 걸린다). 같은 상태의 오버레이가 그때 **5개**였다 — 즉 화면 하나를 고치면
 * 나머지 넷이 남는 **부류의 결함**이라 계약도 화면이 아니라 **규칙**에 건다.
 *
 * ⚠️ e2e 로만 잡으려 하지 마라 — 오버레이 5개마다 실화면 스펙을 세우는 비용이고, 새로 추가되는
 * 여섯 번째 오버레이는 **아무도 검사하지 않는다**. 여기서는 "전화면 오버레이는 예외 없이 네비보다
 * 위"만 본다. 실제로 눌리는지(가림·히트테스트)는 `e2e/p457-metaux.spec.ts` 가 좌표로 잰다.
 *
 * ⚠️ 이 계약은 **값이 아니라 관계**를 본다(`--z-modal` > `--z-nav`). 숫자를 박으면 토큰을
 * 조정하는 날 거짓 실패가 된다.
 */

const SRC = new URL("..", import.meta.url).pathname;

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFiles(full));
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out;
}

const ROOT_CSS = readFileSync(join(SRC, "index.css"), "utf8");

/** `:root` 의 토큰 값(숫자만). 없으면 undefined — 그 자체가 계약 위반이다. */
function token(name: string): number | undefined {
  const m = ROOT_CSS.match(new RegExp(`--${name}\\s*:\\s*(-?\\d+)\\s*;`));
  return m ? Number(m[1]) : undefined;
}

/** `z-index: 30` · `z-index: var(--z-modal)` 둘 다 숫자로 만든다. 못 풀면 null. */
function resolveZ(value: string): number | null {
  const raw = value.trim();
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return asNumber;
  const varName = raw.match(/^var\(\s*--([\w-]+)\s*\)$/);
  if (!varName) return null;
  return token(varName[1]!) ?? null;
}

interface Layer {
  file: string;
  selector: string;
  z: string | null;
}

/**
 * **오버레이가 아닌 전화면 고정 블록** — 예외는 사유와 함께 적는다(조용한 예외 금지, 루트 규율).
 * 아래 "예외는 전부 실재한다" 검사가 낡은 항목을 잡는다.
 */
const EXEMPT: Record<string, string> = {
  "match/stage/StageShell.module.css .shell":
    "관전 셸 = 페이지 컨테이너(문서 스크롤 0). 그 위에 뜨는 모달은 자기 z 를 갖는다",
  "qa/QaConsolePage.module.css .root": "QA 콘솔 셸 — 제품 화면이 아니고 네비도 없다",
};

/**
 * "전화면 오버레이" = `position: fixed` + 네 변을 모두 덮는 블록(`inset: 0` 또는 top/right/bottom/left).
 * 하단 탭바(`left/right/bottom` 만)는 여기 안 걸린다 — 네비는 검사 **대상이 아니라 기준**이다.
 *
 * 최내곽 블록만 본다(`{...}` 안에 중괄호가 없는 것) — 선언은 거기 산다.
 */
function fullScreenLayers(): Layer[] {
  const layers: Layer[] = [];
  for (const file of cssFiles(SRC)) {
    // 주석을 먼저 걷는다 — 안 그러면 셀렉터에 문단이 통째로 붙어 예외 키가 성립하지 않는다.
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const selector = m[1]!.replace(/\s+/g, " ").trim();
      const body = m[2]!;
      if (!/position\s*:\s*fixed/.test(body)) continue;
      const insetAll =
        /inset\s*:\s*0/.test(body) ||
        (/(^|[;{])\s*top\s*:/.test(body) &&
          /(^|[;{])\s*right\s*:/.test(body) &&
          /(^|[;{])\s*bottom\s*:/.test(body) &&
          /(^|[;{])\s*left\s*:/.test(body));
      if (!insetAll) continue;
      const z = body.match(/z-index\s*:\s*([^;]+);/);
      layers.push({
        file: file.slice(SRC.length),
        selector,
        z: z ? z[1]!.trim() : null,
      });
    }
  }
  return layers;
}

describe("모달 층위 토큰 (#457 C2)", () => {
  it("토큰이 있고 모달이 네비보다 위다", () => {
    const nav = token("z-nav");
    const modal = token("z-modal");
    expect(nav, "--z-nav 가 :root 에 없다").toBeTypeOf("number");
    expect(modal, "--z-modal 이 :root 에 없다").toBeTypeOf("number");
    expect(modal!).toBeGreaterThan(nav!);
  });

  it("하단 탭바·사이드바는 토큰을 쓴다 — 숫자를 다시 적으면 층위가 두 곳에서 정해진다", () => {
    const nav = readFileSync(join(SRC, "common/AppNav.module.css"), "utf8");
    const zDecls = [...nav.matchAll(/z-index\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(zDecls.length, "AppNav 에 z-index 선언이 없다").toBeGreaterThan(0);
    for (const decl of zDecls) expect(decl).toBe("var(--z-nav)");
  });

  it("전화면 오버레이는 예외 없이 네비 위에 있다", () => {
    const nav = token("z-nav");
    // ⚠️ 토큰이 없으면 비교가 통째로 무의미해진다(`10 <= undefined` 는 false 라 **전부 통과**한다).
    //    실제로 처음 이 계약이 그 상태였고, 위반 5건을 조용히 초록으로 넘겼다.
    expect(nav, "--z-nav 없이는 이 검사가 공허하다").toBeTypeOf("number");
    const offenders = fullScreenLayers()
      .filter((l) => !(`${l.file} ${l.selector}` in EXEMPT))
      .filter((l) => {
        const z = l.z === null ? null : resolveZ(l.z);
        return z === null || z <= nav!;
      });
    expect(
      offenders.map((o) => `${o.file} {${o.selector}} z-index:${o.z ?? "없음"}`),
      "전화면 오버레이가 네비(z-nav) 아래이거나 z-index 가 없다 — 하단 탭바에 가려진다",
    ).toEqual([]);
  });

  it("예외는 전부 실재한다 — 낡은 면제가 조용히 남지 않게", () => {
    const keys = new Set(fullScreenLayers().map((l) => `${l.file} ${l.selector}`));
    for (const key of Object.keys(EXEMPT)) expect(keys.has(key), `${key} 가 없다`).toBe(true);
  });
});

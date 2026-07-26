// 뷰어 코어(@hmb/viewer-core)를 index.html 에 인라인하기 위한 공용 헬퍼.
// standalone(build-standalone) 과 e2e 테스트 뷰어(build-test-viewer) 가 같은 방식으로 소비한다.
//
// 방식: 코어 .mjs 들을 텍스트로 읽어 `export`/`import` 를 제거해 **전역 클래식 스크립트**로 만든다
// (file:// 는 외부 모듈 fetch 불가). index.html 의 모듈 스크립트는 이 전역들을 참조한다.
// 인라인 순서 = 의존 먼저: playback → stats → log-lines → viewer(playback·stats 참조).
// 런타임 .mjs 는 `.impl.mjs`(타입 래퍼 .ts 와 basename 충돌 방지 — vite 가 확장자없는 import 를
// .mjs>.ts 순으로 잡아 .ts 래퍼 대신 런타임을 집는 문제를 이름 분리로 차단).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // packages/engine/dev-viewer
const coreDir = join(here, "..", "..", "viewer-core", "src");

// export 프리픽스 + 단일행 import 문 제거 → 전역 함수/상수만 남는다.
function toGlobal(src) {
  return src.replace(/^export\s+/gm, "").replace(/^\s*import\b[^\n]*\n/gm, "");
}

/** 코어 모듈들을 의존 순서로 읽어 전역화한 소스(하나의 클래식 스크립트 본문)를 만든다. */
export function inlineCore() {
  const mods = ["playback.mjs", "stats.impl.mjs", "log-lines.impl.mjs", "viewer.impl.mjs"];
  const coreSrc = mods.map((m) => toGlobal(readFileSync(join(coreDir, m), "utf8"))).join("\n");
  return { coreSrc };
}

/** index.html 모듈 스크립트에서 코어 import(viewer·log-lines.impl) 를 제거한다(전역으로 대체하므로). */
export function stripCoreImports(html) {
  let out = html;
  for (const file of ["viewer.impl.mjs", "log-lines.impl.mjs"]) {
    const esc = file.replace(/[.]/g, "\\$&");
    const re = new RegExp(`\\n\\s*import\\s*\\{[^}]*\\}\\s*from\\s*["'][^"']*\\/${esc}["'];?`);
    const before = out;
    out = out.replace(re, "");
    if (out === before) throw new Error(`${file} import 라인을 못 찾음`);
  }
  return out;
}

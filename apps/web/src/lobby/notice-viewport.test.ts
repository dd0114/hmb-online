import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * #386 ② — **공지 팝업의 카드는 "보이는 영역" 안에만 놓인다** (CSS 소스 계약).
 *
 * 왜 e2e 가 아니라 소스를 스캔하나:
 *   헤드리스 크로미움에는 브라우저 툴바가 없어 `100lvh === 100svh === innerHeight` 다. 즉 이
 *   회귀는 **브라우저 자동화로 재현되지 않는다**(CDP `Emulation.setVisibleSize` 가 no-op 임을
 *   실측 확인했다). 그런데도 실기기에서는 확실히 깨진다:
 *
 *     `position: fixed; inset: 0` 의 높이는 **레이아웃 뷰포트**(아이폰13 = 844)라, 툴바가 덮고
 *     있는 부분까지 포함한다. 카드가 808px 로 자라면 본문 스크롤 여유는 **9px** 뿐인데(실측) 실제로
 *     보이는 높이는 660~745 라 **본문 꼬리와 [닫기] 버튼이 툴바 밑으로 들어간다**. 잘린 것이
 *     스크롤러 바깥이므로 아무리 쓸어올려도 안 움직인다 = hero 가 본 "스크롤이 안 돼".
 *
 *   그래서 여기서는 **"약속을 지키고 있는지"를 소스로** 본다. 실제 읽힘(실터치 스크롤·[닫기]
 *   가시성)은 `e2e/p386-notice-viewport.spec.ts` 가 맡는다 — 두 겹이 있어야 회귀가 잡힌다.
 *   ⚠️ 그 e2e 가 **폰 뷰포트에서 도는지**까지 확인해라. 한 번 데스크탑에서 돌면서 4/4 초록이었고,
 *   그동안 실질 커버리지는 **이 파일 하나뿐**이었다(독립검증이 잡았다).
 *
 * ⚠️ `dvh` 로 바꾸지 마라. 툴바가 접힐 때마다 높이가 변해 **읽는 도중 본문이 리플로우**한다
 *    (같은 이유로 관전 셸도 svh 다 — `StageShell.module.css` 머리말).
 */

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/**
 * 파일 안의 **모든** `.overlay` 규칙 블록.
 *
 * ⚠️ 첫 블록만 보면 `@media` 안의 후속 오버라이드(`.overlay { padding-bottom: 18px }`)가 이
 * 스캔을 그냥 통과한다 — 이 회귀를 CI 에서 잡을 수 있는 층이 여기뿐이라 그 구멍이 곧 전부다.
 */
function overlayBlocks(css: string): string[] {
  const out: string[] = [];
  const re = /\.overlay\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    out.push(css.slice(m.index, css.indexOf("}", m.index)));
  }
  return out;
}

describe("#386 공지 오버레이 — 카드가 보이는 영역을 넘지 않는다", () => {
  for (const file of ["NoticePopup.module.css", "NoticeCenter.module.css"]) {
    describe(file, () => {
      const blocks = overlayBlocks(read(file));

      it(".overlay 규칙이 존재한다", () => {
        expect(blocks.length).toBeGreaterThan(0);
      });

      it("툴바 몫(100lvh − 100svh)을 아래 여백으로 비운다", () => {
        // 어느 블록 하나는 반드시 비워야 하고,
        expect(blocks.some((b) => /100lvh\s*-\s*100svh/.test(b))).toBe(true);
        // 뒤따르는 어떤 블록도 그 여백을 무효화하지 않는다(미디어쿼리 오버라이드 포함).
        for (const b of blocks) {
          if (!/padding-bottom/.test(b)) continue;
          expect(b, "padding-bottom 을 다시 쓰면 툴바 몫도 같이 들고 가야 한다").toMatch(
            /100lvh\s*-\s*100svh/,
          );
        }
      });

      it("딤은 화면 전체를 덮는다 — 오버레이 자체를 작은 뷰포트로 줄이지 않는다", () => {
        // `height: 100svh` 로 줄이면 툴바가 접히는 순간 그 아래 띠에 딤이 없어,
        // aria-modal 다이얼로그인데 그 자리를 탭하면 **뒤 화면이 눌린다**.
        expect(blocks[0]).toMatch(/inset:\s*0/);
        for (const b of blocks) expect(b).not.toMatch(/height:\s*100svh/);
      });

      it("툴바가 접힐 때마다 흔들리는 dvh 를 쓰지 않는다", () => {
        for (const b of blocks) expect(b).not.toMatch(/dvh/);
      });

      it("하단 안전영역(홈 인디케이터) 몫을 함께 확보한다", () => {
        expect(blocks.some((b) => /env\(safe-area-inset-bottom/.test(b))).toBe(true);
      });
    });
  }
});

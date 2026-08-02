/**
 * 캐릭터 도트 아바타 매핑/규격 (web 측 SoT) — PRD-v4 §F (AC-F1), P3-D7.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 도트 에셋 입고 규격 (#104 파이프라인 ↔ apps/web 인계 계약)
 * ════════════════════════════════════════════════════════════════════════════
 * 이 파일은 **골격만** 세운 상태다. 도트 이미지 바이너리는 아직 미입고 —
 * 지금은 레지스트리가 비어 있어 **전 선수 placeholder 로 폴백**한다(깨짐 0).
 *
 * ▸ 대상: **LEGEND 등급 선수에만** 도트 매핑. 그 외 등급 = 항상 기본 placeholder.
 *   (현 분포 LEGEND 14명 — data 시드. 등급이 SoT, 명수는 시드 따라 변동 가능.)
 *
 * ▸ 에셋을 "꽂으면 켜지는" 방법 (둘 중 하나, 둘 다 지원):
 *   1) 정적 번들(권장, 재현) — 도트 PNG 를 다음 경로에 넣는다:
 *        apps/web/src/assets/legend-dots/<charId>.png
 *      파일명(확장자 제외) = charId. 빌드시 아래 import.meta.glob 이 자동으로
 *      charId→URL 로 등록한다. **코드 수정 0, 파일만 드롭하면 렌더된다.**
 *   2) 런타임/테스트 주입 seam — globalThis.__HMB_LEGEND_DOTS__ (Record<charId, src>).
 *      정적 레지스트리보다 우선한다. E2E 는 data: URI 를 여기 주입해 매핑을 증명한다.
 *
 * ▸ charId 해석: 현재는 player.imageRef?.charId ?? player.id (아래 resolveCharId).
 *   openapi-v3(#104/data) 가 image ref 필드를 확정하면 그 필드로 교체 — TODO 표식 참조.
 *
 * ▸ 폴백 계약 (깨짐 0): LEGEND 가 아니거나 / charId 없거나 / 레지스트리에 charId 미등록이면
 *   { kind: "placeholder" }. <img> 로드 실패(onError)도 컴포넌트가 placeholder 로 스왑.
 *   → 어떤 경우에도 깨진 이미지 아이콘이 뜨지 않는다(AC-F1).
 *
 * ▸ #104/data 에 레이즈 필요: players 응답의 image ref 필드 계약(필드명·charId 규칙·등급
 *   ↔ 캐릭터 매핑 표). 확정 전까지 아래 PlayerImageRef 는 **web 잠정 계약**이다.
 * ════════════════════════════════════════════════════════════════════════════
 */
import type { Grade } from "./grades";

/**
 * players 응답에 additive 될 이미지 참조(잠정). 전부 optional — 부재 시 placeholder.
 * TODO(openapi-v3): #104/data 가 필드를 확정하면 이 타입을 생성 스키마로 교체.
 */
export interface PlayerImageRef {
  /** 도트 에셋 레지스트리 키. 미지정이면 player.id 로 폴백(resolveCharId). */
  charId?: string | null;
}

/** 아바타 렌더에 필요한 최소 선수 형상(CatalogPlayer 가 구조적으로 만족). */
export interface AvatarPlayer {
  id: string;
  grade: Grade;
  name: string;
  imageRef?: PlayerImageRef | null;
}

export type ResolvedAvatar =
  | { kind: "legend-dot"; src: string }
  | { kind: "placeholder" };

/**
 * 정적 도트 레지스트리 — 번들된 PNG 를 charId→URL 로 자동 수집한다.
 * 지금은 apps/web/src/assets/legend-dots/ 가 비어 있어 {} 다(전부 placeholder).
 * (vitest 도 Vite 기반이라 import.meta.glob 지원 — 파일 0개면 안전하게 {}.)
 */
const dotModules = import.meta.glob("../assets/legend-dots/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const LEGEND_DOT_REGISTRY: Record<string, string> = {};
for (const [path, url] of Object.entries(dotModules)) {
  const charId = path.split("/").pop()!.replace(/\.png$/i, "");
  LEGEND_DOT_REGISTRY[charId] = url;
}

/** 런타임/테스트 주입 오버라이드(정적 레지스트리보다 우선). */
function overrideRegistry(): Record<string, string> | undefined {
  return (globalThis as { __HMB_LEGEND_DOTS__?: Record<string, string> }).__HMB_LEGEND_DOTS__;
}

/** charId → 도트 src. 오버라이드 우선, 없으면 정적 번들. 미등록이면 undefined. */
function lookupDotSrc(charId: string): string | undefined {
  return overrideRegistry()?.[charId] ?? LEGEND_DOT_REGISTRY[charId];
}

/**
 * player → charId. TODO(#104)/TODO(openapi-v3): image ref 필드가 확정되면 교체.
 * 잠정: imageRef.charId 우선, 없으면 player.id.
 */
export function resolveCharId(player: AvatarPlayer): string | null {
  return player.imageRef?.charId ?? player.id ?? null;
}

/**
 * 순수 함수 — 렌더 경로 결정. LEGEND + 등록된 도트 있으면 legend-dot, 그 외 placeholder.
 * (globalThis 오버라이드는 문서화된 런타임/테스트 seam — 엔진 결정론 규칙 밖의 UI 에셋 계약.)
 */
export function resolvePlayerAvatar(player: AvatarPlayer): ResolvedAvatar {
  if (player.grade !== "LEGEND") return { kind: "placeholder" };
  const charId = resolveCharId(player);
  if (!charId) return { kind: "placeholder" };
  const src = lookupDotSrc(charId);
  if (!src) return { kind: "placeholder" };
  return { kind: "legend-dot", src };
}

/**
 * 이름 → 최대 2글자 이니셜 (**아바타 폴백의 유일한 규칙**). **스크립트에 따라 규칙이 갈린다**
 * (#406 요구 6 한글화).
 *
 * <p><b>왜 갈라야 하나</b>: 로마자 이름의 관례는 "각 단어의 첫 글자"(`Paolo Maldini` → `PM`)인데,
 * 그 규칙을 한글 음역에 그대로 적용하면 <b>글자 조각이 나온다</b> — `레프 야신` → `레야`,
 * `프란츠 베켄바워` → `프베`. 사람이 못 읽는다. 한글에서 신원을 지고 있는 조각은 <b>마지막 토큰</b>
 * (성 = 발행물 `shortName` 이 고른 것과 같은 조각: `레프 야신` → `야신`)이다.
 *
 * <ul>
 *   <li><b>한글 포함</b> → 마지막 토큰의 앞 2글자. `레프 야신`→`야신` · `오현규`→`오현` ·
 *       `크바라츠헬리아`→`크바`. 아바타는 28~40px 라 2글자가 상한이다.</li>
 *   <li><b>로마자</b> → 기존 규칙 그대로(첫 단어 첫 글자 + 마지막 단어 첫 글자). 구 서버·과거
 *       스냅샷이 영어 이름을 계속 내려보내므로 이 경로는 <b>죽지 않았다</b>.</li>
 * </ul>
 *
 * <p>⚠️ <b>이 함수는 `CharAvatar` 에 있었고, 여기엔 "첫 글자 한 개"라는 <em>다른</em> 규칙
 * (`avatarInitial`)이 따로 살아 있었다.</b> 같은 질문(이 이름의 이니셜은?)에 형제 파일 둘이
 * 서로 다른 답을 갖고 있었던 것이다 — `레프 야신` → `레` vs `야신`. 화면 영향은 없었지만
 * (`avatarInitial` 의 유일한 소비자 `PlayerAvatar` 를 아무 화면도 안 쓴다) 다음 사람이 어느
 * 쪽을 근거로 삼을지 알 수 없는 상태였다. 규칙은 <b>여기 하나</b>이고 `CharAvatar` 는 이걸
 * 재수출한다(그 파일의 계약 `CharAvatar.test.ts` 가 계속 성립하도록).
 */
export function initialsOf(name: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return "?";
  // 한글이 한 글자라도 있으면 한글 규칙 — 혼합 표기(`FC 손흥민` 같은 운영 입력)도 읽히는 쪽으로.
  if (/[가-힣]/.test(name)) return last.slice(0, 2);
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

/**
 * `PlayerAvatar` placeholder 이니셜 — {@link initialsOf} 의 **별칭**이다(규칙 복제 금지).
 * 이름만 다른 이유는 호출부 호환뿐이니, 새 코드는 {@link initialsOf} 를 직접 써라.
 */
export const avatarInitial = initialsOf;

/** 테스트 헬퍼 — 런타임 seam 에 stub 도트 주입/해제(unit 편의; E2E 는 addInitScript). */
export function __setLegendDotAsset(charId: string, src: string): void {
  const g = globalThis as { __HMB_LEGEND_DOTS__?: Record<string, string> };
  g.__HMB_LEGEND_DOTS__ = { ...(g.__HMB_LEGEND_DOTS__ ?? {}), [charId]: src };
}

export function __clearLegendDotAssets(): void {
  delete (globalThis as { __HMB_LEGEND_DOTS__?: Record<string, string> }).__HMB_LEGEND_DOTS__;
}

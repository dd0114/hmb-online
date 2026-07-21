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

/** placeholder 이니셜(이름 첫 글자, 없으면 '?'). 유닛테스트/컴포넌트 공용. */
export function avatarInitial(name: string): string {
  const chars = [...(name ?? "").trim()];
  return chars[0] ?? "?";
}

/** 테스트 헬퍼 — 런타임 seam 에 stub 도트 주입/해제(unit 편의; E2E 는 addInitScript). */
export function __setLegendDotAsset(charId: string, src: string): void {
  const g = globalThis as { __HMB_LEGEND_DOTS__?: Record<string, string> };
  g.__HMB_LEGEND_DOTS__ = { ...(g.__HMB_LEGEND_DOTS__ ?? {}), [charId]: src };
}

export function __clearLegendDotAssets(): void {
  delete (globalThis as { __HMB_LEGEND_DOTS__?: Record<string, string> }).__HMB_LEGEND_DOTS__;
}

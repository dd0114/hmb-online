/**
 * 아트 번들 운영 패널의 **순수 로직** (#309 W2) — 정규화·표시 문구.
 *
 * 규율은 공지 패널과 같다: **서버 응답을 그대로 믿지 않는다**(여기서 던지면 admin 페이지 전체가
 * 흰 화면이 되고, 그러면 아트라는 부가 기능 하나가 유저·유닛·공지 운영을 통째로 막는다).
 */
import type { CharBundleRow } from "../api/char-bundles";

/** 목록 응답 → 행 배열. `{bundles:[…]}` 도 맨 배열도 받고, 아니면 빈 배열. */
export function normalizeCharBundleRows(raw: unknown): CharBundleRow[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { bundles?: unknown }).bundles)
      ? ((raw as { bundles: unknown[] }).bundles)
      : null;
  if (!list) return [];
  const out: CharBundleRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const id = typeof b.id === "string" ? b.id : "";
    if (!id) continue;
    out.push({
      id,
      fileCount: typeof b.fileCount === "number" ? b.fileCount : 0,
      byteSize: typeof b.byteSize === "number" ? b.byteSize : 0,
      summary: b.summary && typeof b.summary === "object" ? (b.summary as Record<string, unknown>) : {},
      note: typeof b.note === "string" ? b.note : null,
      // ⚠️ 활성은 **명시적 true 일 때만** 참이다. 공지의 `!== false` 규칙을 복사하면 안 된다 —
      //    거기선 기본이 "노출"이지만 여기선 기본이 "서빙 안 함"이고, 잘못 켜진 것처럼 보이면
      //    운영자가 "왜 아트가 안 바뀌지"를 엉뚱한 데서 찾는다.
      active: b.active === true,
      createdBy: typeof b.createdBy === "string" ? b.createdBy : null,
      createdAt: typeof b.createdAt === "string" ? b.createdAt : null,
      updatedAt: typeof b.updatedAt === "string" ? b.updatedAt : null,
    });
  }
  return out;
}

/** 지금 서빙 중인 리비전. 없으면 `null` = **구운 폴백 중**. */
export function activeRevisionOf(raw: unknown): string | null {
  if (raw && typeof raw === "object") {
    const v = (raw as { activeRevision?: unknown }).activeRevision;
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * 지금 어떤 아트가 나가고 있는가 — 운영자에게 **한 줄로** 말한다.
 *
 * 이 문장이 필요한 이유: 아트 교체는 "올렸는데 왜 안 바뀌지"가 가장 흔한 혼란이다.
 * 화면이 활성 리비전을 분명히 말하지 않으면 운영자는 브라우저 캐시·배포·zip 중 어디를 봐야
 * 할지 모른다.
 */
export function activeArtSummary(activeRevision: string | null): string {
  return activeRevision
    ? `서버 번들 ${activeRevision} 을 서빙 중입니다`
    : "웹 빌드에 구운 기본 아트를 쓰는 중입니다(활성 번들 없음)";
}

/** 번들 요약(서버가 매니페스트에서 뽑은 값)을 사람이 읽는 한 줄로. 없는 값은 조용히 뺀다. */
export function summaryLine(summary: Record<string, unknown> | null | undefined): string {
  if (!summary) return "";
  const parts: string[] = [];
  const push = (label: string, key: string) => {
    const v = summary[key];
    if (v !== null && v !== undefined && v !== "") parts.push(`${label} ${String(v)}`);
  };
  push("유닛", "unitsCount");
  push("아트출처", "unitsSource");
  push("매핑", "mappingVersion");
  push("매핑선수", "mappedPlayers");
  return parts.join(" · ");
}

/**
 * 활성 전환 확인 문구. **켜기와 끄기가 다른 말을 한다** —
 * 끄기는 "구운 폴백으로 되돌린다"가 요점이고, 켜기는 "무엇이 나가는가"가 요점이다.
 */
export function activateWarning(target: CharBundleRow | null): string {
  if (!target) {
    return "활성 번들을 전부 끕니다 — 웹 빌드에 구운 기본 아트로 되돌아갑니다(언제든 다시 켤 수 있습니다).";
  }
  return `리비전 ${target.id} 을 서빙합니다. 유저 브라우저는 새로고침 뒤 새 아트를 봅니다.`;
}

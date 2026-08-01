import type { EngineConfig } from "../config";

/**
 * realism/knob-paths — `EngineConfig` 의 **리프 경로 전수**(정렬). (#377 트랙 D 회고)
 *
 * ## 왜 있나
 * 트랙 D 세 웨이브에서 독립검증이 잡은 blocker 5건 중 **3건이 같은 부류**였다 —
 * *"노브를 선언했는데 코드가 안 읽는다"* 또는 *"읽지만 출하값에서 한 번도 발화하지 않는다"*:
 *  - `setPiece.freeKick.routeAroundZone` — 선언만 하고 소비처 0 (M1-pre B1)
 *  - `setPiece.freeKick.wallClearM` — 소비처는 있으나 출하값에서 무발화 + 그 계약이 tautology (M1-본 B1)
 *  - `chain.passDirectnessEnabled` — 롤백 스위치가 아예 없어 아블레이션 한 팔이 재현 불가 (M2 m3)
 *
 * 셋 다 **커밋 전에 기계로 걸렸어야 하는 것**이다. 사람이 매번 "이 노브 살아 있나?"를 기억하는
 * 방식은 세 번 실패했다.
 *
 * ## 어떻게 거나
 * 이 파일은 경로를 세는 일만 한다. 게이트는 `dead-knobs.test.ts` 가 스냅샷으로 건다 —
 * **노브를 추가하면 스냅샷이 깨지고, 그 diff 가 새 경로의 이름을 그대로 보여준다.**
 * 그때 해야 하는 일은 `-u` 가 아니라 **레지스트리 분류 등록**이고, 실패 메시지가 그걸 말한다.
 *
 * 배열은 값이 아니라 **길이만** 본다(포메이션 좌표표처럼 데이터인 항목까지 경로로 펼치면
 * 스냅샷이 데이터 변경마다 깨져서 노브 신호가 묻힌다).
 */
export function knobPaths(config: EngineConfig): string[] {
  const out: string[] = [];
  const walk = (v: unknown, prefix: string): void => {
    if (v === null || typeof v !== "object") {
      out.push(prefix);
      return;
    }
    if (Array.isArray(v)) {
      out.push(`${prefix}[]`);
      return;
    }
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      walk((v as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k);
    }
  };
  walk(config as unknown, "");
  return out.sort();
}

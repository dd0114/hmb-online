/**
 * gen-chars.ts — 선수 ↔ 캐릭터 매핑 결정론 생성기 (#145, hero/매니저 확정 **B안**).
 *
 * 실행: `npx tsx data/players/gen-chars.ts` → `player-chars.v1.json` 재생성(재실행 바이트 동일).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * B안 = **전원 커버 · 중복 허용**
 *   - 172명 **전원**에 캐릭터를 배정한다(플레이스홀더로 남는 선수 0).
 *   - **LEGEND 14명은 1:1 고정**(중복 없음) — 확정 원화 14종을 독점한다.
 *   - 비-LEGEND 158명은 **포지션 매칭 풀에서 결정론 해시**로 배정(중복 허용).
 *     같은 포지션 풀이 2~4종뿐이라 중복은 불가피 — 완화하려면 C안(hue 변형 대량 발행, #104).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 왜 별도 발행 파일인가(players.v2.1.json 에 안 넣는 이유):
 *   data/CLAUDE.md — "산출물은 버전 파일로만 발행, **발행 후 수정 금지**". 이미 발행된
 *   players.v2/v2.1 을 고치면 소비자(server-java) 조율이 필요하다. 매핑은 players 와 축이 다르고
 *   (선수 신규발행 없이 아트만 바뀔 수 있다) hero 가 손으로 갈아끼울 수 있어야 하므로
 *   **독립 축의 발행물**로 낸다. 소비자는 playerId 로 조인한다.
 *
 * 결정론(AC-D2): Math.random/Date.now 금지. playerId 문자열 해시만 쓴다(맵 순회 순서 무관).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hashSeed } from "./rng";
import type { Grade, Position } from "./generate";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** 발행 버전 태그(파일명·manifest.version). */
export const CHARS_MAP_VERSION = "v1";

/** 이 매핑이 전제하는 캐릭터 발행물(design/characters/dist/characters). 불일치 시 생성이 실패한다. */
export const CHARS_SOURCE = "ref-pixel-fantasy-football";

/** 해시 분산용 솔트 — 바꾸면 비-LEGEND 배정이 통째로 바뀐다(= 새 버전 발행 대상). */
const SALT = "hmb-player-chars-v1";

// ── 확정 배정 (LEGEND 14, 1:1) ──────────────────────────────────────────────
//
// LEGEND 포지션 분포 GK1·DF3·MF5·FW5 vs 캐릭터 GK2·DF3·MF5(변형1 포함)·FW4(변형1 포함).
// 변형 2종은 발행측 힌트(#121)대로 고정 — sail-h150→P143(MF), ragna-h210→P144(FW).
// 남은 원본 12종을 P001~P012 에 포지션 매칭으로 배정하면 **FW 가 1 모자라고 GK 가 1 남는다**
// (원본 GK2 vs LEGEND GK1). 그래서 여분 GK 인 penguin-king 을 FW 슬롯 하나에 넘긴다
// (유일한 포지션 교차 — 아래 crossPosition 플래그로 명시 기록).
const LEGEND_ASSIGNMENT: ReadonlyArray<readonly [playerId: string, charId: string]> = [
  ["P001", "aura"], // GK
  ["P002", "lupus"], // DF
  ["P003", "leo"], // DF
  ["P004", "bark"], // DF
  ["P005", "sail"], // MF
  ["P006", "mio"], // MF
  ["P007", "riya"], // MF
  ["P008", "bella"], // MF
  ["P009", "ragna"], // FW
  ["P010", "natzt"], // FW
  ["P011", "anubis"], // FW
  ["P012", "penguin-king"], // FW ← 여분 GK 캐릭터 전용(유일한 포지션 교차)
  ["P143", "sail-h150"], // MF (발행측 forPlayer 힌트)
  ["P144", "ragna-h210"], // FW (발행측 forPlayer 힌트)
];

/** 비-LEGEND 풀 = **원본 12종만** 포지션별로 묶은 것. 변형 2종은 LEGEND 전용이라 제외한다. */
export const POOL_BY_POSITION: Readonly<Record<Position, readonly string[]>> = {
  GK: ["aura", "penguin-king"],
  DF: ["bark", "leo", "lupus"],
  MF: ["bella", "mio", "riya", "sail"],
  FW: ["anubis", "natzt", "ragna"],
};

// ── 순수 배정 로직 ──────────────────────────────────────────────────────────

export interface MappedPlayer {
  playerId: string;
  charId: string;
  /** 배정 근거 — LEGEND 독점 1:1 인가, 포지션 풀 해시인가. */
  rule: "legend-exclusive" | "position-pool";
  /** 캐릭터 포지션과 선수 포지션이 다른가(LEGEND 교차 1건만 true). */
  crossPosition?: true;
}

/**
 * 비-LEGEND 배정 = 포지션 그룹 안에서 **균등 라운드로빈**.
 *
 * 왜 순수 해시가 아닌가: 풀이 2~4종뿐이라 해시는 쏠린다(실측 DF 53명 → 22/17/14). 중복이
 * 불가피한 B안에서 쏠림은 "같은 얼굴만 보인다"로 직결되므로 **최대 편차 1**을 보장한다.
 * 시작 오프셋만 그룹 해시로 돌려 포지션마다 같은 캐릭터로 시작하지 않게 한다.
 *
 * 결정론: 입력을 playerId 오름차순으로 고정 정렬한 뒤 인덱스를 매기므로 입력 순서 무관.
 */
export function assignPool(playerIds: readonly string[], position: Position): Map<string, string> {
  const pool = POOL_BY_POSITION[position];
  const sorted = [...playerIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const offset = hashSeed(`${SALT}:${position}`) % pool.length;
  const out = new Map<string, string>();
  sorted.forEach((id, i) => out.set(id, pool[(i + offset) % pool.length]));
  return out;
}

export interface PlayerLike {
  id: string;
  position: Position;
  grade: Grade;
}

/** 캐릭터 발행 manifest 중 이 생성기가 쓰는 부분. */
export interface CharsManifestLike {
  source?: string;
  characters: Record<string, { position: string } | undefined>;
}

/**
 * 선수 목록 → 매핑. 순수 함수(IO 없음). playerId 오름차순으로 정렬해 직렬화 안정성을 보장한다.
 * 발행물에 없는 charId 를 만들면 즉시 throw — 조용히 깨진 참조를 내보내지 않는다.
 */
export function buildMapping(players: readonly PlayerLike[], manifest: CharsManifestLike): MappedPlayer[] {
  if (manifest.source && manifest.source !== CHARS_SOURCE) {
    throw new Error(`캐릭터 발행물이 예상과 다르다: ${manifest.source} (기대 ${CHARS_SOURCE}) — 매핑 재확정 필요`);
  }
  const legend = new Map(LEGEND_ASSIGNMENT);
  const byId = new Map(players.map((p) => [p.id, p]));

  // LEGEND 배정표가 실제 시드와 어긋나면(등급 재배정 등) 조용히 넘어가지 않는다.
  for (const [playerId, charId] of LEGEND_ASSIGNMENT) {
    const p = byId.get(playerId);
    if (!p) throw new Error(`LEGEND 배정 대상이 시드에 없다: ${playerId}`);
    if (p.grade !== "LEGEND") throw new Error(`${playerId} 는 LEGEND 가 아니다(${p.grade}) — 배정표 재확정 필요`);
    if (!manifest.characters[charId]) throw new Error(`발행물에 없는 캐릭터: ${charId}`);
  }
  const legendPlayers = players.filter((p) => p.grade === "LEGEND").map((p) => p.id);
  for (const id of legendPlayers) {
    if (!legend.has(id)) throw new Error(`LEGEND 인데 배정표에 없다: ${id} — 1:1 고정이 깨졌다`);
  }

  // 비-LEGEND 를 포지션별로 모아 균등 배정한다(그룹 단위라야 편차를 보장할 수 있다).
  const pooled = new Map<string, string>();
  for (const position of ["GK", "DF", "MF", "FW"] as const) {
    const ids = players.filter((p) => p.position === position && !legend.has(p.id)).map((p) => p.id);
    for (const [id, charId] of assignPool(ids, position)) pooled.set(id, charId);
  }

  const out: MappedPlayer[] = [];
  for (const p of [...players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const fixed = legend.get(p.id);
    const charId = fixed ?? pooled.get(p.id)!;
    const entry = manifest.characters[charId];
    if (!entry) throw new Error(`발행물에 없는 캐릭터: ${charId} (${p.id})`);
    const row: MappedPlayer = {
      playerId: p.id,
      charId,
      rule: fixed ? "legend-exclusive" : "position-pool",
    };
    if (entry.position !== p.position) row.crossPosition = true;
    out.push(row);
  }
  return out;
}

export interface CharsMapFile {
  version: string;
  rule: string;
  note: string;
  charsSource: string;
  playerCount: number;
  /** playerId → charId (조인 키). 소비자는 이 맵만 보면 된다. */
  players: Record<string, string>;
  /** 배정 근거(감사·QA용). 렌더에는 불필요. */
  detail: MappedPlayer[];
}

export function buildFile(players: readonly PlayerLike[], manifest: CharsManifestLike): CharsMapFile {
  const detail = buildMapping(players, manifest);
  const map: Record<string, string> = {};
  for (const d of detail) map[d.playerId] = d.charId;
  return {
    version: CHARS_MAP_VERSION,
    rule: "B: 전원 커버·중복 허용 (LEGEND 14 는 1:1 독점, 비-LEGEND 는 포지션 풀 해시)",
    note: "#145 확정. 캐릭터 발행물 = design/characters/dist/characters. 소비자는 playerId 로 조인한다.",
    charsSource: CHARS_SOURCE,
    playerCount: detail.length,
    players: map,
    detail,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
export function loadInputs(): { players: PlayerLike[]; manifest: CharsManifestLike } {
  const players = JSON.parse(readFileSync(join(here, "players.v2.1.json"), "utf8")) as PlayerLike[];
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "design", "characters", "dist", "characters", "manifest.json"), "utf8"),
  ) as CharsManifestLike;
  return { players, manifest };
}

export const OUT_PATH = join(here, `player-chars.${CHARS_MAP_VERSION}.json`);

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { players, manifest } = loadInputs();
  const file = buildFile(players, manifest);
  writeFileSync(OUT_PATH, JSON.stringify(file, null, 2) + "\n");
  const dupes = new Set(Object.values(file.players)).size;
  console.log(`[gen-chars] ${OUT_PATH} — ${file.playerCount}명 → 캐릭터 ${dupes}종 사용`);
}

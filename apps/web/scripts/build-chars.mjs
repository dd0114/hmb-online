// build-chars.mjs — 캐릭터 에셋 + 선수 매핑을 web 번들이 서빙할 수 있게 스테이징한다.
//
// 왜 복사인가: 발행물은 `design/characters/dist/**`(에셋)와 `data/players/**`(매핑)에 있고
// vite publicDir 밖이라 그대로는 서빙이 안 된다. QA 뷰어(build-viewer.mjs)와 **같은 규약** —
// 커밋된 원본을 gitignore 생성물로 복사하고, predev/prebuild(ensure-chars.mjs)가 최신 여부만
// 값싸게 확인한다. 원본은 **무수정**(발행 도메인 경계 — design/·data/ 는 남의 글롭).
//
// 세 축을 그대로 옮긴다(합치지 않는다 — 각자 별도 계약):
//   design/characters/dist/            → public/chars/                (플레이스홀더 172명 + 등급프레임)
//   design/characters/dist/characters/ → public/chars/characters/     (확정 캐릭터 14종 + 풀아트 카드)
//   data/players/player-chars.v1.json  → public/chars/player-chars.json (선수 → 캐릭터 매핑, #145 B안)
//
// 소비: `/chars/manifest.json`, `/chars/characters/manifest.json`, `/chars/player-chars.json` 을
// 런타임 fetch(번들 import 아님 — 172명 아틀라스를 JS 번들에 넣지 않는다).
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const srcDist = join(repoRoot, "design", "characters", "dist");
const srcMapping = join(repoRoot, "data", "players", "player-chars.v1.json");
const outDir = join(repoRoot, "apps", "web", "public", "chars");
const stampPath = join(outDir, "stamp.json");

/** 디렉토리 트리의 파일 개수(스탬프에 박아 부분 손상·삭제를 감지한다). */
export function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}

/**
 * 스테이징 최신 여부 판정용 스탬프. manifest 버전만으로는 부족하다 —
 * 발행물 version 이 정적(1)이라 upstream 이 PNG 만 다시 뽑아도 같은 값이 나오므로
 * **파일 개수 + 총 바이트**를 함께 박아 내용 변화를 잡는다.
 */
export function readSourceStamp() {
  const base = JSON.parse(readFileSync(join(srcDist, "manifest.json"), "utf8"));
  const chars = JSON.parse(readFileSync(join(srcDist, "characters", "manifest.json"), "utf8"));
  const mapping = existsSync(srcMapping) ? JSON.parse(readFileSync(srcMapping, "utf8")) : null;
  return {
    base: { version: base.version, source: base.source, playerCount: base.playerCount },
    chars: { version: chars.version, source: chars.source, count: chars.count },
    mapping: mapping ? { version: mapping.version, playerCount: mapping.playerCount } : null,
    /** 원본 트리 규모 — 스테이징 후 같은 수가 나와야 한다. */
    sourceFiles: countFiles(srcDist) + (existsSync(srcMapping) ? 1 : 0),
    sourceBytes: totalBytes(srcDist) + (existsSync(srcMapping) ? statSync(srcMapping).size : 0),
  };
}

function totalBytes(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    n += entry.isDirectory() ? totalBytes(p) : statSync(p).size;
  }
  return n;
}

/** 스테이징된 스탬프(없거나 깨졌으면 null). */
export function readStagedStamp() {
  if (!existsSync(stampPath)) return null;
  try {
    return JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 순수 판정부 — IO 결과를 받아 "재스테이징 이유"(최신이면 null)를 돌려준다.
 * 테스트에서 IO 없이 태울 수 있도록 분리했다.
 */
export function stageDecision({ hasBaseManifest, hasCharsManifest, hasMapping, staged, source, stagedFiles }) {
  if (!hasBaseManifest) return "스테이징 없음";
  if (!hasCharsManifest) return "캐릭터 축 없음";
  if (!hasMapping) return "매핑 없음";
  if (!staged) return "스탬프 없음";
  if (JSON.stringify(staged) !== JSON.stringify(source)) return "발행물 변경";
  // stamp.json 자신은 원본에 없으므로 +1. 개수가 어긋나면 누가 지웠거나 덜 복사된 것.
  if (stagedFiles !== source.sourceFiles + 1) {
    return `스테이징 파일 수 불일치(${stagedFiles} ≠ ${source.sourceFiles + 1})`;
  }
  return null;
}

/** 재스테이징이 필요한 이유(최신이면 null). */
export function needsStage() {
  return stageDecision({
    hasBaseManifest: existsSync(join(outDir, "manifest.json")),
    hasCharsManifest: existsSync(join(outDir, "characters", "manifest.json")),
    hasMapping: existsSync(join(outDir, "player-chars.json")),
    staged: readStagedStamp(),
    source: readSourceStamp(),
    stagedFiles: countFiles(outDir),
  });
}

export function stage() {
  if (!existsSync(srcDist)) {
    throw new Error(`캐릭터 발행물이 없다: ${srcDist} — design/characters 트랙(#104) 산출물 확인 필요`);
  }
  if (!existsSync(srcMapping)) {
    throw new Error(`선수↔캐릭터 매핑이 없다: ${srcMapping} — \`npx tsx data/players/gen-chars.ts\` 로 발행`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // dist/ 통째 복사 = 플레이스홀더 축 + 그 안의 characters/(확정 캐릭터 축)까지 한 번에.
  cpSync(srcDist, outDir, { recursive: true });
  // 매핑은 버전 없는 안정 이름으로 — 소비자(web)가 버전 문자열을 몰라도 되게 한다.
  copyFileSync(srcMapping, join(outDir, "player-chars.json"));
  const stamp = readSourceStamp();
  writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + "\n");
  return stamp;
}

// 직접 실행 시에만 스테이징(ensure-chars.mjs 는 위 export 만 쓴다).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const stamp = stage();
  console.log(
    `[build-chars] staged → apps/web/public/chars ` +
      `(플레이스홀더 ${stamp.base.playerCount}명 · 캐릭터 ${stamp.chars.count}종 · 매핑 ${stamp.mapping?.playerCount ?? 0}명)`,
  );
}

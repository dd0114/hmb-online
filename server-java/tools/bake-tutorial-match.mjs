/**
 * #493 W6-v3 — 튜토리얼 **고정 매치** 자산을 굽는다.
 *
 * hero verbatim: *"선수도 보유 선수말고 그냥 튜토리얼선수로 한다고생각하고 진행하게 하자. 그래야
 * 시드값이 안바뀌어. … 모든유저가 같은 결과를 보는거야. … 게임도 이겨야해."*
 *
 * 그래서 이 스크립트는 **고정 로스터 + 고정 전술입력 + 고정 시드**로 실엔진(러너 `/simulate`)을
 * 돌려 전·후반 매치로그를 통째로 구워 리소스로 박는다. 런타임은 이 파일을 그대로
 * `match_halves` 에 적재하므로 AI 호출 0 · 러너 호출 0 · 전 유저 바이트 동일이다.
 *
 * ⚠️ **시드 스캔이 이 스크립트의 본체다.** "유저(home)가 이긴다"는 코드로 보장할 수 없고
 * 실제 시뮬로 확인해야 하는 성질이라, 승리 조건을 만족하는 시드를 찾을 때까지 돌린다.
 *
 * 사용:
 *   node server-java/tools/bake-tutorial-match.mjs            # 스캔 + 굽기
 *   RUNNER=http://127.0.0.1:8790 MAX_SEEDS=200 node …          # 러너 주소·스캔 한도
 *   SCAN_ONLY=1 node …                                         # 쓰기 없이 스캔 로그만
 *
 * 결정론 계약: 시드 파생은 서버의 `online.hmb.common.Hashes` 와 **같은 식**이어야 한다
 * (`halfSeed = sha256(matchSeed + ":h" + half)` 첫 8바이트 → unsigned 10진). 다르면 구워 둔 로그와
 * `match_halves.half_seed` 가 서로 다른 말을 하게 되고, "이 로그는 이 시드로 재현된다"가 거짓이 된다.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const RUNNER = process.env.RUNNER ?? "http://127.0.0.1:8790";
const MAX_SEEDS = Number(process.env.MAX_SEEDS ?? 120);
// gzip 으로 굽는다 — 원본은 ~3.9MB 라 리포에 그대로 넣을 크기가 아니다(gz ~0.47MB).
// 서버는 부팅이 아니라 **필요할 때** 풀어 쓴다(튜토리얼 매치는 유저당 1회).
const OUT = resolve(HERE, "../src/main/resources/tutorial/tutorial-match.json.gz");

const PLAYERS_FILE = resolve(REPO, "data/players/players.v2.8.1.json");

// ── 고정 로스터 ───────────────────────────────────────────────────────────
// hero (#493 W10): *"튜토리얼 선수들 다양하게하자 지금 튜토리얼 선수들 다 일반선수들이라 재미없어.
// 얼굴 케릭터 있는거로하자."*
//
// **얼굴이 뜨는 조건은 두 개고, 둘 다 데이터에 있다**(web 코드는 안 건드린다):
//   ① `data/players/player-chars.v2.json` 의 rule 이 `grade-default-unit` 이 **아닐 것**
//      (= 등급 공용 기본 유닛이 아니라 개별/포지션 아트). 구 로스터 11+11 은 전원 그 공용 아트였다.
//   ② 카탈로그 등급이 **DIA 이상**(web `icon-policy.CHAR_ART_MIN_GRADE`, #285) 이고
//      **`active: true`**(=`GET /api/players` 가 `active=1 OR 보유>0` 로 자른다 — 비활성 선수는
//      신규 유저의 카탈로그 응답에 아예 없어서 이름·등급이 안 잡히고, 등급이 없으면 아트가
//      fail-closed 로 닫힌다). 그래서 **구 LEGEND 14명(P001~P012·P143·P144)은 못 쓴다** — 아트는
//      있지만 전원 `active:false` 다.
//
// 그 두 조건을 통과하는 선수는 지금 카탈로그에 **22명뿐**이고(유닛 실아트 LEGEND 9 + DIA 13),
// 그중 서로 **다른 아트 파일**을 갖는 조합만 고른다(DIA 는 포지션 풀 공용이라 `sail`·`ragna`·
// `lupus` 가 두 명씩 겹친다 — 겹치는 쪽은 한 명만 쓴다).
//
// ⚠️ **수비수 아트는 4종이 전부다**(lupus·leo·bark·seokdijk). 4-3-3 두 팀이면 DF 슬롯이 8칸이라
// 절반은 구조적으로 얼굴이 없다. hero 우선순위대로 **home(마이 팀)에 4종을 다 준다** — away 의
// 백4 는 GOLD 일반 선수로 채운다(중복 아트를 만들지 않는 쪽을 택했다. Decision log 참조).
const HOME_STARTERS = [
  "P182", // GK 오시야스   LEGEND units/osiyas
  "P015", // LB 에릭 발딘   DIA    characters/lupus
  "P181", // CB 석다이크    LEGEND units/seokdijk
  "P020", // CB 닐스 두란테 DIA    characters/leo
  "P022", // RB 다니엘 오르베 DIA  characters/bark
  "P179", // DM 욱링엄      LEGEND units/wookringham
  "P175", // CM 열라도나    LEGEND units/yeoldona
  "P177", // CM 덕브라이너  LEGEND units/dukbrayner
  "P174", // LW 권씨        LEGEND units/kwonssi
  "P173", // ST 보날두      LEGEND units/bonaldo
  "P176", // RW 춘바페      LEGEND units/chunbappe
];
const HOME_NAME = "마이 팀";
const AWAY_BOT = "BOT_ATK";   // 시드봇 3종 중 **테스트 픽스처에도 있는** id — 계약이 출하 자산을 그대로 태울 수 있다
const AWAY_NAME_FALLBACK = "튜토리얼 FC";
// away 도 **남는 얼굴 선수로 최대한** 채운다(GK·MF 3·FW 3 = 7명). 백4 는 얼굴 아트가 남지 않아
// GOLD 일반 선수다 — BRONZE 봇 로스터보다 한 단계 올려 "이길 수는 있지만 허수아비는 아닌" 상대로
// 둔다(승리 판정은 아래 `acceptable` 이 실시뮬로 확인한다).
//
// ⚠️ **더 이상 봇 덱에서 읽지 않는다.** `bots.v4.json` 은 전원 `grade-default-unit` 이고
// `data/**` 는 이 모듈의 owned-glob 밖이라 고칠 수 없다. 대신 자산이 away 로스터를 들고 가고,
// 서버 `MatchService.buildOpponent` 가 **튜토리얼 매치일 때 이 자산 로스터**를 상대 카드로 쓴다
// (안 그러면 상대 분석 화면과 실제로 뛴 로스터가 갈린다).
const AWAY_STARTERS = [
  "P014", // GK 요나스 브리크 DIA characters/penguin-king
  "P043", // LB 로만 팔코니   GOLD (공용 아트 — 남은 DF 아트가 없다)
  "P050", // CB 세드릭 마르텔 GOLD
  "P148", // CB 노시운        GOLD
  "P150", // RB 표유안        GOLD
  "P024", // DM 안톤 그레츠   DIA characters/riya
  "P025", // CM 티모 라스코   DIA characters/sail
  "P030", // CM 파블로 시몬티 DIA characters/bella
  "P031", // LW 밀란 코발디   DIA characters/anubis
  "P180", // ST 경니시우스    LEGEND units/kyeongnicius
  "P033", // RW 이반 모리안   DIA characters/ragna
];
const FORMATION = "4-3-3";
/** SLOTS 순서에 대응하는 **카탈로그 포지션** — 로스터를 바꿀 때 자리를 어기지 않게 검증한다. */
const SLOT_POSITIONS = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "FW", "FW", "FW"];

/** 4-3-3 슬롯 역할·기본좌표(정규화 0..1) — TacticalInput.players 순서와 1:1. */
const SLOTS = [
  { role: "GK", duty: "defend", x: 0.05, y: 0.5 },
  { role: "LB", duty: "support", x: 0.25, y: 0.15 },
  { role: "CB", duty: "defend", x: 0.2, y: 0.38 },
  { role: "CB", duty: "defend", x: 0.2, y: 0.62 },
  { role: "RB", duty: "support", x: 0.25, y: 0.85 },
  { role: "DM", duty: "defend", x: 0.4, y: 0.5 },
  { role: "CM", duty: "support", x: 0.52, y: 0.3 },
  { role: "CM", duty: "support", x: 0.52, y: 0.7 },
  { role: "LW", duty: "attack", x: 0.75, y: 0.15 },
  { role: "ST", duty: "attack", x: 0.82, y: 0.5 },
  { role: "RW", duty: "attack", x: 0.75, y: 0.85 },
];

/** 역할별 행동 파라미터 — 사람이 읽고 고칠 수 있게 표로 둔다(난수 없음, 전 유저 동일). */
const BEHAVIOR_BY_ROLE = {
  GK: { positioningFreedom: 0.1, forwardRunFreq: 0.02, widthTendency: 0.1, supportDepth: 0.05, pressAggression: 0.1, passRisk: 0.2, passDirectness: 0.55, dribbleTendency: 0.05, shootTendency: 0.01 },
  LB: { positioningFreedom: 0.4, forwardRunFreq: 0.45, widthTendency: 0.8, supportDepth: 0.45, pressAggression: 0.55, passRisk: 0.35, passDirectness: 0.45, dribbleTendency: 0.35, shootTendency: 0.1 },
  RB: { positioningFreedom: 0.4, forwardRunFreq: 0.45, widthTendency: 0.8, supportDepth: 0.45, pressAggression: 0.55, passRisk: 0.35, passDirectness: 0.45, dribbleTendency: 0.35, shootTendency: 0.1 },
  CB: { positioningFreedom: 0.15, forwardRunFreq: 0.1, widthTendency: 0.25, supportDepth: 0.15, pressAggression: 0.5, passRisk: 0.25, passDirectness: 0.5, dribbleTendency: 0.12, shootTendency: 0.05 },
  DM: { positioningFreedom: 0.3, forwardRunFreq: 0.25, widthTendency: 0.3, supportDepth: 0.35, pressAggression: 0.65, passRisk: 0.3, passDirectness: 0.45, dribbleTendency: 0.25, shootTendency: 0.15 },
  CM: { positioningFreedom: 0.5, forwardRunFreq: 0.5, widthTendency: 0.4, supportDepth: 0.6, pressAggression: 0.55, passRisk: 0.45, passDirectness: 0.4, dribbleTendency: 0.45, shootTendency: 0.3 },
  LW: { positioningFreedom: 0.6, forwardRunFreq: 0.7, widthTendency: 0.8, supportDepth: 0.75, pressAggression: 0.45, passRisk: 0.5, passDirectness: 0.4, dribbleTendency: 0.7, shootTendency: 0.55 },
  RW: { positioningFreedom: 0.6, forwardRunFreq: 0.7, widthTendency: 0.8, supportDepth: 0.75, pressAggression: 0.45, passRisk: 0.5, passDirectness: 0.4, dribbleTendency: 0.7, shootTendency: 0.55 },
  ST: { positioningFreedom: 0.55, forwardRunFreq: 0.8, widthTendency: 0.3, supportDepth: 0.85, pressAggression: 0.5, passRisk: 0.45, passDirectness: 0.4, dribbleTendency: 0.6, shootTendency: 0.85 },
};

const HOME_TEAM = {
  formation: FORMATION,
  defensiveLineHeight: 0.55,
  compactness: 0.55,
  tempo: 0.6,
  width: 0.6,
  pressingScheme: { intensity: 0.6, triggerLine: 0.55 },
  offsideTrap: false,
};
// 상대는 낮은 블록·낮은 템포 — 튜토리얼은 이기는 경기라(hero) 성향으로도 그 방향을 잡는다.
const AWAY_TEAM = {
  formation: FORMATION,
  defensiveLineHeight: 0.35,
  compactness: 0.6,
  tempo: 0.4,
  width: 0.4,
  pressingScheme: { intensity: 0.35, triggerLine: 0.3 },
  offsideTrap: false,
};

// ── 시드 파생 (server `Hashes` 와 동일해야 한다) ───────────────────────────
function deriveUint64Seed(input) {
  const digest = createHash("sha256").update(input, "utf8").digest();
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v = (v << 8n) | BigInt(digest[i]);
  }
  return v.toString(10);
}
const halfSeed = (matchSeed, half) => deriveUint64Seed(`${matchSeed}:h${half}`);
const jobSeed = (matchSeed, half, side) => deriveUint64Seed(`${matchSeed}:h${half}:${side}`);

// ── 로스터 조립 ───────────────────────────────────────────────────────────
const catalog = new Map(JSON.parse(readFileSync(PLAYERS_FILE, "utf8")).map((p) => [p.id, p]));
const bots = JSON.parse(readFileSync(resolve(REPO, "data/players/bots.v4.json"), "utf8"));
const awayBot = bots.find((b) => b.id === AWAY_BOT);
if (!awayBot) throw new Error(`away bot not found: ${AWAY_BOT}`);

// ── 로스터 검증 (#493 W10) ────────────────────────────────────────────────
// 로스터를 손으로 고칠 수 있게 표로 뒀으니(위) **표가 틀리면 굽기 전에 죽는다**. 세 가지를 본다:
//   ① 자리(카탈로그 포지션 ↔ SLOT_POSITIONS) ② `active`(비활성이면 신규 유저 카탈로그에 없다)
//   ③ 아트 겹침(같은 아트 파일이 한 경기에 두 번 나오지 않는다 — hero W10 지시).
// 아트 매핑은 `data/players/player-chars.v2.json` 을 **읽기만** 한다(data 는 owned-glob 밖).
const CHARS_FILE = resolve(REPO, "data/players/player-chars.v2.json");
const charDetail = new Map(
  JSON.parse(readFileSync(CHARS_FILE, "utf8")).detail.map((d) => [d.playerId, d]),
);
/** 그 선수가 **개별/차별화 아트**를 갖나 = 등급 공용 기본 유닛이 아닌가. */
const artOf = (id) => {
  const d = charDetail.get(id);
  if (!d || d.rule === "grade-default-unit") return null;
  return `${d.axis}/${d.id}`;
};

function validateRoster(side, ids) {
  if (ids.length !== SLOTS.length) {
    throw new Error(`${side}: 선발이 ${ids.length}명입니다(${SLOTS.length} 이어야 합니다)`);
  }
  ids.forEach((id, i) => {
    const p = catalog.get(id);
    if (!p) throw new Error(`${side}[${i}] ${id}: 카탈로그에 없습니다`);
    if (p.position !== SLOT_POSITIONS[i]) {
      throw new Error(`${side}[${i}] ${id} ${p.name}: 포지션 ${p.position} 이 슬롯 `
        + `${SLOTS[i].role}(${SLOT_POSITIONS[i]}) 와 맞지 않습니다`);
    }
    // 비활성 선수는 `GET /api/players` 가 잘라내므로 화면에서 이름·등급·얼굴이 통째로 빈다.
    if (p.active === false) throw new Error(`${side}[${i}] ${id} ${p.name}: active=false 라 쓸 수 없습니다`);
  });
}
validateRoster("home", HOME_STARTERS);
validateRoster("away", AWAY_STARTERS);

const dupArt = new Map();
for (const id of [...HOME_STARTERS, ...AWAY_STARTERS]) {
  const art = artOf(id);
  if (!art) continue;
  if (dupArt.has(art)) {
    throw new Error(`아트 중복: ${art} 를 ${dupArt.get(art)} 와 ${id} 가 같이 씁니다`);
  }
  dupArt.set(art, id);
}
console.log(`[bake] 로스터 검증 OK — 차별화 아트 ${dupArt.size}종(중복 0), `
  + `home ${HOME_STARTERS.filter(artOf).length}/11 · away ${AWAY_STARTERS.filter(artOf).length}/11`);

function card(playerId) {
  const p = catalog.get(playerId);
  if (!p) throw new Error(`catalog miss: ${playerId}`);
  return { playerId: p.id, name: p.name, position: p.position, attributes: p.attributes };
}

function playerInputs(ids, seedForMeta) {
  return ids.map((id, i) => {
    const slot = SLOTS[i];
    return {
      playerId: id,
      role: slot.role,
      duty: slot.duty,
      basePosition: { x: slot.x, y: slot.y },
      behavior: BEHAVIOR_BY_ROLE[slot.role],
      mentalModifier: 0,
    };
  });
}

const selectData = {
  home: { name: HOME_NAME, players: HOME_STARTERS.map(card) },
  away: { name: awayBot.name ?? AWAY_NAME_FALLBACK, players: AWAY_STARTERS.map(card) },
};

function inputFor(side, matchSeed, half) {
  const ids = side === "home" ? HOME_STARTERS : AWAY_STARTERS;
  return {
    seed: jobSeed(matchSeed, half, side),
    team: side === "home" ? HOME_TEAM : AWAY_TEAM,
    players: playerInputs(ids),
    meta: { promptHash: `tutorial:${side}` },
  };
}

async function simulate(body) {
  const res = await fetch(`${RUNNER}/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`runner HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

/** 한 matchSeed 로 전·후반을 이어 돌린다(교체 없음 = h1 resumeState 승계, 서버 경로와 동일). */
async function playMatch(matchSeed) {
  const h1 = await simulate({
    seed: halfSeed(matchSeed, 1),
    selectData,
    homeInput: inputFor("home", matchSeed, 1),
    awayInput: inputFor("away", matchSeed, 1),
    half: 1,
  });
  const h2 = await simulate({
    seed: halfSeed(matchSeed, 2),
    selectData,
    homeInput: inputFor("home", matchSeed, 2),
    awayInput: inputFor("away", matchSeed, 2),
    half: 2,
    resumeState: h1.resumeState,
  });
  const total = {
    home: h1.matchLog.finalScore.home + h2.matchLog.finalScore.home,
    away: h1.matchLog.finalScore.away + h2.matchLog.finalScore.away,
  };
  return { h1, h2, total };
}

/**
 * 승리 판정 — 단순히 "이긴다"만 보면 1:0 지루한 경기가 뽑힐 수 있어 튜토리얼로서의 조건을 같이 건다.
 * (골이 하나도 안 나는 하프가 있으면 관전 튜토리얼의 절반이 무의미해진다.)
 */
function acceptable(r) {
  const margin = r.total.home - r.total.away;
  const total = r.total.home + r.total.away;
  const win = margin >= 2;              // 아슬아슬한 1점차는 "이겼다"가 한눈에 안 읽힌다
  const goals = r.total.home >= 2;      // 내 팀 골 장면이 최소 둘
  const conceded = r.total.away <= 2;   // 난타전이면 "이기는 경기"라는 인상이 흐려진다
  const h1Goal = r.h1.matchLog.finalScore.home >= 1; // 전반(탭 투어 구간)에도 볼 것이 있어야 한다
  // #493 W10 — **볼거리 밴드**: 구 자산(4:2)과 같은 급으로 좁힌다. 로스터를 LEGEND/DIA 로 갈면서
  // home 이 훨씬 강해져 조건을 안 좁히면 6:0·7:0 같은 무미건조한 학살이 먼저 걸린다(실측: 그런
  // 시드가 앞쪽에 있다). 총 4~6골 · 상대도 최소 1골 = "이기지만 경기가 흐르는" 그림.
  const band = total >= 4 && total <= 6;
  const awayScores = r.total.away >= 1;
  return win && goals && conceded && h1Goal && band && awayScores;
}

const seedHex = (n) => createHash("sha256").update(`hmb-tutorial:${n}`).digest("hex").slice(0, 32);

async function main() {
  console.log(`[bake] runner=${RUNNER} scan<=${MAX_SEEDS}`);
  const scanLog = [];
  let picked = null;
  for (let n = 0; n < MAX_SEEDS; n++) {
    const matchSeed = seedHex(n);
    const r = await playMatch(matchSeed);
    const line = `#${n} seed=${matchSeed} h1=${r.h1.matchLog.finalScore.home}:${r.h1.matchLog.finalScore.away}`
      + ` h2=${r.h2.matchLog.finalScore.home}:${r.h2.matchLog.finalScore.away}`
      + ` total=${r.total.home}:${r.total.away} ${acceptable(r) ? "ACCEPT" : "-"}`;
    console.log(line);
    scanLog.push(line);
    if (acceptable(r) && !picked) {
      picked = { n, matchSeed, r };
      // SCAN_ALL=1 이면 멈추지 않고 격자를 끝까지 훑는다(증빙·밴드 튜닝용). **고르는 규칙은
      // 그래도 "첫 ACCEPT"** 라 결과는 같다 — 로그만 길어진다.
      if (process.env.SCAN_ALL !== "1") break;
    }
  }
  if (!picked) throw new Error(`승리 조건을 만족하는 시드를 ${MAX_SEEDS}회 안에 찾지 못했습니다`);

  const { matchSeed, r } = picked;
  const asset = {
    assetVersion: 1,
    matchSeed,
    // 상대 봇 id 를 **자산이 들고 있는다** — 서버 config 에 따로 적으면 자산을 다시 구울 때
    // 두 곳이 조용히 갈라지고, 화면의 상대 이름이 실제로 시뮬한 로스터와 달라진다.
    awayBotId: AWAY_BOT,
    bakedAt: new Date().toISOString(),
    engineVersion: r.h1.matchLog.configVersion ?? "unknown",
    finalScore: r.total,
    selectData,
    halves: [1, 2].map((half) => {
      const src = half === 1 ? r.h1 : r.h2;
      return {
        half,
        halfSeed: halfSeed(matchSeed, half),
        homeInput: inputFor("home", matchSeed, half),
        awayInput: inputFor("away", matchSeed, half),
        matchLog: src.matchLog,
        resumeState: src.resumeState ?? null,
        lastHash: src.lastHash ?? null,
        playbackMs: src.playbackMs ?? 0,
        effectiveConfigHash: src.effectiveConfigHash ?? null,
        score: src.matchLog.finalScore,
      };
    }),
  };

  if (process.env.SCAN_ONLY === "1") {
    console.log("[bake] SCAN_ONLY=1 — 쓰지 않고 종료");
    return;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  const json = JSON.stringify(asset);
  const gz = gzipSync(Buffer.from(json, "utf8"), { level: 9 });
  writeFileSync(OUT, gz);
  console.log(`[bake] wrote ${OUT} (raw ${(json.length / 1024 / 1024).toFixed(2)} MB → gz `
    + `${(gz.length / 1024).toFixed(0)} KB)`);
  console.log(`[bake] seed=${matchSeed} score=${r.total.home}:${r.total.away} engine=${asset.engineVersion}`);
  console.log(`[bake] playbackMs h1=${asset.halves[0].playbackMs} h2=${asset.halves[1].playbackMs}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

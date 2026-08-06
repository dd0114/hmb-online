#!/usr/bin/env node
/**
 * #450 은퇴 보상 우편 집행 ops — 산출(dry-run) + 발송.
 *
 * 산식 SoT = `docs/plan-v5/roster-v27-spec.md` §4 (R1 판, hero 결정 H6).
 *   sub(X) = X 와 같은 (등급, 포지션) 칸의 **잔류(active) 카드** 중 `fit` 최근접 (동률이면 id 오름차순)
 *   fit    = Σ economy.growth.baselineByPosition[pos][stat] × attributes[stat]   ← 게임 자신의 정의를 그대로 쓴다
 *   N      = user_players.count + copies_used        ← 성★ 에 태운 중복까지 되돌려준다
 *   지급    = PlayerGrant(sub(X), N × MULT), MULT = 3
 *   폴백    = sub(X) 가 없으면 gems += G(grade) × N   ← 20칸 전부 잔류 ≥1 이라 이번엔 무발화
 *
 * ⚠️ 카탈로그·보유는 **라이브 DB 읽기 전용 사본**에서 읽는다(라이브 무접촉). 서버가 만든 것을
 *    TS 로 재구현하지 않는다 — `players` 테이블과 발행 `economy` 를 그대로 소비한다.
 *
 * ⚠️ 한 우편 캠페인 = **단일 payload**(`AdminMailService`). 유저마다 첨부가 다르므로
 *    payload 가 같은 유저끼리 묶어 캠페인 수를 줄인다(`audience=USERS`, 최대 500명/캠페인).
 *
 * 사용:
 *   node infra/reward-450-retire.mjs --db <읽기전용사본.db> [--out plan.json]
 *   node infra/reward-450-retire.mjs --plan plan.json --send --api <base> --token <bearer>
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MULT = 3;
// §4-1 — 뽑기 가격 역산. R-2 폴백 전용(이번 개편에서는 무발화).
const GEMS_BY_GRADE = { BRONZE: 600, SILVER: 900, GOLD: 1800, DIA: 3400, LEGEND: 13600 };
// AdminMailService 하드 상한(MailProperties). 넘으면 발송이 400 이다 — 산출 단계에서 먼저 막는다.
const LIMIT = { playerKinds: 10, playerCount: 99, userIds: 500 };

const args = parseArgs(process.argv.slice(2));

if (args.send) {
  await send(JSON.parse(fs.readFileSync(args.plan, 'utf8')), args);
} else {
  const plan = build(args.db);
  const out = args.out ?? path.join(path.dirname(args.db), 'plan.json');
  fs.writeFileSync(out, JSON.stringify(plan, null, 2));
  report(plan);
  console.log(`\nplan → ${out}`);
}

// ── 산출 ────────────────────────────────────────────────────────────────────

function build(db) {
  if (!db) die('--db <읽기전용 DB 사본 경로> 가 필요하다');
  assertCheckpointed(db);
  const players = sql(db, 'select id,name,short_name,position,grade,attributes_json,active from players');
  const rows = sql(db, 'select user_id,player_id,count,copies_used from user_players');
  const userCount = sql(db, 'select count(*) n from users')[0].n;

  const baseline = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data/players/economy.v4.json'), 'utf8'),
  ).growth.baselineByPosition;

  const cat = new Map();
  for (const p of players) {
    const attrs = JSON.parse(p.attributes_json);
    const w = baseline[p.position];
    const fit = Object.entries(w).reduce((s, [k, v]) => s + v * (attrs[k] ?? 0), 0);
    cat.set(p.id, {
      id: p.id, name: p.name, shortName: p.short_name,
      pos: p.position, grade: p.grade, active: p.active === 1, fit,
    });
  }

  // sub(X): 같은 칸의 잔류 카드 중 fit 최근접 · 동률이면 id 오름차순
  const sub = new Map();
  for (const x of cat.values()) {
    if (x.active) continue;
    const pool = [...cat.values()].filter((c) => c.active && c.grade === x.grade && c.pos === x.pos);
    if (!pool.length) { sub.set(x.id, null); continue; }
    pool.sort((a, b) => Math.abs(a.fit - x.fit) - Math.abs(b.fit - x.fit) || a.id.localeCompare(b.id));
    sub.set(x.id, pool[0].id);
  }

  // 유저별 합산 — 같은 sub(X) 로 모이는 여러 은퇴 카드는 한 항목으로 합친다
  const byUser = new Map();
  let lostTotal = 0, lostRows = 0;
  for (const r of rows) {
    const x = cat.get(r.player_id);
    if (!x || x.active) continue;
    const n = r.count + r.copies_used;
    lostTotal += n; lostRows += 1;
    const u = byUser.get(r.user_id) ?? { userId: r.user_id, grants: new Map(), gems: 0, lost: 0, sources: [] };
    const s = sub.get(x.id);
    if (s) u.grants.set(s, (u.grants.get(s) ?? 0) + n * MULT);
    else u.gems += (GEMS_BY_GRADE[x.grade] ?? 0) * n;
    u.lost += n;
    u.sources.push({ from: x.id, to: s, n });
    byUser.set(r.user_id, u);
  }

  const users = [...byUser.values()]
    .map((u) => ({
      userId: u.userId,
      lost: u.lost,
      gems: u.gems,
      // 표시 안정성: id 오름차순 (재실행 멱등 — payload 해시가 순서로 흔들리면 안 된다)
      players: [...u.grants.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([playerId, count]) => ({ playerId, count })),
      sources: u.sources.sort((a, b) => a.from.localeCompare(b.from)),
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));

  // ⚠️ 한 통에 담을 수 있는 카드 **종류**는 10 이 상한이다(MailProperties.maxPlayerKinds).
  // 스펙 §4-5 는 "20종 안쪽"이라 적었지만 그건 서버 상한이 10 인 것을 안 본 값이다(실측 최대 20종).
  // 그래서 종류가 넘치는 유저는 **우편을 나눈다** — 받는 총량은 그대로다(상한을 올려 재배포하는
  // 쪽은 배포 열차를 다시 태워야 하고 되돌림 비용이 크다).
  const parcels = [];
  for (const u of users) {
    const chunks = [];
    for (let i = 0; i < u.players.length; i += LIMIT.playerKinds) {
      chunks.push(u.players.slice(i, i + LIMIT.playerKinds));
    }
    if (!chunks.length) chunks.push([]);
    u.parts = chunks.length;
    chunks.forEach((players, i) => {
      parcels.push({
        userId: u.userId,
        part: i + 1,
        parts: chunks.length,
        // 젬은 첫 통에만 싣는다(나눠 실으면 합산 검산이 어려워진다). 이번 개편에선 전원 0.
        attachments: { points: 0, gems: i === 0 ? u.gems : 0, players },
      });
    });
  }

  // payload + 분할 표기가 같은 유저끼리 묶기 → 캠페인
  const groups = new Map();
  for (const p of parcels) {
    const key = JSON.stringify({ part: p.part, parts: p.parts, att: p.attachments });
    const g = groups.get(key) ?? { attachments: p.attachments, part: p.part, parts: p.parts, userIds: [] };
    g.userIds.push(p.userId);
    groups.set(key, g);
  }
  const campaigns = [];
  for (const g of groups.values()) {
    // 500명 상한에서 자른다(현재 규모에선 발생하지 않지만, 잘리면 조용히가 아니라 캠페인이 늘어야 한다)
    for (let i = 0; i < g.userIds.length; i += LIMIT.userIds) {
      campaigns.push({
        attachments: g.attachments, part: g.part, parts: g.parts,
        userIds: g.userIds.slice(i, i + LIMIT.userIds),
      });
    }
  }
  campaigns.sort((a, b) => b.userIds.length - a.userIds.length || a.userIds[0].localeCompare(b.userIds[0]));
  campaigns.forEach((c, i) => {
    c.seq = i + 1;
    // 멱등키 = 내용의 함수. 두 번 돌려도 같은 키 → 서버가 200 재생(추가 발송 0).
    c.idempotencyKey = `retire-reward-450-${sha(JSON.stringify({ a: c.attachments, p: c.part, u: c.userIds })).slice(0, 24)}`;
  });

  // 상한 검사는 **실제로 보낼 한 통** 기준이다(분할 후).
  const violations = [];
  for (const c of campaigns) {
    if (c.attachments.players.length > LIMIT.playerKinds) {
      violations.push({ seq: c.seq, kinds: c.attachments.players.length });
    }
    if (c.userIds.length > LIMIT.userIds) violations.push({ seq: c.seq, users: c.userIds.length });
    for (const p of c.attachments.players) {
      if (p.count > LIMIT.playerCount) violations.push({ seq: c.seq, playerId: p.playerId, count: p.count });
    }
  }
  // 검산 — 분할·묶기를 거친 뒤에도 유저별 지급이 산식 결과와 정확히 같아야 한다.
  const backSum = new Map();
  for (const c of campaigns) {
    for (const uid of c.userIds) {
      const m = backSum.get(uid) ?? new Map();
      for (const p of c.attachments.players) m.set(p.playerId, (m.get(p.playerId) ?? 0) + p.count);
      backSum.set(uid, m);
    }
  }
  for (const u of users) {
    const m = backSum.get(u.userId) ?? new Map();
    const same = u.players.length === m.size && u.players.every((p) => m.get(p.playerId) === p.count);
    if (!same) violations.push({ userId: u.userId, reason: 'campaign 합산 ≠ 산식 결과' });
  }

  return {
    generatedFrom: path.resolve(db),
    mult: MULT,
    catalog: {
      total: cat.size,
      active: [...cat.values()].filter((c) => c.active).length,
      retired: [...cat.values()].filter((c) => !c.active).length,
    },
    live: { users: userCount, retiredRows: lostRows, retiredCards: lostTotal },
    subMap: [...sub.entries()].sort().map(([from, to]) => ({
      from, fromName: cat.get(from).name, grade: cat.get(from).grade, pos: cat.get(from).pos,
      to, toName: to ? cat.get(to).name : null,
    })),
    totals: {
      recipients: users.length,
      grantedCards: users.reduce((s, u) => s + u.players.reduce((t, p) => t + p.count, 0), 0),
      grantedGems: users.reduce((s, u) => s + u.gems, 0),
      campaigns: campaigns.length,
    },
    violations,
    users,
    campaigns,
  };
}

function report(plan) {
  const per = plan.users.map((u) => u.players.reduce((t, p) => t + p.count, 0)).sort((a, b) => a - b);
  const kinds = plan.users.map((u) => u.players.length).sort((a, b) => a - b);
  const byCard = new Map();
  for (const u of plan.users) for (const p of u.players) byCard.set(p.playerId, (byCard.get(p.playerId) ?? 0) + p.count);

  console.log(`# #450 은퇴 보상 dry-run  (MULT=${plan.mult})`);
  console.log(`원천: ${plan.generatedFrom}`);
  console.log(`카탈로그: ${plan.catalog.total}종 (활성 ${plan.catalog.active} / 은퇴 ${plan.catalog.retired})`);
  console.log(`라이브: 유저 ${plan.live.users}명 · 은퇴카드 보유 ${plan.live.retiredRows}행 / ${plan.live.retiredCards}장`);
  console.log(`지급: 카드 ${plan.totals.grantedCards}장 · 젬 ${plan.totals.grantedGems} · 수령자 ${plan.totals.recipients}명 · 캠페인 ${plan.totals.campaigns}통`);
  console.log(`1인 지급량: 중앙값 ${med(per)} / 평균 ${(per.reduce((a, b) => a + b, 0) / per.length).toFixed(1)} / 최대 ${per.at(-1)}`);
  console.log(`1인 항목수: 중앙값 ${med(kinds)} / 최대 ${kinds.at(-1)}  (한 통 상한 ${LIMIT.playerKinds} → 넘치면 분할)`);
  console.log(`분할 유저: ${plan.users.filter((u) => u.parts > 1).length}명 (2통 수령)`);
  console.log(`항목 최대 장수: ${Math.max(...plan.users.flatMap((u) => u.players.map((p) => p.count)))}  (상한 ${LIMIT.playerCount})`);
  console.log(`상한 위반: ${plan.violations.length}건`);
  console.log('\n상위 지급 카드:');
  for (const [id, n] of [...byCard].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${id}  ${String(n).padStart(5)}장`);
  }
  console.log('\n캠페인:');
  for (const c of plan.campaigns.slice(0, 12)) {
    const p = c.attachments.players.map((x) => `${x.playerId}×${x.count}`).join(' ');
    console.log(`  #${String(c.seq).padStart(3)}  ${String(c.userIds.length).padStart(3)}명  (${c.part}/${c.parts})  gems ${c.attachments.gems}  ${p}`);
  }
  if (plan.campaigns.length > 12) console.log(`  … 외 ${plan.campaigns.length - 12}통`);
}

// ── 발송 ────────────────────────────────────────────────────────────────────

async function send(plan, a) {
  if (!a.api || !a.token) die('--api <base URL> 과 --token <bearer> 가 필요하다');
  if (plan.violations.length) die(`상한 위반 ${plan.violations.length}건 — 발송 중단`);
  const title = a.title ?? '로스터 개편 보상';
  const body = a.body ?? [
    '로스터 개편으로 일부 선수 카드가 비활성화되었습니다.',
    '보유하고 계셨던 카드는 같은 등급·포지션의 잔류 선수 카드로 3배 지급됩니다.',
    '그동안 성장에 사용한 중복 카드까지 함께 보상되었습니다. 감사합니다.',
  ].join('\n');

  const log = [];
  for (const c of plan.campaigns) {
    const res = await fetch(`${a.api}/api/admin/mails`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${a.token}`,
        'Idempotency-Key': c.idempotencyKey,
      },
      body: JSON.stringify({
        audience: 'USERS', userIds: c.userIds,
        // 분할된 유저는 두 통을 받는다 — 제목에 그 사실을 적어 "왜 두 통이지"를 없앤다.
        title: c.parts > 1 ? `${title} (${c.part}/${c.parts})` : title,
        body,
        attachments: c.attachments, reason: '#450 로스터 v2.7 은퇴 카드 보상 (MULT=3)',
      }),
    });
    const txt = await res.text();
    const line = { seq: c.seq, status: res.status, users: c.userIds.length, key: c.idempotencyKey, res: txt };
    log.push(line);
    console.log(`#${String(c.seq).padStart(3)}  HTTP ${res.status}  ${c.userIds.length}명  ${txt.slice(0, 200)}`);
    if (res.status !== 201 && res.status !== 200) die(`캠페인 #${c.seq} 실패 — 중단(이후 캠페인은 보내지 않는다)`);
  }
  const out = a.out ?? path.join(path.dirname(a.plan), 'send-log.json');
  fs.writeFileSync(out, JSON.stringify(log, null, 2));
  console.log(`\nsend log → ${out}`);
}

// ── 유틸 ────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **`immutable=1` 로 열지 마라 — WAL 을 통째로 무시한다.**
 * 이번에 실측했다: 같은 사본을 `immutable=1` 로 열면 `mail_campaigns` 가 **5**, `mode=ro` 로 열면 **38** 이다.
 * 즉 최근 쓰기가 아직 WAL 에 있으면 조용히 **낡은 DB** 를 읽는다 — 보상 산출이 그 위에서 돌면
 * 최근 가입자·최근 획득분이 통째로 누락되고, 실패하지 않으므로 **아무도 모른다.**
 * (`immutable=1` 은 `-shm` 짝이 없는 백업 파일을 열 때의 우회책이고, 이 경로의 기본값이 아니다.)
 *
 * 그래서 여는 것은 `mode=ro` 이고, **여는 순간 WAL 체크포인트 여부를 검사**한다 — 두 모드가 다른
 * 값을 주면 사본이 체크포인트되지 않은 것이므로 **멈춘다**(조용히 낡은 값을 쓰느니 실패한다).
 */
function sql(db, q) {
  const out = execFileSync('sqlite3', [`file:${db}?mode=ro`, '-json', q], {
    encoding: 'utf8', maxBuffer: 1 << 28,
  });
  return out.trim() ? JSON.parse(out) : [];
}

/** 사본이 WAL 을 품고 있는지 — 두 읽기 모드가 다른 답을 주면 그 사본은 신뢰할 수 없다. */
function assertCheckpointed(db) {
  const probe = 'select count(*) n from user_players';
  const ro = JSON.parse(execFileSync('sqlite3', [`file:${db}?mode=ro`, '-json', probe], { encoding: 'utf8' }))[0].n;
  let im;
  try {
    im = JSON.parse(execFileSync('sqlite3', [`file:${db}?immutable=1`, '-json', probe], { encoding: 'utf8' }))[0].n;
  } catch { return; } // immutable 로 못 열면 비교 대상이 없다 — mode=ro 값이 유일한 답이다
  if (ro !== im) {
    die(`사본이 체크포인트되지 않았다 (mode=ro ${ro} ≠ immutable ${im}). `
      + `sqlite3 <사본> 'PRAGMA wal_checkpoint(TRUNCATE)' 로 접은 뒤 다시 돌려라`);
  }
}
function sha(s) { return createHash('sha256').update(s).digest('hex'); }
function med(a) { return a[Math.floor(a.length / 2)]; }
function die(m) { console.error(`✗ ${m}`); process.exit(1); }
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const name = k.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { o[name] = next; i += 1; } else o[name] = true;
  }
  return o;
}

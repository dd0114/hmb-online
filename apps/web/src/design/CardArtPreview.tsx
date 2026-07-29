import { useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { CharAvatar } from "../common/CharAvatar";
import { FullArtCard } from "../common/FullArtCard";
import { GRADE_COLORS, GRADE_LABELS, GRADE_ORDER, type Grade } from "../common/grades";
import styles from "./CardArtPreview.module.css";

/**
 * `/design/cards` — 카드 풀아트 일러스트(#187) **배치안 리뷰 전용 프리뷰**. dev 빌드에만 존재한다
 * (App.tsx `import.meta.env.DEV` 가드).
 *
 * 왜 필요한가: hero 게이트가 "구현 착수 전, 어느 화면에 어떤 크기로 넣을지 실제 화면으로 보고
 * 컨펌"이다. 제품 화면은 아직 **안 건드렸다** — 여기 있는 건 제품 컴포넌트(`FullArtCard`)를
 * 쓰되 배치만 흉내 낸 **제안 목업**이고, 컨펌된 안만 웨이브2에서 실제 화면에 배선한다.
 *
 * 데이터는 `data/players/players.v2.1.json` 에서 뽑은 실제 선수 12명(등급·포지션·매핑 그대로).
 * API·백엔드 불필요 — 에셋만 `/chars/`(build:chars 스테이징)에서 받는다.
 */

interface P {
  id: string;
  name: string;
  position: string;
  grade: Grade;
}

/**
 * 실제 시드에서 등급·포지션이 고루 섞이게 고른 12명(발행물 `players.v2.1.json` 원문 값).
 * 인덱스가 아니라 **이름 키**로 참조한다 — 목업 배열 순서를 바꿔도 어느 선수를 가리키는지
 * 코드에서 그대로 읽히고, 인덱스 접근(`noUncheckedIndexedAccess`)도 안 생긴다.
 */
const R = {
  yashin: { id: "P001", name: "Lev Yashin", position: "GK", grade: "LEGEND" },
  beckenbauer: { id: "P002", name: "Franz Beckenbauer", position: "DF", grade: "LEGEND" },
  maldini: { id: "P003", name: "Paolo Maldini", position: "DF", grade: "LEGEND" },
  maradona: { id: "P008", name: "Diego Maradona", position: "MF", grade: "LEGEND" },
  pele: { id: "P011", name: "Pelé", position: "FW", grade: "LEGEND" },
  alisson: { id: "P013", name: "Alisson", position: "GK", grade: "DIA" },
  vandijk: { id: "P015", name: "Virgil van Dijk", position: "DF", grade: "DIA" },
  debruyne: { id: "P027", name: "Kevin De Bruyne", position: "MF", grade: "DIA" },
  oblak: { id: "P040", name: "Jan Oblak", position: "GK", grade: "GOLD" },
  valverde: { id: "P055", name: "Federico Valverde", position: "MF", grade: "GOLD" },
  martinez: { id: "P080", name: "Lisandro Martínez", position: "DF", grade: "SILVER" },
  lewis: { id: "P118", name: "Rico Lewis", position: "DF", grade: "BRONZE" },
  tete: { id: "P130", name: "Kenny Tete", position: "DF", grade: "BRONZE" },
} satisfies Record<string, P>;

const ROSTER: P[] = Object.values(R);

/** 뽑기 10+1 목업 — 실제 확률과 비슷한 분포(하위 다수 + 상위 소수, 마지막이 천장 LEGEND). */
const PULL: P[] = [
  R.lewis, R.martinez, R.tete, R.oblak, R.martinez, R.debruyne,
  R.lewis, R.valverde, R.alisson, R.tete, R.pele,
];

/** 좁은 칸에 쓰는 성(姓)만. 공백이 없으면 이름 전체(한글 대응). */
const lastName = (n: string) => n.trim().split(/\s+/).pop() ?? n;

/** 인덱스 접근 대신 쓰는 안전 슬라이스 — `P[]` 를 그대로 돌려준다. */
const some = (n: number) => ROSTER.slice(0, n);

const SECTIONS = [
  { key: "matrix", label: "① 크기·등급 매트릭스" },
  { key: "gacha", label: "② 뽑기 연출 (A/B/C안)" },
  { key: "codex", label: "③ 도감 상세" },
  { key: "deck", label: "④ 덱 선수 상세" },
  { key: "trade", label: "⑤ 트레이드" },
  { key: "icons", label: "⑥ 아이콘 유지 경계" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

export function CardArtPreview() {
  const [params, setParams] = useSearchParams();
  const framed = params.get("frame") === "phone";
  const section = (SECTIONS.find((s) => s.key === params.get("s"))?.key ?? "matrix") as SectionKey;

  const go = (next: string, key = "s") => {
    const p = new URLSearchParams(params);
    p.set(key, next);
    setParams(p, { replace: true });
  };

  if (framed) {
    const inner = new URLSearchParams(params);
    inner.delete("frame");
    return (
      <div className={styles.frameWrap}>
        <div className={styles.frameHead}>
          <span className={styles.frameTitle}>📱 390 × 844 (모바일) — 가로 스크롤 0 확인용</span>
          <a className={styles.chip} href={`/design/cards?s=${section}`}>
            🖥 데스크탑
          </a>
        </div>
        <iframe className={styles.phone} title="모바일 프리뷰" src={`/design/cards?${inner.toString()}`} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.h1}>#187 카드 풀아트 배치안</h1>
        <nav className={styles.tabs}>
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`${styles.chip} ${s.key === section ? styles.chipOn : ""}`}
              onClick={() => go(s.key)}
            >
              {s.label}
            </button>
          ))}
          <a className={styles.chip} href={`/design/cards?s=${section}&frame=phone`}>
            📱 모바일 390
          </a>
        </nav>
      </header>

      {section === "matrix" && <Matrix />}
      {section === "gacha" && <Gacha />}
      {section === "codex" && <Codex />}
      {section === "deck" && <Deck />}
      {section === "trade" && <Trade />}
      {section === "icons" && <Icons />}
    </div>
  );
}

// ── ① 크기·등급 매트릭스 ─────────────────────────────────────────────────────

const SIZES = [
  { w: 96, label: "96 (xs — 그리드 4열)" },
  { w: 120, label: "120 (sm — 그리드 3열/모바일)" },
  { w: 160, label: "160 (md — 상세 인라인)" },
  { w: 220, label: "220 (lg — 원본 1:1)" },
  { w: 290, label: "290 (xl — 스포트라이트)" },
];

function Matrix() {
  return (
    <section className={styles.sec}>
      <Note>
        <b>합성 방식</b>: 등급 프레임(<code>frame-&lt;GRADE&gt;.png</code> — 테두리색·별 개수)
        위에 캐릭터 카드(<code>card-&lt;char&gt;.png</code>)의 <b>아트 영역만 잘라서</b> 얹는다.
        발행된 <code>card-*.png</code> 는 프레임이 구워져 있고 <b>별이 항상 5개</b>라 그대로 쓰면
        브론즈가 별 5개로 보인다 — 그래서 겹친다. 프레임리스 아트는 커밋돼 있지 않다(#145 잔여).
      </Note>
      <h2 className={styles.h2}>등급 5종 (같은 캐릭터, 프레임만 다름)</h2>
      <div className={styles.row}>
        {GRADE_ORDER.map((g) => (
          <figure key={g} className={styles.fig}>
            <FullArtCard artReviewExempt playerId={R.maldini.id} name={R.maldini.name} grade={g} position="DF" size={150} />
            <figcaption className={styles.cap}>
              {GRADE_LABELS[g]} · 별 {{ BRONZE: 2, SILVER: 3, GOLD: 4, DIA: 5, LEGEND: 6 }[g]}개
            </figcaption>
          </figure>
        ))}
      </div>

      <h2 className={styles.h2}>크기 5종 (도트 원본 226×425 — pixelated 유지)</h2>
      <div className={styles.rowBottom}>
        {SIZES.map((sz) => (
          <figure key={sz.w} className={styles.fig}>
            <FullArtCard artReviewExempt playerId={R.pele.id} name={R.pele.name} grade="LEGEND" position="FW" size={sz.w} />
            <figcaption className={styles.cap}>{sz.label}</figcaption>
          </figure>
        ))}
      </div>

      <h2 className={styles.h2}>캐릭터 12종 × 실제 매핑 (B안 — #145)</h2>
      <div className={styles.row}>
        {ROSTER.map((p) => (
          <figure key={p.id} className={styles.fig}>
            <FullArtCard artReviewExempt playerId={p.id} name={p.name} grade={p.grade} position={p.position} size={120} />
            <figcaption className={styles.cap}>{p.id}</figcaption>
          </figure>
        ))}
      </div>

      <h2 className={styles.h2}>폴백 (깨짐 0 — AC3)</h2>
      <div className={styles.rowBottom}>
        <figure className={styles.fig}>
          <FullArtCard artReviewExempt playerId={R.pele.id} name={R.pele.name} grade="LEGEND" position="FW" size={140} />
          <figcaption className={styles.cap}>1) 풀아트 — 매핑 O</figcaption>
        </figure>
        <figure className={styles.fig}>
          <FullArtCard artReviewExempt playerId="P_GHOST" name="Unmapped Player" grade="GOLD" position="MF" size={140} />
          <figcaption className={styles.cap}>2) 등급 프레임 + 아이콘 — 매핑 X (실제 렌더)</figcaption>
        </figure>
      </div>
      <Note>
        3단계(<code>/chars</code> 자체가 없어 프레임도 못 받는 경우 = 등급색 테두리 + CSS 이니셜)는
        여기서 <b>흉내 내지 않았다</b> — 이 프리뷰는 에셋이 있는 상태라 진짜가 아닌 그림이 된다.
        웨이브2에서 <b>라우트 차단 E2E 계약</b>(<code>/chars/**</code> abort)으로 박제한다.
      </Note>
    </section>
  );
}

// ── ② 뽑기 연출 ──────────────────────────────────────────────────────────────

function Gacha() {
  const [plan, setPlan] = useState<"A" | "B" | "C">("C");
  const [spot, setSpot] = useState(PULL.length - 1);
  /** 스포트라이트에 올라간 카드. 인덱스가 범위를 벗어날 일은 없지만 방어로 마지막 장을 쓴다. */
  const cur = PULL[spot] ?? R.pele;
  return (
    <section className={styles.sec}>
      <div className={styles.tabs}>
        {(["A", "B", "C"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`${styles.chip} ${plan === k ? styles.chipOn : ""}`}
            onClick={() => setPlan(k)}
          >
            {k}안
          </button>
        ))}
      </div>
      <Note>
        {plan === "A" && (
          <>
            <b>A안 — 그리드 전체 풀아트.</b> 11장을 3열(모바일)/4열(데스크탑) 미니 카드로. 한눈에
            다 보이지만 카드가 작아 일러스트가 잘 안 읽히고 세로가 길어진다.
          </>
        )}
        {plan === "B" && (
          <>
            <b>B안 — 스포트라이트만 풀아트.</b> 그리드는 현행 아이콘 유지, 공개할 때마다 위쪽에 큰
            카드 1장. 연출 임팩트 최대·로딩 최소지만, 다 공개한 뒤 결과를 훑을 땐 아이콘만 남는다.
          </>
        )}
        {plan === "C" && (
          <>
            <b>C안(권장) — 스포트라이트 + 풀아트 그리드.</b> 공개 중엔 큰 카드로 보여주고, 그리드도
            풀아트 미니 카드라 끝나고 훑을 때도 일러스트가 보인다. 탭하면 그 카드가 스포트라이트로
            올라온다. 비용 = 이미지 요청이 A안과 같다(카드 12종·프레임 5종이 전부라 캐시 후 0).
          </>
        )}
      </Note>

      <div className={styles.gachaSheet}>
        <h3 className={styles.h3}>뽑기 결과 (11명)</h3>
        {plan !== "A" && (
          <div className={styles.spotlight}>
            <FullArtCard artReviewExempt
              playerId={cur.id}
              name={cur.name}
              grade={cur.grade}
              position={cur.position}
              size={230}
            />
            <div className={styles.spotMeta}>
              <span className={styles.newBadge}>NEW</span>
              <b>{cur.name}</b>
              <span style={{ color: GRADE_COLORS[cur.grade] }}>{GRADE_LABELS[cur.grade]}</span>
              <span className={styles.dim}>{cur.position}</span>
            </div>
          </div>
        )}
        <div className={plan === "B" ? styles.iconGrid : styles.cardGrid}>
          {PULL.map((p, i) =>
            plan === "B" ? (
              <button
                key={i}
                type="button"
                className={styles.miniIcon}
                style={{ borderColor: GRADE_COLORS[p.grade] }}
                onClick={() => setSpot(i)}
              >
                <CharAvatar artReviewExempt playerId={p.id} name={p.name} grade={p.grade} size={54} />
                <span className={styles.miniName}>{lastName(p.name)}</span>
              </button>
            ) : (
              <FullArtCard artReviewExempt
                key={i}
                playerId={p.id}
                name={lastName(p.name)}
                grade={p.grade}
                position={p.position}
                size={104}
                onClick={() => setSpot(i)}
                className={i === spot && plan === "C" ? styles.picked : undefined}
              />
            ),
          )}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary}>모두 공개</button>
        </div>
      </div>
    </section>
  );
}

// ── ③ 도감 상세 ──────────────────────────────────────────────────────────────

const ATTRS: Array<[string, number]> = [
  ["기술", 85], ["멘탈", 95], ["피지컬", 86], ["패스", 92], ["슈팅", 92],
  ["태클", 87], ["스피드", 80], ["지구력", 81], ["위치선정", 95],
];

function Codex() {
  const p = R.yashin;
  return (
    <section className={styles.sec}>
      <Note>
        도감은 지금 <b>그리드 카드 = 아이콘 48px</b> + 탭하면 능력치가 인라인 확장이다. 그리드는
        밀집 UI라 아이콘을 유지하고, <b>확장된 카드에만</b> 풀아트를 붙인다(제안). 그리드 자체를
        풀아트로 바꾸면 172장 × 2요청이라 도감 첫 로드가 무거워진다.
      </Note>
      <h3 className={styles.h3}>현행 (아이콘) — 접힘/펼침</h3>
      <div className={styles.codexGrid}>
        {some(4).map((q) => (
          <div key={q.id} className={styles.codexCard}>
            <span className={styles.codexPos}>{q.position}</span>
            <CharAvatar artReviewExempt playerId={q.id} name={q.name} grade={q.grade} size={48} />
            <span className={styles.codexName}>{q.name}</span>
            <span style={{ color: GRADE_COLORS[q.grade], fontSize: 11, fontWeight: 700 }}>
              {GRADE_LABELS[q.grade]}
            </span>
          </div>
        ))}
      </div>

      <h3 className={styles.h3}>제안 — 확장 시 풀아트 132px + 능력치 나란히</h3>
      <div className={styles.codexExpanded}>
        <FullArtCard artReviewExempt playerId={p.id} name={p.name} grade={p.grade} position={p.position} size={132} />
        <dl className={styles.attrs}>
          {ATTRS.map(([k, v]) => (
            <div key={k} className={styles.attrRow}>
              <dt>{k}</dt>
              <dd>
                <span className={styles.bar}>
                  <span className={styles.fill} style={{ width: `${v}%`, background: GRADE_COLORS[p.grade] }} />
                </span>
                <b>{v}</b>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

// ── ④ 덱 선수 상세 ───────────────────────────────────────────────────────────

function Deck() {
  const [sel, setSel] = useState(0);
  const p = ROSTER[sel] ?? R.yashin;
  return (
    <section className={styles.sec}>
      <Note>
        덱 편성 리스트는 <b>탭 = 슬롯 배치</b>가 이미 주 동작이라 상세를 겹치면 충돌한다. 제안:
        리스트 행은 <b>아이콘 34px 유지</b>, 행 오른쪽 <b>ⓘ 버튼</b>으로만 상세 시트를 연다.
        시트에 풀아트 200px. (대안: 배치 대기 중인 선수를 하단 도크에 큰 카드로 — 컨펌 시 추가 목업)
      </Note>
      <div className={styles.deckSplit}>
        <div className={styles.pickerList}>
          {some(6).map((q, i) => (
            <div key={q.id} className={styles.pickRow}>
              <CharAvatar artReviewExempt playerId={q.id} name={q.name} grade={q.grade} size={34} />
              <span className={styles.pickWho}>
                <b>{q.name}</b>
                <span className={styles.dim}>
                  {q.position} · <span style={{ color: GRADE_COLORS[q.grade] }}>{GRADE_LABELS[q.grade]}</span>
                </span>
              </span>
              <button type="button" className={styles.info} onClick={() => setSel(i)} title="선수 상세">
                ⓘ
              </button>
            </div>
          ))}
        </div>
        <div className={styles.detailSheet}>
          <FullArtCard artReviewExempt playerId={p.id} name={p.name} grade={p.grade} position={p.position} size={200} />
          <div className={styles.detailMeta}>
            <b>{p.name}</b>
            <span className={styles.dim}>{p.position}</span>
            <span style={{ color: GRADE_COLORS[p.grade] }}>{GRADE_LABELS[p.grade]}</span>
            <button type="button" className={styles.primary}>선발로 배치</button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── ⑤ 트레이드 ───────────────────────────────────────────────────────────────

function Trade() {
  return (
    <section className={styles.sec}>
      <Note>
        트레이드는 카드 2~3장을 나란히 비교하는 화면이라 자리가 좁다. 제안: <b>영입 대상만</b>{" "}
        풀아트 132px, 대가/요구는 아이콘 유지. (전부 풀아트로 하면 모바일 390 에서 카드가 90px
        밑으로 내려가 일러스트가 안 읽힌다.)
      </Note>
      <div className={styles.tradeRow}>
        <figure className={styles.fig}>
          <span className={styles.cap}>영입 대상</span>
          <FullArtCard artReviewExempt playerId={R.debruyne.id} name={R.debruyne.name} grade={R.debruyne.grade} position={R.debruyne.position} size={132} />
        </figure>
        <span className={styles.swap}>⇄</span>
        {[R.valverde, R.martinez].map((q, i) => (
          <div key={q.id} className={styles.tradeSmall} style={{ borderColor: GRADE_COLORS[q.grade] }}>
            <span className={styles.cap}>{i === 0 ? "대가" : "요구"}</span>
            <CharAvatar artReviewExempt playerId={q.id} name={q.name} grade={q.grade} size={44} />
            <b className={styles.miniName}>{q.name}</b>
            <span style={{ color: GRADE_COLORS[q.grade], fontSize: 11 }}>{GRADE_LABELS[q.grade]}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── ⑥ 아이콘 유지 경계 ───────────────────────────────────────────────────────

function Icons() {
  return (
    <section className={styles.sec}>
      <Note>
        <b>여기는 안 바꾼다</b>(AC2 — 밀집/게임 UI). 성능(매치 22 토큰 × 매 프레임)과 가독성
        (34px 에 전신 일러스트를 넣으면 뭉갠 점이 된다)이 이유.
      </Note>
      <ul className={styles.boundary}>
        <li>
          <b>매치 경기장 토큰</b> — 아틀라스 스프라이트(뷰어 주입, <code>viewer-skins.ts</code>)
          <div className={styles.pitch}>
            {some(6).map((q) => (
              <CharAvatar artReviewExempt key={q.id} playerId={q.id} name={q.name} grade={q.grade} size={22} />
            ))}
          </div>
        </li>
        <li>
          <b>매치 프롬프트 목록</b> — 26px
          <div className={styles.pitch}>
            {some(4).map((q) => (
              <CharAvatar artReviewExempt key={q.id} playerId={q.id} name={q.name} grade={q.grade} size={26} />
            ))}
          </div>
        </li>
        <li>
          <b>덱 리스트 행 / 전술보드 슬롯</b> — 34px
          <div className={styles.pitch}>
            {some(4).map((q) => (
              <CharAvatar artReviewExempt key={q.id} playerId={q.id} name={q.name} grade={q.grade} size={34} />
            ))}
          </div>
        </li>
        <li>
          <b>도감 그리드 카드</b> — 48px (확장했을 때만 풀아트)
          <div className={styles.pitch}>
            {some(4).map((q) => (
              <CharAvatar artReviewExempt key={q.id} playerId={q.id} name={q.name} grade={q.grade} size={48} />
            ))}
          </div>
        </li>
      </ul>
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}

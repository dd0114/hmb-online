# 선수 등급 매핑 기준 — players v2 (실선수)

> 이슈 #84 (hmb:players). data 도메인 산출물 `data/players/players.v2.json` 의 **등급 배정 기준**을 문서화한다.
> ⚠️ **실명 사용** — PoC 한정. 상용화 전 초상권/라이선스 해결 필수(백로그, `data/CLAUDE.md`·PRD-v2 D4 참조).
> 구조 축(같은 선수 다버전 등)은 v2 범위 밖 — #85(cards) 확정 후 v3. v2 = 선수당 1버전 평면 구조.

## 1. 배경

v1(가상 선수 110명)을 **유명 실선수 172명**으로 전량 교체한다: **인터내셔널 142명**(유럽 빅클럽 현역 + 역대 레전드) + **한국 유명 선수 30명**(hero 요청 — 국내/세계 위상 반영, 로마자 표기로 통일). '일단 풀부터 채운다' — 등급/버전 구조 심화는 #85 결과에 따라 후속.

> 이름 표기: 기존 인터내셔널 선수와 **일관되게 전원 로마자**(예: `Son Heung-min`, `Park Ji-sung`). 한국 간판 손흥민·김민재는 국내 위상 반영해 **DIA 격상** 배치.

## 2. 등급 5단계 매핑 기준 (능력 위상 반영)

능력치 밴드(0~100)는 v1과 동일 유지 — 등급 = 밴드. 배정은 **선수의 실제 위상**을 반영한다.

| 등급 | 밴드 | 매핑 기준 | 예시 | 인원 |
|---|---|---|---|---|
| **LEGEND** | 80–95 | 역대 레전드 **전성기**(축구사 정상급, 은퇴/올타임) | Pelé, Maradona, Cruyff, Beckenbauer, Zidane, Ronaldo Nazário, Yashin, Maldini, **Park Ji-sung, Cha Bum-kun** | 14 |
| **DIA** | 70–85 | 현역 **월드클래스** 빅클럽 주전(발롱도르권/세계 최정상) | Haaland, Mbappé, Bellingham, Vinícius, Rodri, De Bruyne, van Dijk, Kane, Salah, **Son Heung-min, Kim Min-jae** | 25 |
| **GOLD** | 60–75 | 빅클럽 **확실한 주전** | Saka, Osimhen, Bruno Fernandes, Marquinhos, Lewandowski, **Lee Kang-in, Hwang Hee-chan, Hong Myung-bo** | 46 |
| **SILVER** | 50–65 | **로테이션·준주전**(좋은 클럽) | Havertz, Isak, Gakpo, Bastoni, Varane, **Lee Jae-sung, Cho Hyun-woo, Cho Gue-sung** | 52 |
| **BRONZE** | 40–55 | **백업·유망주**(프로스펙트) | Endrick, Kobbie Mainoo, Gavi, Leny Yoro, **Yang Min-hyuk, Oh Hyeon-gyu, Bae Jun-ho** | 35 |

> 등급 경계는 절대적 랭킹이 아니라 **수집 게임의 희소성 층위**다: 레전드는 극소수(열망 카드), 하위 등급으로 갈수록 흔하다. 능력이 애매한 선수는 팀 내 위상·최근 폼으로 배정. 한국 선수는 국내/아시아 위상을 반영(박지성·차범근=세계무대 레전드 → LEGEND, 손흥민·김민재=현역 간판 → DIA).

## 3. 포지션 분포

| GK | DF | MF | FW | 계 |
|---|---|---|---|---|
| 13 | 53 | 59 | 47 | **172** |

- 실축구 스쿼드 비율(수비·미드 다수) 근사. 등급별로 전 포지션이 고루 존재하도록 배분(GK는 전 등급 ≥1).
- **GK 비중 축소**(hero 지적): 초기 v2안(GK 19)은 컬렉션에서 GK가 과다 → **13명(전체의 ~7.5%)** 으로 감축. 팀당 선발 GK 1명이므로 수집 비중을 낮춘다.
- **한국 선수 30명 추가**(hero 요청): GK 2(조현우·김승규) / DF 6 / MF 11(박지성 포함) / FW 11(차범근 포함). 손흥민·김민재는 인터내셔널 DIA 블록에 격상 배치(위 30명과 별개, 한국 선수 총 32명).

## 4. 능력치 9종 파생 규칙 (실선수 특성 반영)

로스터(`roster.ts`)는 **이름·포지션·등급·시그니처 특성(traits)** 만 큐레이션하고, 실제 9종 수치는 `generate.ts` 가 시드 RNG로 결정론 파생한다:

1. 등급 밴드 내 균등 롤(9종).
2. **포지션 주스탯 +5**: GK=positioning·mental / DF=tackling·positioning / MF=passing·stamina / FW=shooting·pace.
3. **개인 trait +6**: 그 선수의 시그니처 능력치(예: Mbappé=pace·shooting, De Bruyne=passing·shooting, van Dijk=tackling·physical). 밴드 상한 클램프.

→ 같은 등급이라도 선수마다 스탯 프로파일이 다르고(포지션·시그니처 반영), **재실행 바이트 동일**(AC 결정론) 유지.

## 5. ID 체계

- `P###` **유지**(P001~P172). 소비자(server-java)는 문자열 id만 참조하므로 스킴 불변.
- v2는 **P-공간을 실선수로 재배정**한다(구 v1의 P001..P110 가상선수 의미는 폐기). starterPack·봇 덱 id도 v2 기준으로 재구성.
- ⚠️ 이 때문에 **기존 DB 리셋 필요**(구 P-덱 보유 유저와 섞이면 스테일). PoC 범위 리셋 — hero 확인 대상(#84).

## 6. economy / bots v2

- **economy.v2.json**: 스타터팩 14명(GK1/DF5/MF5/FW3, 브론즈~실버) v2 id로 재선정. 뽑기 확률표(D6)·경제 수치 유지 — LEGEND 0.02 로 희소성 반영.
- **bots.v2.json**: 봇 3덱 v2 id로 재구성. **봇은 DIA/LEGEND 미편성**(maxRank=GOLD 캡) — 상위 등급은 가챠 열망 카드로 예약, 봇은 GOLD 이하로 구성해 상대 밸런스 유지.

## 7. 검증 (data.test.ts)

분포(172·포지션·등급 리터럴)·한국선수 존재·등급 희소 단조·ID 순차/유일·**실명 allowlist(=ROSTER 일치)**·밴드·trait 반영·zod PlayerCard·starterPack 구성·gacha 합=1·봇 덱 유효성·**봇 DIA/LEGEND 미편성**·디스크 바이트 동일·재생성 결정론. 루트 `npm test` 포함.

---

## 8. 선수 성격(personality) 매핑 기준 — players **v2.1** (Phase 2, PRD-v3 P2-D7)

> Phase 2 증분. `players.v2` 위에 **additive** 로 `personality` 만 부여 → `players.v2.1.json`. v2 필드(id/name/position/grade/attributes)는 **무변경**(바이트 동일). 큐레이션 원천 = `data/players/personality.ts`(이름→성격), 파생 = `generate.ts buildPlayersV21()`. 등급 매핑(§2)과 **별개 축** — 성격은 능력 위상이 아니라 "감독 관계 반응 유형"이다.

### 8.1 성격 4종과 판단 기준
등급이 "얼마나 잘하나"라면, 성격은 "감독의 지시·질책·프롬프트에 **어떻게 반응하나**"의 층위다. 선수의 실제 이미지(기질·커리어 서사·미디어 페르소나)로 배정한다.

| 성격 | 뜻 | 배정 기준(실선수 이미지) | AI 반응 방향(servants가 소비) | 예시 |
|---|---|---|---|---|
| **FIERY** (불꽃) | 다혈질·투쟁적 | 감정 표출형 리더·투사, 카드/충돌 잦음, 승부처에서 끓어오름 | 강한 압박·공격 지시에 과반응(잘 먹힘), 과한 질책은 역효과(충돌) | Maradona, Rüdiger, Casemiro, Gavi, Lee Kang-in, Cho Hyun-woo |
| **CALM** (침착) | 냉정·안정 | 압박 상황에서 흔들리지 않는 프로, 메트로놈형·클래식 리더 | 지시에 꾸준히 반응, 변동 적음(**기본값**) | Kroos, Modrić, van Dijk, Son Heung-min, Ki Sung-yueng |
| **GLASS** (유리멘탈) | 자신감 의존·기복 | 폼 편차 큰 선수·프레셔 취약·슬럼프형, 어린 프로스펙트 | 질책성 프롬프트에 위축(`mentalModifier`↓), 격려엔 살아남 | Rashford, Havertz, Arda Güler, Park Chu-young |
| **AMBITIOUS** (야심가) | 승부욕·자기주도 | 상위 이동/기록 지향, 헝그리한 슈퍼스타·떠오르는 유망주 | 공격·도전적 목표에 동기부여, 큰 역할 부여 시 상승 | Ronaldo Nazário, Mbappé, Haaland, Park Ji-sung |

- **한국 선수**: 세계무대 서사 반영(박지성·차범근=야심가형 개척자 → AMBITIOUS, 손흥민=꾸준·프로페셔널 → CALM, 이강인=다혈질 → FIERY).
- **어린 프로스펙트 처리**: 폼/기복이 서사면 GLASS(예: Rashford·Arda Güler·Karim Adeyemi), 헝그리·상승세가 서사면 AMBITIOUS(예: Endrick·Yamal·Yang Min-hyuk). 둘 다 어리지만 축이 다르다.

### 8.2 분포
목표(P2-D7): 대략 **FIERY 25 / CALM 40 / GLASS 15 / AMBITIOUS 20** (%). CALM 이 기본값이라 최다.
실제(172명): **FIERY 41 (23.8%) / CALM 69 (40.1%) / GLASS 25 (14.5%) / AMBITIOUS 37 (21.5%)**.
검증은 `data.test.ts` 가 **밴드**로(정확 카운트 강제 X — 큐레이션 여지 유지) + 전원 매핑(ROSTER↔PERSONALITY 전단사) + enum + CALM 최다 + 대표 선수 회귀 가드로 수행.

### 8.3 economy / league v2 (Phase 2 추가)
- **economy.v2.json**(additive 확장, 발행명 유지): 기존 v2 필드(gacha·rewards·starterPack) 무변경 + `trade`(P2-D9: 레어도별 대기 h BRONZE1/SILVER6/GOLD24/DIA48/LEGEND72·단축 비용 계수·FA 확률 base/k·TRADE 수락 0.8·가치함수 테이블) + `league`(순위 보상 참조 → `league.v1.json#rewards`). 서버(server-java)는 이 블록만 읽는다(하드코딩 금지).
- **league.v1.json**(신규): 가상 클럽명 24개(실클럽 denylist 가드)·팀 성향 프리셋 7종(BALANCED/ATTACK/DEFENSE/GEGENPRESS/COUNTER/POSSESSION/WING_PLAY, tactics 0..1)·순위별 포인트 보상표(10팀, 우승 3000 → 10위 200, 단조 감소).

---

## 9. LEGEND 개편 — players **v2.2** (에픽 #207, hero 확정 2026-07-27)

> v2.1 위에 **additive** 증분. §2~§8 은 **v2/v2.1 발행 시점 기준으로 그대로 둔다**(발행 후 수정 금지 원칙 — v2.json/v2.1.json 은 바이트 불변). 이 절이 v2.2 의 델타다.
> 결정 SoT = 이슈 #207 코멘트의 **U-D1~U-D4**.

### 9.1 무엇이 바뀌었나

| 축 | v2.1 | **v2.2** |
|---|---|---|
| 총원 | 172 | **180** (신규 8종) |
| LEGEND | 14 | **22** (구 14 + 신규 8) |
| 포지션 | GK13 / DF53 / MF59 / FW47 | **GK14 / DF53 / MF62 / FW51** |
| 신설 필드 | — | **`active`** (boolean) |

**`active` = 신규 획득 경로 노출 여부**다. `false` 면 가챠 추첨 풀·트레이드 타깃·도감 미보유분에서 빠진다.
**보유분은 건드리지 않는다** — `user_players` 행·성★·`stat_levels`·`card_potentials`·덱 편성·유효스탯·매치 SelectData 전부 그대로 동작한다.

### 9.2 hero 결정 U-D1 — 왜 '강등'이 아니라 '비활성화'인가

hero 요구는 원래 "현행 LEGEND 전원 비활성화 or **에픽/유니크로 강등**"이었다. 조사 결과 두 가지가 걸렸다:

1. **'에픽/유니크'는 이미 다른 축의 단어다** — `card_potentials.tier CHECK IN ('RARE','EPIC','UNIQUE')`(V10) + shared `POTENTIAL_TIERS` + `economy.potential.gradeTierCap`. **잠재능력 티어**다. 등급으로 신설하면 한 카드에 "EPIC 등급 / EPIC 잠재"가 동시에 뜬다.
2. **DIA 강등은 기보유 유저의 스탯을 실제로 깎는다 — 투자한 유저를 더 많이.**
   `GrowthService.compute()` 의 캡 공식이 `cap_i(star) = base_i + starFrac[star] × (band.hi − base_i)` 인데
   `GRADE_BAND` 가 LEGEND `[80,95]` → DIA `[70,85]` 로 내려가면서 `base_i > 85` 인 스탯이 캡 아래로 잘린다.
   `starFrac` 은 1★ 0.25 → 4★ 1.0 이라 **성★이 높을수록 더 깎인다**(역진).
   실측(P005 Diego Maradona, 평균 92.33): **1★ −1.83 / 4★ 전 스탯 85.0 평탄화(−7.33)**.
   중복 5장을 태운 최대 투자 카드가 4배 더 손해 보는 구조다.

→ **등급은 그대로 두고 `active` 축을 신설**해 획득 경로만 끊는다. 손실 0 · 구현 최소 · 되돌리기 쉽다.
그 결과 `players.grade` CHECK 재작성 · `GRADE_BAND` · `GRADE_ORDER`(shared) · `gacha.rates` 재분배 ·
`gradeXpMult` · `linesByGrade` · `gradeTierCap` · `trade` 등급표 · `frame-<등급>.png` 신규 발행이 **전부 불필요**해졌다.

### 9.3 신규 8종 (U-D4)

| id | 유닛 | 스탯 소스 | pos | traits | 소스 로스터 |
|---|---|---|---|---|---|
| P173 | 보날두 | 크리스티아누 호날두 | FW | shooting, physical | ❌ 신규 작성(U-D2) |
| P174 | 권씨 | 메시 | FW | technical, shooting | ❌ 신규 작성(벤치마크) |
| P175 | 유라도나 | 마라도나 | MF | technical, shooting | ✅ P005 복제 |
| P176 | 춘바페 | 음바페 | FW | pace, shooting | ✅ 복제 |
| P177 | 덕브라이너 | 데브라위너 | MF | passing, shooting | ✅ 복제 |
| P178 | 석신 | 야신 | **GK** | positioning, mental | ✅ P001 복제 |
| P179 | 욱리엄 | 벨링엄 | MF | physical, shooting | ✅ 복제 |
| P180 | 경니시우스 | 비니시우스 | FW | pace, technical | ✅ 복제 |

- **§4 파생 규칙 무변경**: 로스터는 이름·포지션·등급·traits 만 큐레이션하고 9종 수치는 시드 RNG 파생이다.
  즉 "실선수 스탯을 복사하는 경로"는 애초에 없고, **실질 매핑 = 등급 밴드 + traits 2개**다.
  로스터에 소스가 있는 6종은 그 traits 를 복제했고, 없는 2종(CR7·메시)만 벤치마크로 작성했다.
- **이름 표기**: §2 의 로마자 통일 규칙에서 **의도적으로 벗어난다**. 이 8종은 실선수가 아니라 **패러디 유닛**이라
  로마자화하면 의미가 죽는다. 대신 실명 유입 차단 가드를 한글 축으로 확장했다(소스 실명의 한글표기 denylist 부분문자열 0).
- **personality(§8)**: U-D4 표에 없던 축이지만 v2.1 additive 라 필수 필드다. 임의 배정 대신 **소스 실선수의 성격을 복제**하고,
  소스가 없는 2종만 §8.1 기준으로 신규 배정(보날두 AMBITIOUS · 권씨 CALM). hero 재량 사항 — 바꿔도 스탯·RNG 무영향.

### 9.4 비활성 14종

`P001~P012 + P143 + P144` = §2 의 LEGEND 14명 전원. **등급 LEGEND 유지**(강등 아님), `active: false`.
→ 획득만 막히고 보유분은 그대로다. `player-chars.v1.json` 매핑도 유지되어 **아트를 뺏지 않는다**.

### 9.5 결정론 — ROSTER 끝에 append (⚠️ 필수)

`generateAll()` 은 `createRng(SEED)` **한 스트림**을 `ROSTER.forEach` 로 순차 소비한다.
→ 신규 항목은 **배열 맨 끝에만** 붙여야 기존 172명의 attributes 가 바이트 동일하게 보존된다.
중간 삽입하면 그 뒤 전원의 스탯이 shift 되어 **기보유 유저 카드가 전부 바뀐다.**
LEGEND 블록이 파일 앞뒤로 나뉘는 건 그래서 감수한 것이다(가독성 < 결정론).

증빙: v2.2 앞 172명 sha256 = 디스크 `players.v2.1.json` sha256 (`active` 제외 시) **일치**.
변이체 킬 — 석신을 P172 자리에 중간 삽입하면 `data.test.ts` **11건 FAIL**(맨 앞 삽입은 `buildPlayersV22` fail-closed 가 먼저 발화).

### 9.6 이미지 (U-D3)

신규 8종은 **매핑을 추가하지 않는다** → web `CharAvatar` 가 자동으로 `placeholder-css`(이니셜) 폴백.
`gen-chars.ts` 는 매핑 입력으로 **동결된 v2.1(172명)** 을 읽으므로 §7 의 `TOTAL=172`·`LEGEND_TOTAL=14` 가드는 그대로 성립한다.
`chars-map.test.ts` 에 "갭은 의도적"·"활성 LEGEND 8종은 매핑 undefined"·"비활성 14종은 매핑 유지"·
"v2.2 전체를 `buildMapping` 에 넣으면 여전히 throw" 를 계약으로 박제했다.
마지막 항목이 중요하다 — **아트 입고 시 그 throw 가 해제 신호**가 된다.

### 9.7 §7 검증 목록 증분 (data.test.ts)

`TOTAL 172→180` · `GRADE_TOTALS LEGEND 14→22` · `POSITION_TOTALS GK14/DF53/MF62/FW51` +
U-D4 8종 리터럴 표(이슈 결정표에서 직접 박제 — roster 재사용은 자기참조라 회피) ·
P173~P180 신규 채번·전원 LEGEND·GK1/MF3/FW4·trait 스탯 ≥ 밴드하한+6 ·
`active:false` 정확히 14개이며 집합 일치 · LEGEND 중 `active:true` 정확히 8개 ·
구 14종 등급/밴드 무변경 · v2.2 키 순서 `[id,name,position,grade,attributes,personality,active]` ·
**동결 불변 2건**(디스크 v2.1 과 바이트/필드 대조) · starterPack·봇덱이 신규 8종 미참조 ·
**economy 등급 축 무변경 리터럴 핀**(gacha.rates·gradeXpMult·trade.waitHours/value/targetRarityWeights·potential.linesByGrade/gradeTierCap).

### 9.8 소비 경로

`server-java` 의 `hmb.data.players-file` 이 `players.v2.2.json` 을 가리킨다.
임포터는 `active` 를 왕복 처리한다 — 필드가 없는 구 시드(v2.1 이하)는 전원 `active=1` 로 안전 임포트(무회귀).
런타임 변경 경로는 **어드민 유닛 카탈로그 API**(#207 파트 A)이고, `players.admin_locked=1` 인 행은 부팅 재임포트가 덮지 않는다.
어드민으로 확정한 상태는 `GET /api/admin/units/export` 로 뽑아 **다음 시드 버전으로 승격**한다(런타임 경로와 시드 경로가 갈라지지 않게).

---

## 10. v2.4 신규 LEGEND 2종 델타 (#256, hero 확정 2026-07-29)

> §9 는 #207(v2.2) 시점의 기록이라 그대로 둔다. v2.3·v2.4 증분은 여기에 이어 적는다.
> 현행 소비본은 **`players.v2.4.json`(182명)** 이다 — §9.8 의 "v2.2 를 가리킨다"는 그 시점 서술이다.

### 10.1 결정

| id | 유닛명 | 포지션 | 등급 | traits | 소스 |
|---|---|---|---|---|---|
| P181 | 석다이크 | DF | LEGEND | tackling, physical | Virgil van Dijk (P015, 카탈로그 내 **DIA**) |
| P182 | 오시야스 | GK | LEGEND | positioning, physical | Iker Casillas (**카탈로그에 없음**) |

### 10.2 "동일 스탯 복제"의 해석 — 값 복사가 아니라 **포지션·traits 복제**

hero 지시는 "판다이크와 동일 / 카시야스와 동일"이었고, 두 가지로 읽힐 수 있었다. 확인 결과 값
복사는 성립하지 않는다:

- **판다이크는 DIA** 다(P015, 평균 79.7). LEGEND 밴드는 80~95 이므로 값을 그대로 복사하면 등급은
  LEGEND 인데 성능은 DIA 인 카드가 되어 **획득 가능 LEGEND 23종 중 압도적 최약체**가 된다.
- **카시야스는 로스터에 아예 없다**(실선수 172명 미포함) → 복사할 원본이 존재하지 않는다.

그리고 기존 8종의 "복제"(§9, `석신←야신`·`열라도나←마라도나`)도 값 복사가 아니었다 — **포지션·
traits 만 물려받고 스탯은 LEGEND 밴드에서 새로 굴린다**(야신 88.1 vs 석신 87.3). hero 에게 세 안을
풀맥락으로 제시해 **기존 관례 유지**로 확정했다. 오시야스 traits 는 소스가 없어 §8.1 기준 신규 배정
(`positioning+physical` — 석신의 `positioning+mental` 과 갈라 두 LEGEND GK 가 다른 색을 갖게).

### 10.3 발행 구조 — 동결 경계가 **둘**이 됐다

`buildPlayersV22` 가 전체 ROSTER 를 받고 있어서, 로스터에 2종을 append 하는 순간 이미 발행된
`players.v2.2.json`(180행)과 어긋났다. v2/v2.1 이 `FROZEN_ROSTER_COUNT`(172) 슬라이스 덕에 #207 을
멀쩡히 넘긴 것과 대조된다. 그래서 **같은 장치를 한 겹 더** 둔다:

```ts
export const FROZEN_ROSTER_COUNT_V22 = 180;                  // v2.2/v2.3 발행 경계
const playersV22 = buildPlayersV22(buildPlayersV21(players.slice(0, FROZEN_ROSTER_COUNT_V22)));
const playersV23 = buildPlayersV23(playersV22);              // 180 — 바이트 동일 유지
const playersV24 = buildPlayersV24(playersV23, buildPlayersV21(players)); // 182
```

RNG 안전 근거는 §9.5 와 동일하다 — 한 스트림을 `ROSTER.forEach` 로 순차 소비하므로 **맨 끝
append** 는 앞 180명의 소비 순서를 건드리지 않는다. 슬라이스는 그 뒤의 순수 변환이다.

`buildPlayersV24` 는 fail-closed 다: append 분의 id **집합과 순서**가 `V24_NEW_UNIT_IDS` 와 일치 ·
동결 경계 밖 · 전원 LEGEND · v2.3 구간 행 무변경 · 유닛명 전역 유일.

### 10.4 활성화는 **채번이 아니라 어드민 토글**

둘 다 `active:false` 로 발행한다(§9.8 운영 모델 그대로 — 아트 머지 → 배포 → 어드민 API). 따라서
**획득 가능 LEGEND 의 DF 0 · GK 0 갭은 채번만으로 닫히지 않는다.** `PlayerCatalogV24SeedTest` 가
그 상태를 박제하고(첫 단언), **켜기만 하면 닫힌다**는 것도 같이 박아(둘째 단언) 남은 일이 데이터
작업이 아니라 토글임을 코드가 말하게 한다. 어드민이 켜면 첫 단언이 실패하며 갱신을 요구한다.

### 10.5 §7 검증 목록 증분 (data.test.ts)

`TOTAL 180→182` · `GRADE_TOTALS LEGEND 22→24` · `POSITION_TOTALS GK15/DF54/MF62/FW51` +
**v2.2/v2.3 경계 리터럴 신설**(`V23_TOTAL`·`V23_POSITION_TOTALS`·`V23_GRADE_TOTALS` — 그 발행물이
동결이라 이 값도 영구 고정) · #256 2종 리터럴 표 · P181~P182 신규 채번(기존 P-공간 재사용 0) ·
능력치 9종이 LEGEND 밴드(80~95) 안이며 **P015 값과 불일치**(값 복사가 아님을 직접 대조) ·
trait 스탯이 비-trait 최솟값 이상 · `active:false` 정확히 19개이며 집합 일치 ·
v2.3 구간 active 무변경(순수 append) · **동결 불변**(앞 180행이 디스크 v2.3 과 바이트 동일 +
앞 172행이 v2.1 과 동일) · 갭 박제(활성 LEGEND 에 DF/GK 0, 켜면 각 1) ·
starterPack·봇덱·`starterTop` 이 신규 2종 미참조.

### 10.6 소비 경로 스위치 (두 곳 **모두**)

`server-java/src/main/resources/application.yml` 의 `hmb.data.players-file` **와**
`server-java/Dockerfile` 의 `HMB_DATA_PLAYERSFILE` 을 **둘 다** `players.v2.4.json` 으로.
한쪽만 올리면 ENV 가 yml 을 덮어 배포에서 조용히 구 시드가 로드된다(2026-07-27 v8 에서 실제로 발생).
아트 축은 `design/characters/dist/units`(4차 입고 `hero-imageRef-2026-07-29-rev4`, 9종) →
`gen-chars.ts` 의 `UNIT_ASSIGNMENT` + `ACTIVATION_PENDING` → `player-chars.v2.json`.

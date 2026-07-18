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

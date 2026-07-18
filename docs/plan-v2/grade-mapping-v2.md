# 선수 등급 매핑 기준 — players v2 (실선수)

> 이슈 #84 (hmb:players). data 도메인 산출물 `data/players/players.v2.json` 의 **등급 배정 기준**을 문서화한다.
> ⚠️ **실명 사용** — PoC 한정. 상용화 전 초상권/라이선스 해결 필수(백로그, `data/CLAUDE.md`·PRD-v2 D4 참조).
> 구조 축(같은 선수 다버전 등)은 v2 범위 밖 — #85(cards) 확정 후 v3. v2 = 선수당 1버전 평면 구조.

## 1. 배경

v1(가상 선수 110명)을 **유명 실선수 150명**으로 전량 교체한다(유럽 빅클럽 현역 + 역대 레전드). '일단 풀부터 채운다' — 등급/버전 구조 심화는 #85 결과에 따라 후속.

## 2. 등급 5단계 매핑 기준 (능력 위상 반영)

능력치 밴드(0~100)는 v1과 동일 유지 — 등급 = 밴드. 배정은 **선수의 실제 위상**을 반영한다.

| 등급 | 밴드 | 매핑 기준 | 예시 | 인원 |
|---|---|---|---|---|
| **LEGEND** | 80–95 | 역대 레전드 **전성기**(축구사 정상급, 은퇴/올타임) | Pelé, Maradona, Cruyff, Beckenbauer, Zidane, Ronaldo Nazário, van Basten, Yashin, Maldini | 12 |
| **DIA** | 70–85 | 현역 **월드클래스** 빅클럽 주전(발롱도르권/세계 최정상) | Haaland, Mbappé, Bellingham, Vinícius, Rodri, De Bruyne, van Dijk, Modrić, Kane, Salah | 24 |
| **GOLD** | 60–75 | 빅클럽 **확실한 주전** | Saka, Osimhen, Son Heung-min, Bruno Fernandes, Marquinhos, Lewandowski, Musiala | 40 |
| **SILVER** | 50–65 | **로테이션·준주전**(좋은 클럽) | Havertz, Isak, Gakpo, Bastoni, Camavinga, Varane | 44 |
| **BRONZE** | 40–55 | **백업·유망주**(프로스펙트) | Endrick, Yamal? no(GOLD), Kobbie Mainoo, Gavi, Leny Yoro, Warren Zaïre-Emery | 30 |

> 등급 경계는 절대적 랭킹이 아니라 **수집 게임의 희소성 층위**다: 레전드는 극소수(열망 카드), 하위 등급으로 갈수록 흔하다. 능력이 애매한 선수는 팀 내 위상·최근 폼으로 배정.

## 3. 포지션 분포

| GK | DF | MF | FW | 계 |
|---|---|---|---|---|
| 19 | 47 | 48 | 36 | **150** |

- 실축구 스쿼드 비율(수비·미드 다수) 근사. 등급별로 전 포지션이 고루 존재하도록 배분(GK는 전 등급 ≥1).

## 4. 능력치 9종 파생 규칙 (실선수 특성 반영)

로스터(`roster.ts`)는 **이름·포지션·등급·시그니처 특성(traits)** 만 큐레이션하고, 실제 9종 수치는 `generate.ts` 가 시드 RNG로 결정론 파생한다:

1. 등급 밴드 내 균등 롤(9종).
2. **포지션 주스탯 +5**: GK=positioning·mental / DF=tackling·positioning / MF=passing·stamina / FW=shooting·pace.
3. **개인 trait +6**: 그 선수의 시그니처 능력치(예: Mbappé=pace·shooting, De Bruyne=passing·shooting, van Dijk=tackling·physical). 밴드 상한 클램프.

→ 같은 등급이라도 선수마다 스탯 프로파일이 다르고(포지션·시그니처 반영), **재실행 바이트 동일**(AC 결정론) 유지.

## 5. ID 체계

- `P###` **유지**(P001~P150). 소비자(server-java)는 문자열 id만 참조하므로 스킴 불변.
- v2는 **P-공간을 실선수로 재배정**한다(구 v1의 P001..P110 가상선수 의미는 폐기). starterPack·봇 덱 id도 v2 기준으로 재구성.
- ⚠️ 이 때문에 **기존 DB 리셋 필요**(구 P-덱 보유 유저와 섞이면 스테일). PoC 범위 리셋 — hero 확인 대상(#84).

## 6. economy / bots v2

- **economy.v2.json**: 스타터팩 14명(GK1/DF5/MF5/FW3, 브론즈~실버) v2 id로 재선정. 뽑기 확률표(D6)·경제 수치 유지 — LEGEND 0.02 로 희소성 반영.
- **bots.v2.json**: 봇 3덱 v2 id로 재구성. **봇은 DIA/LEGEND 미편성**(maxRank=GOLD 캡) — 상위 등급은 가챠 열망 카드로 예약, 봇은 GOLD 이하로 구성해 상대 밸런스 유지.

## 7. 검증 (data.test.ts)

분포(150·포지션·등급 리터럴)·등급 희소 단조·ID 순차/유일·**실명 allowlist(=ROSTER 일치)**·밴드·trait 반영·zod PlayerCard·starterPack 구성·gacha 합=1·봇 덱 유효성·**봇 DIA/LEGEND 미편성**·디스크 바이트 동일·재생성 결정론. 루트 `npm test` 포함.

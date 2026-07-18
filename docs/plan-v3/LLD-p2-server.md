# LLD — Phase 2 server-java (에픽 p2-server)

> 스코프: `server-java/**` + `docs/plan-v3/api/openapi-v2.yaml` 산출(V1 openapi에 추가분 — 파일 분리, 웹은 두 스펙 merge 소비). ERD-v2 → Flyway `V2__phase2.sql` 그대로.

## 1. OAuth 목 (AC-A)
- `POST /api/auth/login` body에 `provider: 'guest'|'mock:google'|'mock:apple'` 추가(기본 guest=기존 닉네임 플로우). mock:*는 `{provider, nickname}` 그대로 세션 발급, users.auth_provider 기록.
- `MockOAuthProvider implements AuthProvider` 별도 클래스 — 실 OAuth 교체 지점 javadoc + "컨트롤러 불변" 테스트(AuthProvider 목 주입 스왑).

## 2. 팀 스냅샷 API (AC-B1~B2)
| 엔드포인트 | 동작 |
|---|---|
| `GET /api/presets/team` | 3슬롯 목록(빈 슬롯 포함) |
| `PUT /api/presets/team/{slot}` | 스냅샷 저장(전체 교체). 검증 = 덱 검증 재사용(보유·11명·GK≥1) + teamTactics 범위(0..1) |
| `POST /api/presets/team/{slot}/apply` | 스냅샷 → 현재 deck/deck_slots 반영(브리핑·덱 편집기의 작업 상태) |
- 기존 문자열 프리셋(prompt_presets) API는 유지(프롬프트 문구 복사용) — 웹에서 위치만 재배치.
- 매치 생성 스냅샷(user_deck_json)에 teamTactics 포함 확장. **teamTactics는 AI 컨텍스트로 전달**(§4).

## 3. 컨디션 (AC-C1)
- 매치 생성 시: `condition(playerId) = scale(sha256(matchSeed+':cond:'+playerId))` → 0.0~1.0, conditions_json 저장.
- SelectData 빌드 시 능력치 배율: `attr × (minMul + condition × (maxMul-minMul))` — `hmb.match.condition.min-mul=0.85 / max-mul=1.10`(yml). 반올림 후 0..100 클램프. **교체 투입 선수 포함**(h2 SelectData에도 동일 컨디션 적용).
- GET match 응답에 conditions 노출(시계 UI용). 재현: 저장값 == 재계산(테스트).

## 4. AI 컨텍스트 확장 (AC-C2~C4, servants와 계약)
`context_json`(TeamInputJobContext)에 **additive 필드** 추가(zod 쪽은 p2-servants가 동기 확장 — 계약 조율 매니저 경유):
```
manualTactics?: {line,press,tempo,width}       // P2-D4: 유저 수동 전술(있으면 AI는 보정만)
conditions?: {playerId: number}
relations?: {playerId: {trust, personality}}   // 신뢰도·성격
teamMorale?: {morale, streak}
opponentRoster?: [{playerId,name,position}]    // 마킹 지시 해석용(상대 이름→playerId 매핑 근거)
```
- 관계 갱신 규칙(config `hmb.relation.*`): 선발 기용 +2, 승리 전원 +3, 패배 -2, 결장 연속 2경기째부터 -3/경기, 교체 아웃 -1. 사기: 승 +8/무 +2/패 -8, streak 부호 갱신. FINISHED 트랜잭션에서 멱등 적용(ref=matchId 가드 — 관계 변동 이력 테이블 없이 matches 처리 플래그로).

## 5. 트레이드 (AC-D)
- 부팅/스케줄러: 유저별 슬롯 3개 보장(없으면 WAITING 생성 — kind·target은 opens_at 시점에 확정하지 않고 **생성 시 시드로 즉시 확정**, opens_at만 미래).
- 오퍼 생성(시드 결정): kind 50/50, target 레어도 가중(config), TRADE면 demand=내 보유 중 가치 근접 선수. opens_at = now + wait(rarity)(config 1h~72h).
- `GET /api/trade` 슬롯 상태(남은 시간 포함). `POST /api/trade/{slot}/speedup` — 남은시간 비례 포인트 차감(원장 ref=slotId+회차, 멱등) → opens_at 단축. `POST /api/trade/{slot}/propose`(FA: {playerIds[], points}) → 가치비교 확률 `p = clamp(base + k×(offerValue/targetValue-1))`(config) → 시드+제안해시 롤 → 성공 시 이적 반영·실패 시 쿨타임. `POST /api/trade/{slot}/accept|decline`(TRADE: 수락 확률 config 0.8). 모든 결과 trade_log + 슬롯 재생성.
- 가치함수: 등급 기본값 + 능력치 합 보정(config 테이블) — 문서화.

## 6. 리그 (AC-F)
- `POST /api/league/start` → ACTIVE 시즌 없으면 생성: 시드로 봇 9팀(실선수 풀에서 등급 분포 밸런스 로스터 15명, 팀명 풀·성향), 더블 라운드로빈 일정(서클 메서드, 홈어웨이 대칭), 유저 경기 18개 + 봇전 72개.
- `GET /api/league` → 시즌 상태·순위표(파생 쿼리: 승점→골득실→다득점→승자승)·일정·다음 유저 경기.
- `POST /api/league/next-match` → 다음 SCHEDULED 유저 픽스처로 매치 생성(mode=league, 상대=해당 봇팀 로스터/성향, **홈/어웨이 반영**) — 이후 기존 매치 플로우. FINISHED 시 픽스처 정산 + **같은 라운드 봇전 4경기 간이 결과 일괄 생성**(파생 시드, 팀 파워+홈보정 푸아송 근사 — 구현은 간단 확률표로, 문서화) + 다음 라운드 오픈.
- 시즌 18R 완료 → FINISHED, 순위 보상(config, 원장 ref=seasonId 멱등), `POST /api/league/start`로 새 시즌(season_no+1).
- 고증 문서 `docs/plan-v3/league-rules.md` 산출(참조 리그 명시).

## 7. 로그·랭킹 (AC-E)
- `GET /api/logs/matches`(모드·시즌 필터), `GET /api/logs/trades`, `GET /api/rankings` — 유저 승수/승률 상위 N + 내 순위, 개인 기록(최다골 선수 등 매치 이벤트 파생).

## 8. 웨이브
W0 Flyway V2+openapi-v2+스냅샷 API → W1 컨디션+관계(컨텍스트 확장 계약은 servants와 동시 머지) → W2 트레이드 → W3 리그 → W4 로그/랭킹+통합. 각 웨이브 module-implementer→verifier PASS→머지. 테스트 전략 V1과 동일(임시 SQLite·전이표·멱등·시드 재현).

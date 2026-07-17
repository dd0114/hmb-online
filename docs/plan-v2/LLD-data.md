# LLD — data (선수·경제 시드 데이터)

> 에픽: data · owned-glob `data/**`. 산출물은 **버전 파일**(v1)로 발행 — 소비자(server-java)는 파일만 읽는다.
> 실선수 금지: 이름 전부 가상(음절 조합 생성), ID `P001`~. 분포만 실축구 참고. 추후 전량 교체 = v2 발행.

## 1. 산출물

```
data/players/
  generate.ts          # 시드 고정 생성 스크립트 (npx tsx data/players/generate.ts)
  players.v1.json      # PlayerSeed[] 110명
  economy.v1.json      # 경제·확률 SoT
  bots.v1.json         # 봇 3종 (덱은 players.v1 ID 참조)
  data.test.ts         # 검증(vitest) — AC-D1~D3
```

## 2. players.v1.json 스키마·분포

```ts
PlayerSeed = { id: 'P001', name: string, position: 'GK'|'DF'|'MF'|'FW',
               grade: 'BRONZE'|'SILVER'|'GOLD'|'DIA'|'LEGEND',
               attributes: PlayerAttributes }   // shared 9종 0..100
```

- 총 110명. 포지션: GK 12 / DF 36 / MF 36 / FW 26. 등급: BRONZE 40 / SILVER 30 / GOLD 20 / DIA 14 / LEGEND 6 (포지션×등급은 비례 배분, GK는 등급별 최소 1).
- 능력치 밴드(공통 9종 기본 롤): BRONZE 40–55 · SILVER 50–65 · GOLD 60–75 · DIA 70–85 · LEGEND 80–95.
- 포지션 주스탯 바이어스 +5(밴드 상한 넘으면 clamp): GK=positioning·mental / DF=tackling·positioning / MF=passing·stamina / FW=shooting·pace.
- 이름 생성: 한글 성+이름 음절 풀 조합(가상), 중복 금지. 시드 RNG(`seedrandom` 유사 — 엔진 rng 유틸 재사용 가능하나 **엔진 코드 수정 금지**, 복사 구현 허용).
- 생성 결정론(AC-D2): 스크립트 상수 `SEED='hmb-players-v1'` — 재실행 바이트 동일(JSON.stringify 2-space 고정).

## 3. economy.v1.json

```jsonc
{
  "version": "v1",
  "initialPoints": 3000,
  "starterPack": ["P00x", ...],            // 14명 고정: GK1/DF5/MF5/FW3, 브론즈~실버 (generate가 선정·기록)
  "gacha": {
    "singleCost": 300, "tenCost": 3000, "tenCount": 11,
    "rates": { "BRONZE": 0.45, "SILVER": 0.30, "GOLD": 0.15, "DIA": 0.08, "LEGEND": 0.02 },
    "tenPityMinGrade": "GOLD"
  },
  "rewards": { "win": 500, "draw": 200, "loss": 100 }
}
```

## 4. bots.v1.json

봇 3종 — 각각 `{id, name, persona, analysisText, deck:{formation, starters[11:{playerId,slotIndex,promptText?}], bench[4]}}`.

- `BOT_ATK` 공격형: persona="하이라인·강한 압박·빠른 템포로 공격적으로", 덱은 FW/MF 골드↑ 위주, FW 2명에 개인 프롬프트("적극 침투") — **개인 프롬프트 효과 시연용**.
- `BOT_DEF` 수비형: persona="로우블록·역습·안전한 패스", DF 골드↑ 위주.
- `BOT_BAL` 밸런스: persona="균형 잡힌 점유율 축구", 등급 혼합(유저 초기 덱과 비등하게 실버 중심 — 첫 승리 가능하도록).
- 덱 유효성은 data.test.ts에서 서버와 같은 규칙(11명·GK≥1·중복 금지)으로 검증.

## 5. 검증 (data.test.ts)

분포·밴드·ID/이름 유일성·zod 파싱(shared PlayerCard 호환)·starterPack 포지션 구성·확률 합=1·봇 덱 유효성·재생성 바이트 동일. 루트 `npm test`에 포함(workspace 추가).

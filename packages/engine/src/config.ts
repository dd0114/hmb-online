import type { Vec2 } from "@hmb/shared";

/**
 * EngineConfig — 엔진의 모든 튜닝 값(magic number)을 격리하는 데이터드리븐 레이어. (PRD §7-6)
 *
 * 규칙: 엔진 코드 어디에도 상수를 하드코딩하지 않는다. 밸런싱은 이 객체만 바꾼다.
 * 재현 계약: 매치는 특정 `version` 하에서만 100% 동일 재현되므로, config 를 바꾸면
 * version 을 올리고 과거 매치는 그 버전으로 핀(pin)한다. (PRD §7-4)
 */
export interface EngineConfig {
  /** config 버전 태그. MatchLog.configVersion 으로 박제된다. */
  version: string;

  /** 틱 해상도(ms). 1000 = 1초 틱(Tier B). */
  msPerTick: number;
  /** 한 경기 길이(분). 전/후반 각 절반. */
  matchMinutes: number;

  /** 피치 실좌표 크기(m). goalWidth = 골포스트 간 폭(m), 골 판정 y 범위에 사용. */
  pitch: { width: number; height: number; goalWidth: number };
  /** 좌표 모드. Tier B 는 continuous. grid 는 백로그. */
  coordMode: "continuous" | "grid";
  /** grid 모드일 때 셀 크기(m). continuous 면 무시. */
  gridSize?: number;

  /** 고정소수 정수 스케일. 위치·거리·속도는 (실수 × fixedScale) 정수로만 계산. */
  fixedScale: number;

  /** 선수 인식 반경(m) — 이 안의 동료/상대만 지각. */
  perceptionRadius: number;

  /** 속도 모델: pace(0..100)를 m/tick 으로. */
  speed: {
    /** pace=100 일 때 최고 속도(m/tick). */
    maxPerTick: number;
    /** pace=0 일 때 최저 속도(m/tick). */
    minPerTick: number;
    /** 피로 100%일 때 속도 배수(0..1). */
    fatigueFloor: number;
  };

  /** 공 이동 속도(m/tick). */
  ball: {
    passSpeed: number;
    /**
     * ⚠️ **참조 0 — 죽은 노브**(#338). 소스 전체에서 `config.ball.shotSpeed` 를 읽는 곳이 없다
     * (`grep -rn "shotSpeed"` = 이 타입 선언과 값 두 줄뿐). 슛 세기는 `kick.ts:shotPowerFx`
     * (= `contest.shotPower*` + shooting 능력치)가 소유하고, 페널티만 `contest.shotBallSpeed`
     * 라는 **다른** 노브를 쓴다. 여기 값을 바꿔도 아무 일도 일어나지 않는다.
     * 삭제하지 않는 이유 = 계약(서버 config 직렬화·골든) 영향 확인 전이라서다.
     */
    shotSpeed: number;
    /**
     * **틱당 마찰 배수**(#320) — 공의 감속을 정하는 유일한 노브. `v *= friction` 매 틱.
     *
     * 구버전에는 이 개념 자체가 없었다. 공은 "목표점까지 등속으로 걸어간 뒤 `settle()` 이
     * 속도를 25% 로 되올리고 `looseDecay` 로 깎는" 3단 인공물이었고, 그래서 궤적이
     * `12.6 → 0.9 → 3.1 → 1.9` 처럼 **비단조로 요동**했다(hero #320).
     *
     * 종류를 나누는 이유는 물리다 — 잔디에 닿는 공만 구름마찰을 받는다.
     */
    friction: {
      /** 지상 굴림(잔디 마찰). 루즈볼이 얼마나 굴러가다 서는지가 **이 값 하나로** 정해진다. */
      ground: number;
      /** 떠 있는 공(크로스·롱볼). 잔디에 안 닿으니 공기저항만 — 거의 안 줄어든다. */
      lofted: number;
      /** 슛. 골문까지 사실상 등속으로 꽂힌다(hero: "슛이 뜨면 직선으로 꽂혀야"). */
      shot: number;
    };
    /**
     * **자연 정지 임계**(m/tick, #320). 속도가 이 아래로 떨어지면 공이 선다.
     * 구버전의 "정지될 위치를 먼저 잡는다"를 대체하는 것이 이 한 줄이다 — 멈추는 **자리**가
     * 아니라 멈추는 **조건**만 있고, 자리는 그 결과로 나온다.
     */
    stopSpeedM: number;
    /**
     * **굴림 국면 판정 기준**(m/tick) — 진단·계약이 "이 공이 날아가는 중인가 굴러가는 중인가"를
     * 가르는 데만 쓰는 분류 상한이다(물리에는 관여하지 않는다). 구 `settleSpeed` 의 자리.
     */
    rollSpeedM: number;

    /* --- #306(S6) 공중볼 --- */
    /** 이 거리(m) 이상 패스는 띄워서 보낸다(lofted). 롱볼(`opt.long`)은 거리와 무관하게 항상 lofted. */
    loftMinDistM: number;
    /** lofted 공의 수평 속도 배수(<1). 같은 거리를 아치로 가면 수평 속도가 느려 체공이 생긴다. */
    loftSpeedMult: number;

    /* --- #327 착지 --- */
    /**
     * **착지 충격에 남는 수평 속도 비율**(0..1) — 아치에서 떨어진 공이 잔디에 처음 닿는
     * 순간 튀면서 수평 운동량을 잃는다.
     *
     * 이 값이 없던 동안(#327) 띄운 공은 `friction.lofted`(공기저항 0.92)만 받은 채로
     * **계획 낙하점을 지나 그대로 굴러갔다**. 0.25.0 의 `stepToward` 는 목표에서 정확히
     * 섰기 때문에 오버슛이 구조적으로 0 이었고, 속도 벡터로 바꾸면서 그 0 이 사라진 것이
     * 스로인 18.09 → 30.05 의 정체다. 낙하점에서 속도를 깎는 것이 **물리적으로 옳은 자리**다
     * (마찰값을 낮춰 덮으면 "공중의 공이 틱당 19% 감속"이라는 거짓 물리가 된다).
     */
    loftLandingKeep: number;
    /**
     * **체공 상한 틱**(#327). 계획 낙하점이 피치 밖이거나(오버힛) 도달 불가일 때도 공은
     * 언젠가 떨어진다. 이 상한이 없으면 공기저항만 받는 공이 감속 거리 150m+ 로 필드를
     * 가로질러 날아 나간다. `hangTicks` 계산의 캡이자 최후 안전망.
     */
    loftMaxAirTicks: number;

    /* --- #312(S5-B) 세기 --- */
    /**
     * 패스 세기 하한/상한(m/tick). **선수가 정한다** — 발밑에 붙이는 짧은 패스는 살살,
     * 라인을 넘기는 긴 패스는 세게. 구조는 `contest.passPowerAttrSwing`(능력치)·
     * `passPressurePowerPenalty`(압박)로 흔들린다.
     *
     * 구버전은 `passSpeed` 상수 하나(18)였고, 그것이 hero H1/H2 의 뿌리였다 —
     * 공 18 m/tick vs 선수 2.7 m/tick = **6.7배**(실제 축구 2~3배)라 "공만 순간이동하고
     * 선수는 멈춰 있는" 그림이 된다.
     */
    passSpeedMin: number;
    passSpeedMax: number;
    /** 이 거리(m)에서 세기가 상한에 도달한다(그 사이는 선형). */
    passSpeedFullDistM: number;

  };

  /**
   * 행동 선택 기본 성향 계수(볼 소유자). behavior 로 가중.
   *
   * ⚠️ **weighted 전용 — chain 기본(0.24.0+)에서는 이 블록 전체가 실행 경로에 없다**(#338).
   * 여기 있는 값은 `decision.ts:decideBallOwner`(= `chain.mode: "weighted"` 롤백 경로)의
   * 가중 추첨에만 들어간다. 사슬 코어는 행동을 **EV** 로 고르므로 가중치라는 개념 자체가 없고,
   * 대응 레버는 `chain.goalValue`(슛 볼륨) · `chain.discount`/`holdPenalty`(패스·홀드) 다.
   * → 여기를 튜닝해도 현행 밸런스는 1도 안 움직인다. 값을 지우지 않는 이유 = 롤백 스위치 자산.
   */
  decisionWeights: {
    pass: number;
    dribble: number;
    shoot: number;
    hold: number;
    /** 파이널서드(공격 진영)에서 슛 후보 가중을 곱해 슛을 지배적 선택으로 만드는 배수(>=1). */
    shootInBox: number;
    /**
     * 파이널서드에서 후진(음수 forwardGain) 패스 옵션에 주는 감점 계수(후진 m·(0.5+directness) 당).
     *
     * ⚠️ **weighted 전용 — chain 기본에서는 실행 경로가 없다**(#338). 소비자는 `scoreOption`
     * 하나뿐이고 그건 `selectPassOption` → `decideBallOwner` 에서만 불린다. 사슬 코어는
     * `passOptions` 만 쓰고 `scoreOption` 을 부르지 않는다.
     * ⚠️ 구 주석("후진 리사이클은 이걸로 억제한다")은 **현행이 아니다** — chain 에서 후진
     * 리사이클을 억제하는 것은 상태 가치의 진행도 항(`chain.advance` × `advanceExponent` 볼록성)
     * 과 `turnoverEv` 의 위치 리스크지 이 감점이 아니다. 0.24.0 이 백패스%를 11.0→24.2 로
     * 올린 것도 그 때문이다(사슬이 리사이클을 EV 로 인정한다 — 수리 대상은 S4 국면별 가중치).
     */
    backwardPassPenalty: number;
    /**
     * 파이널서드 + 사거리 안에서 슈터가 중앙(골 정면)에 가까울수록 슛 후보 가중에 주는 최대 추가 배수(>=1).
     * 실제 배수 = 1 + (shootCentralBonus-1)·centralFrac. centralFrac 은 lateral<=centralShootHalfM 에서 1→0.
     * "중앙·사거리에서 후진 패스 말고 슛" 을 강화(스트라이커 후진 리사이클 버그 대응).
     */
    shootCentralBonus: number;
    /**
     * 걷어내기(#314 A) 후보의 기본 가중. 0 이면 걷어내기가 **생성되지 않는다**(롤백 스위치).
     * 실제 가중은 여기에 압박 인원·자기 진영 깊이가 곱해진다(`clearance` 블록 참조).
     */
    clearance: number;
  };

  /**
   * 걷어내기(#314 A) — hero 제보 ⓐ "수비수가 경합 상황에서 걷어내야 할 때 가만히 있다".
   *
   * 구조적 원인은 **행동 집합에 걷어내기가 없었다**는 것이다({shoot, pass, dribble, hold} 뿐).
   * 좋은 패스가 없고 압박이 붙은 자기 진영에서는 "안전한 옵션이 없으니 홀드" 가 최선이 되어,
   * 수비수가 공을 발밑에 두고 공격수를 기다린다.
   *
   * 걷어내기는 **패스가 아니다** — 의도 수신자가 없고(양 팀 루즈볼 경합), 정확도가 낮다.
   * 그래서 `passOutcome` 을 달지 않는다(벤치 78–85% 패스 성공률 캘리브레이션을 오염시키지 않는다).
   */
  clearance: {
    enabled: boolean;
    /**
     * 발동 상한 진행도(0..1, 자기 골라인=0). 이보다 앞(공격 진영)에서는 걷어내지 않는다 —
     * 상대 진영에서 걷어내는 건 축구가 아니라 포기다.
     *
     * ✅ chain 기본에서도 **살아 있다** — `clearanceEligible` 을 두 코어가 공유한다(#338 재확인).
     * (다만 chain 에서는 `clearanceWeight` 의 깊이 스케일 항으로는 쓰이지 않는다 = 게이트 전용.)
     */
    maxProgress: number;
    /**
     * 발동 최소 압박 인원(`contest.passPressureRangeM` 안 상대 수).
     * ✅ chain 기본에서도 **살아 있다**(`clearanceEligible` 공유, 게이트 전용).
     */
    minPressers: number;
    /**
     * "좋은 패스 옵션"의 임계. 최선 패스 점수가 이 값 이상이면 걷어내지 않는다 —
     * 걷어내기는 **패스가 없을 때의 수단**이지 기본 선택지가 아니다.
     *
     * ⚠️ **weighted 전용 — chain 기본(0.24.0+)에서는 실행 경로가 없어 튜닝해도 무효**(#338).
     * 소비자는 `clearanceWeight` 뿐이다. 사슬 코어는 명시 게이트 대신 걷어내기와 패스의 **EV 를
     * 직접 비교**하므로("좋은 패스가 있으면 그 EV 가 더 높다") 이 임계가 필요 없다.
     */
    passScoreCeil: number;
    /** 걷어내는 거리(m, 전방). */
    distM: number;
    /** 가까운 터치라인 쪽으로 미는 비율(0=정면, 1=완전 측면). */
    touchlineBias: number;
    /** 터치라인에서 남기는 여유(m) — 스로인 폭주 방지(조준 오차 전 기준). */
    touchlineMarginM: number;
    /** 조준 오차(도). 걷어내기는 정밀 패스가 아니다 → 크다. */
    aimErrorDeg: number;
    /** 세기 오차 비율. */
    powerErrorFrac: number;
    /** 세기(m/tick). 걷어내기는 세게 찬다. physical 능력치로 ±`powerAttrSwing`. */
    speedM: number;
    powerAttrSwing: number;
    /** 띄워 보내는가(true = 도착 시 헤딩 경합 = 세컨볼). */
    lofted: boolean;
    /**
     * 자기 페널티박스 안에서의 가중 배수(위험지역일수록 더 자주 걷어낸다).
     * ⚠️ **weighted 전용 — chain 기본(0.24.0+)에서는 실행 경로가 없어 튜닝해도 무효**(#338).
     * 소비자는 `clearanceWeight` 뿐이다. chain 에서 "박스 안이라 더 걷어낸다"는 `turnoverEv`
     * (자기 골 앞에서 뺏기는 손해가 크다)가 위치의 함수로 자동으로 만들어낸다 — 별도 배수가 없다.
     */
    boxWeightMult: number;
    /** 사슬 코어가 쓰는 "걷어내기가 우리 팀 공으로 남을 확률"(0..1). 루즈볼이라 0.5 근처. */
    retainProb: number;
    /**
     * 사슬 코어에서 걷어내기 EV 에 곱하는 성향 배수. 사슬은 "공을 계속 가지고 있는 것"의 턴오버
     * 리스크를 모델하지 않으므로(홀드는 그냥 시간 페널티뿐), 이 배수가 그 미모델링분을 보정한다.
     * 1.0 = 보정 없음. **이것이 사슬 코어에서 걷어내기 빈도의 유일한 노브다.**
     */
    chainEvBias: number;
  };

  /** 경합 확률 기본치. (ESMS/xG 참고) */
  contest: {
    /** 패스 성공 기준선(0..1). 중앙/후방 패스의 기본 성공확률. passing 속성으로 가감. */
    passBase: number;
    /** 전진 패스 페널티(전진 정도 0..1 에 곱해 성공확률에서 차감). */
    passForwardPenalty: number;
    /** 수신자가 파이널서드일 때 추가 성공확률 페널티. */
    passFinalThirdPenalty: number;
    /** 볼 소유자를 압박하는 상대 1명당 성공확률 페널티. */
    passPressurePenalty: number;
    /**
     * 패스 압박 카운트 반경(m) — 이 안의 상대만 패스 압박으로 센다. movement.pressRange(22m,
     * 압박 배정용)는 패스 성공률 페널티엔 과도(거의 모든 패스에 3~4명 적용 → 성공률 광범위 하향).
     * 근접(~6m) 압박만 세어 패스 성공률을 벤치에 정합시키고 압박 효과를 국소화한다.
     */
    passPressureRangeM: number;
    /** 패스 거리(m)가 baseDist 를 넘는 매 m 당 성공확률 페널티. */
    passDistancePenalty: number;
    /** passDistancePenalty 가 적용되기 시작하는 기준 거리(m). */
    passBaseDistM: number;
    /** passing 속성(0..100, 50 기준)이 성공확률에 주는 최대 가감 폭. */
    passAttrSwing: number;
    /** 패스 실패 시 아웃오브바운즈(스로인/골킥)로 나갈 비율(나머지는 인플레이 턴오버). */
    passFailOutProb: number;
    /**
     * 패스 도착 소유 판정이 계획된 passOutcome(computePassProb 롤)을 존중하는가.
     * true: 성공 롤이면 도착점 최근접 동료(의도 리시버)가, 실패(fail_intercept) 롤이면 도착점 최근접
     *   상대가 컨트롤 → 실측 완성률 == 계획 확률. passBase 등 config 가 성공률의 실제 노브가 된다(E1).
     * false(레거시): 순수 기하(도착점 최근접 아무나) — 실패 롤이라도 의도 리시버가 우연히 되찾아
     *   "완성"으로 집계되어 성공률이 계획보다 높아짐(패스 정확도 과다의 원인).
     * 세트피스 크로스/루즈볼(passOutcome 없음)은 항상 기하 판정.
     */
    passOutcomeAuthoritative: boolean;
    /** 레인 수비수의 인터셉트 기준선(**틱당**, 아래 `interceptSpeedRefM` 로 정규화). */
    interceptBase: number;
    /**
     * #312: 비행 중 인터셉트(`tryIntercept`)의 **속도 정규화 기준**(m/tick).
     *
     * 이 확률은 원래 "공속 18 상수 = 패스당 1~2틱" 위에서 패스당 컷 비율로 맞춰졌다. 세기가
     * 선수마다 달라지면(#312) 느린 패스는 비행 틱이 2~3배로 늘어 **같은 패스가 컷 롤을 2~3배
     * 받는다** — 실측 패스 성공률 88.0 → 81.6% 로 밀렸다. 그건 리얼리즘이 아니라 **시간
     * 이산화가 바뀐 것**이고, 그대로 두면 E1 캘리브레이션(`computePassProb`)이 몰래 이중 적용된다.
     * 틱당 확률에 `speed / ref` 를 곱해 **패스당** 컷 확률을 보존한다.
     */
    interceptSpeedRefM: number;
    /** 태클 성공 기준선. */
    tackleBase: number;
    /** 슛 기대득점(xG) 기준선. */
    xgBase: number;
    /** 슛한 공의 비행 속도(m/tick). 골문으로 여러 틱에 걸쳐 날아가도록 passSpeed 급으로 억제. */
    shotBallSpeed: number;
    /** 슛 시도 최소 xG(이보다 낮으면 장거리 speculative 슛 억제). */
    shootXgThreshold: number;
    /** 슛 시도 가능한 최대 사거리(m, 상대 골대 기준). */
    shootRange: number;
    /** 각도 페널티 계수(중앙에서 벗어날수록 xG 감소). */
    shootAngleFactor: number;
    /** 거리 페널티 계수(멀수록 xG 감소). */
    shootDistanceFactor: number;
    /** 슛의 유효슛(on target) 기준 확률. shooting/거리로 가감. */
    onTargetBase: number;
    /** 세이브된 유효슛이 코너로 굴절될 확률. */
    saveCornerProb: number;
    /** GK 세이브 캐치 지점 = 골라인에서 필드 안쪽으로 이 거리(m). 0 이면 골라인 위(=골문 안, 골 오인). */
    saveCatchDepthM: number;
    /** 세이브 굴절 코너 시 공이 포스트 밖으로 나가는 옆 거리(m). 키퍼가 이 지점 앞으로 다이빙해 쳐낸다
     *  (키퍼 궤적 위 = 세이브 가시). 작게(≈1.5) 잡아 키퍼 근처 = 터치 보이되 골문 밖(골 오인 방지). */
    saveCornerWideMarginM: number;
    /** 빗맞은 슛이 수비 블록에 맞고 코너로 굴절될 확률(나머지는 골킥). */
    offTargetBlockCornerProb: number;
    /**
     * 빗맞은(off_target) 슛이 골포스트 바깥으로 벗어나는 옆 거리(m). 도착 프레임 y = 골중앙 ± (골반폭 + 이 값).
     * 포스트 바깥 margin — 관중 시점에서 공이 골문 옆으로 벗어나 보이게 하는 횡방향 여유.
     */
    offTargetWideMarginM: number;
    /**
     * 빗맞은(off_target) 슛이 골라인을 살짝 넘어 필드 밖으로 나가는 거리(m). 도착 프레임 x = 골라인 ± 이 값
     * (필드 바깥 방향, home 골라인 105→+, away 골라인 0→-). >0 이어야 공이 "골대 옆으로 슉 벗어나는"
     * 프레임이 보인 뒤(shot_out 정지) 골킥/코너로 재시작된다. 코너 깃발 직행 금지.
     */
    offTargetOverrunM: number;
    /**
     * 빗맞음 좌우 분산: 슈터가 골중앙 기준 위/아래 어느 쪽이냐에 따라 그 쪽으로 빗나갈 확률(0..1).
     * 시드 롤이 이 확률을 넘으면 반대쪽으로 빗나가 항상 같은 쪽 반복을 막는다. 0.5 면 완전 무편향.
     */
    offTargetSideBias: number;
    /**
     * 중앙 슛 부스트(shootCentralBonus) 판정용 중앙 존 반폭(m). lateral<=이 값이면 완전 중앙(centralFrac=1).
     * ⚠️ **weighted 전용 — chain 기본(0.24.0+)에서는 실행 경로가 없어 튜닝해도 무효**(#338).
     * 짝인 `decisionWeights.shootCentralBonus` 와 함께 `decideBallOwner` 안에서만 쓰인다.
     */
    centralShootHalfM: number;
    /** 볼 주인을 태클할 수 있는 접근 거리(m). */
    tackleRange: number;
    /** 비행 중 패스를 가로챌 수 있는 거리(m). */
    interceptRange: number;
    /** 도착·루즈볼을 잡을 수 있는 컨트롤 거리(m). */
    controlRange: number;
    /**
     * #181: 공이 낙하점에 닿았는데 claimant 가 아직 controlRange 밖일 때, 공을 그 자리에 세워두고
     * 기다릴 최대 틱 수. 이 틱을 넘기면 기존 기하 판정으로 폴백(교착 방지).
     * 0 이면 레거시 동작(즉시 소유 이전 = 공이 사람에게 순간이동).
     */
    arrivalWaitMaxTicks: number;
    /** 1대1(단독 찬스) 판정: 슈터 반경 이 거리(m) 안에 비-GK 상대가 없으면 단독 찬스로 본다. */
    oneOnOneClearM: number;
    /** 1대1 시 xG 배수(하이라이트·높은 xg). 1 이면 비활성(부스트 없음). */
    oneOnOneXgMult: number;
    /** 1대1(단독 찬스)로 판정되면 슛 후보 가중에 곱하는 배수(>=1). 슛을 거의 강제. */
    oneOnOneShootBias: number;

    /* --- #312(S5-B) 정확도: 의도 vs 실제 --- */
    /**
     * 조준 오차의 기준 각도(도). 구버전엔 이 개념 자체가 없었다 — `planPass` 가 성공/실패를
     * **먼저 굴린 뒤** 성공이면 리시버에게 **정확히**, 실패면 다른 목표를 **정확히** 맞혔다.
     * 즉 "빗나감 = 다른 목표를 정확히 맞히는 것"이었다(hero H1).
     *
     * 이제는 의도 지점을 기준으로 **각도가 흔들리고**(이 값) **세기가 흔들린다**
     * (`passPowerErrorFrac`). 도달점은 그 오차의 결과다.
     *
     * ⚠️ 성공/실패 롤(`passOutcomeAuthoritative`)은 **그대로 둔다**. 그것이 벤치 78–85%
     * 캘리브레이션의 근간이고, 오차만으로 성공률을 만들면 노브가 사라진다. 바뀐 것은
     * **실패의 기하**다 — 실패는 이제 "가장 가까운 상대를 정조준"이 아니라 **큰 조준 오차**이고,
     * 그 오차가 떨군 지점에서 가장 가까운 상대가 회수한다.
     */
    passAimErrorDeg: number;
    /** 실패 패스의 조준 오차 배수(성공 대비). 실패 = 크게 빗나감. */
    passFailAimErrorMult: number;
    /** passing 속성(0..100, 50 기준)이 조준 오차를 줄이는 최대 비율(0..1). */
    passAimAttrSwing: number;
    /** 근접 압박 1명당 조준 오차 배수 가산. */
    passPressureAimPenalty: number;
    /** 세기 오차(의도 세기 대비 ±비율). 실제 도달점은 의도점보다 짧거나 길어진다. */
    passPowerErrorFrac: number;
    /** passing 속성이 세기(m/tick)에 주는 최대 가감 비율. */
    passPowerAttrSwing: number;
    /** 근접 압박 1명당 세기를 깎는 비율(급하게 차면 힘이 안 실린다). */
    passPressurePowerPenalty: number;
    /** 슛 조준 오차의 기준 각도(도). shooting 속성으로 줄어든다. */
    shotAimErrorDeg: number;

    /* --- #306(S6) 공중 경합 --- */
    aerial: {
      enabled: boolean;
      /** 공중볼 도착 시 경합에 낄 수 있는 반경(m). 점프·헤딩이라 controlRange 보다 넓다. */
      rangeM: number;
      /** 경합 점수의 physical 비중(나머지는 positioning). */
      physicalWeight: number;
      /** 거리 감점 기준(m) — 이 거리에서 점수 0 이 되도록 선형 감점. */
      distanceRefM: number;
      /** 경합 승자가 공을 **잡을**(발밑 컨트롤) 기본 확률. 실패하면 헤더로 떨궈 루즈볼. */
      controlBase: number;
      /** 헤더로 걷어낸/떨군 공의 속도(m/tick). */
      clearSpeed: number;
      /** 헤더 슛 xG 배수(<1: 발보다 어렵다). */
      headerXgMult: number;
      /** 헤더 슛을 시도하는 최대 사거리(m). 헤더는 멀리서 못 쏜다. */
      headerShootRangeM: number;
    };
  };

  /**
   * rules — 축구 규칙(파울/카드/페널티/오프사이드) 노브. (research/football-stats.md 빈도)
   * 모든 확률·거리는 이 블록에서만 조정한다(하드코딩 금지). 시드 Rng 로만 판정.
   */
  rules: {
    /** 파울(태클 시도 시). */
    foul: {
      /** 태클 시도 1회당 파울 기본 확률. aggression/tackling 으로 가감. */
      base: number;
      /** 태클러 pressAggression 이 파울 확률에 주는 가중(0..1 → ×(0.5+aggression·이 값)). */
      aggressionWeight: number;
      /** 태클 능력(0..100) 낮을수록 파울↑ 계수(×(1 + 이 값·(1-tackling/100))). */
      tacklingRelief: number;
      /**
       * 피파울 지점이 수비 박스 안이면 파울 확률에 곱하는 배수(박스 내 필사 태클 → 페널티 유발).
       * 파울 총량을 올릴 때 이 값이 크면 페널티가 함께 늘어 **골이 폭증**한다(실측: base 만 올리면
       * 골 1.58→2.25). 1.0 이면 박스 안이라고 더 파울하지 않아 파울 빈도와 골을 분리할 수 있다.
       */
      boxFoulMult: number;
      /** 이미 경고(옐로) 받은 선수의 파울 확률 배수(<1, 신중해짐 → 2옐로 퇴장 억제). */
      bookedRelief: number;
    };
    /** 카드(파울 심각도). */
    card: {
      /** 파울당 옐로카드 확률. */
      yellowProb: number;
      /** 파울당 직접 레드카드 확률(드묾). 옐로 2장 누적도 퇴장. */
      redProb: number;
    };
    /** 페널티(수비 박스 내 파울). */
    penalty: {
      /** 페널티 박스 깊이(골라인에서, m). */
      boxDepthM: number;
      /** 페널티 박스 반폭(중앙에서, m). */
      boxHalfWidthM: number;
      /** 페널티 스팟 거리(골라인에서, m). */
      spotM: number;
      /** 페널티킥 xG. */
      xg: number;
      /** 페널티 준비 정지(dead ball) 틱. */
      stoppageTicks: number;
      /** 박스 파울 후 공을 접촉 지점에 두는 "파울 비트" 정지 틱(2단계 페널티: 이후 스팟 배치+런업). */
      foulBeatTicks: number;
    };
    /** 오프사이드. */
    offside: {
      /** 오프사이드 판정 활성화. */
      enabled: boolean;
      /** 라인 초과 허용 오차(m). 리시버가 2nd-last 수비수보다 이 이상 앞서야 오프사이드. */
      toleranceM: number;
      /** offsideTrap on 인 수비팀은 라인을 이만큼(m) 상향 → 더 자주 유도. */
      trapBiasM: number;
      /**
       * 기하학적으로 오프사이드인 전진 패스가 실제로 깃발이 오를 확률(0..1).
       * 공간 엔진은 공격수 온사이드 런 타이밍을 모델링하지 않아 대부분의 전진 패스가
       * 기하학적으로는 라인 앞이므로, 실제 리그 빈도(팀 ~1-3회)에 맞추는 호출 게이트.
       * offsideTrap on 이면 이 확률을 trapCallMult 로 가중.
       */
      callProb: number;
      /** offsideTrap on 인 수비팀 상대일 때 callProb 배수. */
      trapCallMult: number;
    };
    /** 프리킥(파울/오프사이드) 준비 정지 틱. */
    freeKickStoppageTicks: number;

    /**
     * 데드볼(세트피스) 정지 중 상대 접근 금지 — 실제 축구 규칙(#176).
     * IFAB: Law 8 킥오프·13 프리킥·14 페널티·17 코너 = 9.15m, Law 15 스로인 = 2m,
     * Law 16 골킥 = 차는 팀 페널티에어리어 밖. 상대는 밀려나지 않고 **걸어서** 물러난다(#59 철학).
     * 거리는 규칙 상수라 사실상 고정이지만, 밸런스가 흔들릴 때 되돌리는 대신 **여기를 조정**한다.
     */
    deadBall: {
      /** 프리킥/코너/킥오프/페널티에서 상대가 스팟에서 떨어져야 할 거리(m). Law 상 9.15. */
      opponentDistanceM: number;
      /** 스로인에서 상대가 떨어져야 할 거리(m). Law 상 2. */
      throwInDistanceM: number;
      /** 골킥·페널티·자기박스 프리킥에서 상대를 페널티박스 밖으로 물릴지(Law 16/14/13). */
      boxClear: boolean;
      /** 금지구역 경계 바깥 여유(m). 고정소수 반올림으로 경계에 걸치지 않게 하는 마진. */
      marginM: number;
      /**
       * 정지 중 규칙기반 배치(#185/#174): 기본 배치를 재시작 스팟 쪽으로 당기는 비율(x/y, 0..1).
       * 정지 구간에서 평소 오프더볼 로직(자기 위치 피드백)을 대체해 제자리 왕복·단독 질주를
       * 원인 단계에서 없앤다. 0 이면 정지 중 전원이 포메이션 기본 배치를 지킨다.
       */
      shapeReachX: number;
      shapeReachY: number;
      /**
       * 골키퍼 전용 형태 당김 비율(#230). 필드 플레이어의 shapeReachX/Y 와 분리한다.
       *
       * 왜 분리해야 하나 — 당김은 **기본 위치에서 스팟까지의 거리에 비례**하는데, 골키퍼만
       * 기본 위치가 자기 골라인이라 상대 진영 스팟까지가 90m 를 넘는다. 필드 플레이어에게
       * 35% 는 몇 미터지만 골키퍼에겐 33m 다(0.35 × 95m) — 골문을 버리고 하프라인까지 걸어
       * 나가는 그림이 된다(라이브 실측 골킥 36.7m · 스로인/프리킥 22m · 페널티 36.3m).
       * 0 이면 골키퍼는 정지 중 자기 기본 위치를 지킨다(대기 동작 노이즈는 그대로 받는다).
       */
      gkShapeReach: number;
      /**
       * 정지 중 taker 를 뺀 선수들의 이동 속도 상한(m/tick, #174). 데드볼엔 뛰지 않고 걸어서
       * 자리를 잡는다 — 정지 중엔 공도 멈춰 있어서 한 명만 풀스피드로 가로지르면 "공보다 선수가
       * 빠른" 그림이 된다. taker 는 제외한다: `walkStoppage`(#59)가 taker 의 **평소 속도**로
       * 도달 틱을 산정하므로 taker 를 캡하면 정지가 끝나도 공에 못 닿는다.
       */
      walkSpeedM: number;
      /**
       * 코너 정지 중 상한(m/tick). 코너는 rest defence 배치(#182)를 위해 하프라인까지 40m 를 오가야
       * 해서 일반 데드볼 상한(walkSpeedM)으로 묶으면 정지 안에 **도달을 못 한다**(잔류율 0).
       * 그렇다고 무제한이면 정지 중 최대 변위가 질주 수준(6.4 m/tick)으로 남는다(#174) → 중간값.
       */
      cornerWalkSpeedM: number;
      /**
       * 정지 중 대기 동작(#174 수용기준: "동상으로 보이지 않을 것"). 규칙기반 배치는 목표가 고정이라
       * 전원이 수렴하면 완전히 굳는다 → 시드 노이즈로 배치에 느린 오프셋을 준다.
       * 주기(틱)를 충분히 길게 잡아 **매 틱 방향 반전(#185)이 되지 않게** 한다(주기 1틱이면 그게 곧 진동).
       */
      idleAmpM: number;
      idlePeriodTicks: number;
      /**
       * 대기 오프셋을 버킷 경계에서 **계단으로 튀게** 할지(false), 버킷 사이를 **선형 보간**해
       * 천천히 흐르게 할지(true). (#307 H3)
       *
       * 계단이면 한 선수는 주기당 1틱만 움직이고 나머지 5틱은 완전히 굳는다 — 총 이동량은 같은데
       * "동상 프레임"만 만든다. 보간하면 같은 이동량이 주기 전체에 퍼져 굳는 프레임이 사라진다.
       * 방향은 **버킷 안에서 일정**하므로 매 틱 반전(#185)이 구조적으로 불가능하다.
       */
      idleDriftSmooth: boolean;
      /**
       * **재시작 시각에 맞춘 도착**(#307 H3). true 면 정지 중 이동 속도를
       * `남은 거리 / 남은 정지 틱` 으로 한 번 더 조인다 — 같은 최종 배치를 유지하면서 이동을
       * 창 전체에 고르게 편다.
       *
       * 왜 이 방식인가 (기각한 대안의 실측 근거):
       * 처음엔 **목표를 단계적으로 미는 램프**(기본 배치 → 최종 배치)로 만들었다. 정지 비율은
       * 22.4%→7.8% 로 잘 내려갔지만 **#185 왕복이 0.00 → 1.17/100 으로 되살아났다**(6시드 아블레이션).
       * 원인은 구조적이다 — 정지 진입 시 선수는 대개 공 근처(= 기본 배치보다 스팟에 가까운 곳)에
       * 있는데, 램프는 목표를 **기본 배치에서** 출발시키므로 선수가 먼저 뒤로 걸었다가 다시 앞으로
       * 온다. 그게 곧 방향 반전이다.
       * 도착 페이싱은 **목표를 건드리지 않는다**(최종 배치 고정) → 반전이 구조적으로 불가능하고,
       * 이동 상한이 오히려 낮아져 #174(단독 질주)에도 유리하다.
       *
       * 제외 대상 2종(둘 다 "제때 도착"이 계약인 선수라 늦추면 안 된다):
       *  - taker: `walkStoppage`(#59)가 taker 의 도달 틱으로 정지 길이를 정한다 — 페이싱으로 늦추면
       *    정지가 끝나도 공에 못 닿는다.
       *  - 접근 금지(#176) 후퇴 중인 상대: 재시작 틱에 구역이 비어 있어야 한다(Law 계약 A).
       */
      pacedArrival: boolean;
    };
  };

  /**
   * variety — 행동 변주·돌발성 노브(단조로움 해소). 모두 0 이면 결정 로직이
   * 이전(engine@0.3.0) 최적수렴 동작과 동일해진다(변주 OFF = 회귀 기준).
   * 오프더볼 변주(오버랩·로밍)는 시퀀셜 RNG 를 소모하지 않는 시드 노이즈(seed+id+tick 해시)로,
   * 볼 소유자 변주(드리블 체인·패스 후보 샘플)는 관통 Rng 로 결정한다.
   */
  variety: {
    /**
     * 드리블 체인 강도(0..1). 직전 틱 드리블했다면 이 값·능력치·공간으로 wDribble 모멘텀 가중. 0 이면 체인 없음.
     * ⚠️ **weighted 전용 — chain 기본(0.24.0+)에서는 실행 경로가 없어 튜닝해도 무효**(#338).
     */
    dribbleChainProb: number;
    /**
     * 드리블 모멘텀 최대 추가 배수 계수.
     * ⚠️ **weighted 전용 — chain 기본(0.24.0+)에서는 실행 경로가 없어 튜닝해도 무효**(#338).
     */
    dribbleChainBonus: number;
    /**
     * 드리블 체인 최대 길이(틱). 이 이상 연속 드리블이면 모멘텀 소멸(볼 독점 방지).
     * ⚠️ **chain 기본에서 행동에 영향이 없다**(#338). `match.ts` 가 `dribbleStreak` 을 이 값으로
     * 클램프하며 계속 **쓰기**는 하지만(그래서 완전한 죽은 값은 아니다 — 상태·해시에 남는다),
     * 그 카운터를 **읽는** 곳은 weighted 의 모멘텀 가중 하나뿐이다. `dribbleStreak` 자체의
     * 정리는 별건(#338 잔여)이라 여기서 건드리지 않는다.
     */
    dribbleChainMaxTicks: number;
    /** 수비/풀백 오버랩 발동 확률(시드 노이즈 임계). widthTendency·팀 전진성으로 가중. */
    defenderOverlapProb: number;
    /** 오버랩 대상 판정: base 진행도(0..1)가 이 값 미만인 선수(수비/풀백)만 오버랩. */
    overlapBaseLine: number;
    /** 오버랩 시 추가 전진량(정규화 x, 골 방향). 뒤 공간 노출 리스크 동반. */
    overlapReach: number;
    /** 오버랩 결정 시드 노이즈의 시간 버킷 길이(틱) — 여러 틱 지속(플리커 방지). */
    overlapPeriodTicks: number;
    /**
     * 패스 후보 샘플 온도(0..1). 0 이면 argmax(최적 1개). 클수록 상위 후보 중 시드 가중 샘플 분산↑.
     * ⚠️ **weighted 전용 — chain 기본(0.24.0+)에서는 실행 경로가 없어 튜닝해도 무효**(#338).
     * 소비자가 `selectPassOption` 하나뿐이고 chain 은 그 함수를 부르지 않는다(후보를 EV 로 고른다).
     * 사슬 코어의 대응 노브는 **`chain.temperature`** 다(`decideBallOwnerChain` 의 상위-k 샘플).
     */
    decisionTemperature: number;
    /** 오프더볼 목표 위치 시드 노이즈 진폭(m). positioningFreedom 로 가중. 0 이면 로밍 없음. */
    roamNoiseAmp: number;
    /** 로밍 노이즈 시간 버킷 길이(틱) — 이 주기로 목표 오프셋이 갱신된다. */
    roamPeriodTicks: number;
  };

  /**
   * longPass — 의도적 롱패스/롱킥(E2). 인식 반경 밖(minM~maxM) 전진 동료를 롱볼 후보로 추가.
   * 롱패스 성공률은 computePassProb 의 거리 페널티로 숏보다 낮게 나온다(별도 곡선 아님).
   * MatchEvent(pass/interception) detail="long" 으로 뷰어(β)가 구분. 비율은 selectBias 로 12–15%.
   */
  longPass: {
    /** 롱패스 후보 생성 활성화. false 면 반경 내 숏만(레거시). */
    enabled: boolean;
    /** 롱으로 치는 최소 거리(m) — 인식 반경보다 커야 의미(반경 내는 숏). */
    minM: number;
    /** 롱패스 후보 최대 거리(m). 이보다 먼 동료는 후보 제외. */
    maxM: number;
    /** 롱 옵션 선택 가중(scoreOption 가산). passDirectness 로 추가 가중. 클수록 롱 비율↑. */
    selectBias: number;
    /** 롱 옵션 점수의 전진 이득(forwardGain) 캡(m). 원거리 롱볼의 큰 전진값이 선택을 지배하지 않게. */
    fwdCapM: number;
    /** 롱 옵션 점수의 거리 페널티 계수(m당). 숏(0.15)보다 크게 두어 롱을 상황적으로만 선택. */
    distPenalty: number;
  },

  /** 세트피스(코너/스로인/골킥/골 후) 재시작 튜닝. */
  setPiece: {
    /** 재시작 전 정지(dead ball) 틱 수 — 인플레이 시간 하향 + 재배치. */
    stoppageTicks: number;
    /** 골 후 킥오프 정지 틱 수. 이 동안 공은 네트에 머문 뒤 센터 킥오프로 리셋. */
    goalStoppageTicks: number;
    /**
     * 슛 아웃(세이브 굴절/빗맞음) 후 코너킥·골킥 세트피스 시작 전, 공을 골문 프레임(키퍼/포스트 옆)에
     * 두고 짧게 멈추는 정지 틱 수. >0 이어야 공이 골문에 먼저 도달하는 프레임이 보이고(코너 순간이동 방지),
     * 이후 restart(코너/골킥) 세트피스가 별도로 시작된다.
     */
    shotAftermathStoppageTicks: number;
    /** 골 시 공이 골라인 안쪽으로 안착하는 깊이(m). 네트 위치 = 골라인 ± 이 값. */
    goalNetDepthM: number;
    /**
     * 킥오프(경기 시작·골 후 재시작·후반 시작) 시 전 선수를 formation 기본 배치(baseFx = 슬롯)로
     * 리셋할지. true 면 "골 넣으면 원래 포메이션으로 다시 시작"(흩어진 상태 → 정렬 킥오프 배치).
     * false 면 리셋 없이(테이커만 센터) 흩어진 상태 유지(레거시).
     */
    resetFormationOnKickoff: boolean;
    /** 코너 시 공격팀 선수들이 박스로 몰리는 강도(정규화 당김). */
    cornerBoxReach: number;
    /** 파이널서드 경계(공격 방향 정규화 x, 0..1). 패스/코너 판정용. */
    finalThirdLine: number;
    /** 코너 크로스 공 비행 속도(m/tick). taker 가 박스로 올리는 딜리버리. */
    crossSpeed: number;
    /** 코너 크로스 낙하점 깊이(골라인에서 필드 안쪽 m). 6야드~페널티스팟 부근. */
    crossDepthM: number;
    /** 코너 크로스 낙하점 중앙 기준 좌우 산포 최대(m). 시드로 ±이 범위. */
    crossWidthM: number;
    /**
     * 코너 시 "박스로 안 올라가는" 선수 배치(#182). 실제 축구의 rest defence(공격팀이 역습
     * 대비로 뒤에 남기는 1~2명)·하이 아웃렛(수비팀이 앞에 남기는 1~2명)에 해당한다.
     *
     * **인원은 여기 상수로 고정되지 않는다** — 팀 전략과 선수 성향으로 정해진다(hero 확정):
     *  (1) 팀 축: 가담도 commit = f(defensiveLineHeight, tempo) 0..1 → 잔류 인원을
     *      stayBackMax(수비적)~stayBackMin(올인) 사이로 매핑. 팀마다 기본값이 다르고
     *      전술을 바꾸면 같이 바뀐다.
     *  (2) 선수 축: 프롬프트가 만든 behavior(forwardRunFreq·supportDepth)가 슬롯 깊이를
     *      **뒤집는다** — 원래 남을 CB 가 올라가고, 원래 올라갈 공격수가 남는다.
     *      뒤집는 힘 = playerOverrideWeight.
     * 여기 값들은 그 매핑의 튜닝 상수일 뿐이다.
     */
    corner: {
      /** false = 레거시(전원 전진). 롤백 스위치 — 켜기 전과 bit-identical. */
      enabled: boolean;
      /** 공격 코너 잔류 인원 매핑. commit=1(올인) → Min, commit=0(수비적) → Max. */
      stayBackMin: number;
      stayBackMax: number;
      /** 수비 코너 하이 아웃렛 인원 매핑. 0/0 이면 끔(수비팀은 전원 박스). */
      leaveHighMin: number;
      leaveHighMax: number;
      /** 팀 가담도 commit 을 만들 때 수비라인 높이·템포에 주는 가중치. */
      commitLineWeight: number;
      commitTempoWeight: number;
      /** 선수 성향(프롬프트)이 슬롯 깊이 순서를 뒤집는 힘. 0 이면 슬롯 깊이만으로 결정. */
      playerOverrideWeight: number;
      /** 잔류 선수가 서는 라인(공격 진행도 0:자기골 ~ 1:상대골). 0.5=하프라인. */
      stayBackLineX: number;
      /** 하이 아웃렛이 서는 라인(자기 공격 진행도). */
      leaveHighLineX: number;
      /**
       * 잔류/아웃렛이 **한 줄로 정렬되지 않게** 하는 깊이 산포(#182 폴리시).
       * 실제 rest defence 는 전원이 같은 깊이에 서지 않는다 — CB 는 좀 더 깊게, 남은 미드는
       * 좀 더 앞에. 두 축으로 만든다(둘 다 0 이면 구 동작 = 전원 같은 라인):
       *  - slotSpread: 자기 포메이션 슬롯 깊이를 얼마나 유지하는가(0=완전 정렬, 1=원래 깊이).
       *    역할 기반이라 "CB 가 풀백보다 뒤"라는 자연 층이 생긴다.
       *  - jitterX: 잔류 그룹 **내 순위**로 깊이를 균등 배분하는 간격(rank 당 이만큼 차이).
       *    슬롯이 같은 좌우 대칭 선수(LCB/RCB)도 이걸로 갈라진다. 난수가 아니라 순위 기반이라
       *    **충돌이 구조적으로 없다** — idHash 난수 편차로 벌렸을 땐 특정 선수쌍이 우연히
       *    겹쳐 그 팀이 매 코너 일자 정렬이 됐다(실측 11/52 코너).
       */
      slotSpread: number;
      jitterX: number;
    };

    /**
     * 프리킥 루틴(#307 S7 / hero 제보 H4 — "프리킥 벽도 없고 주변 선수 백업도 없어").
     *
     * 픽스 전 엔진에는 **벽 로직이 아예 없었다** — `restartFreeKick` 은 taker 를 세우고 정지를 걸 뿐,
     * 수비팀은 평소 규칙기반 배치(`deadBallShapeTarget`)만 받았다. 계량 확인: 20시드 · 차는 틱 기준
     * 벽 1.70명 · 백업 1.12명(사거리 안 203건).
     *
     * 설계 규율:
     *  - **인원은 상수 하드코딩이 아니다.** 스팟의 위협거리(골까지 거리 + 각도 대용 횡오프셋)로
     *    `wallCountNear`~`wallCountFar` 사이를 선형 매핑한다. 멀거나 각이 없는 프리킥엔 벽이 안 선다.
     *  - **벽은 9.15m 바깥에 선다.** 접근 금지(#176 `deadBallZone`)와 정합해야 하며, 안쪽으로 잡히면
     *    `deadBallRetreatPoint` 가 도로 밀어내 벽이 서지 않는다 → `wallStandoffM` 로 여유를 준다.
     *  - 삼각함수 금지(§5-4). 방향은 스팟→골 벡터를 정수 고정소수로 정규화해 쓴다.
     */
    freeKick: {
      /** false = 벽·백업 없음(롤백 스위치 — 켜기 전과 bit-identical). */
      enabled: boolean;
      /**
       * 벽을 세우는 최대 **위협거리**(m). 위협거리 = 스팟→수비 골 거리 + `wallWideWeight` × 횡오프셋.
       * 횡오프셋을 더하는 것이 "각도" 대용이다 — 골라인 근처의 넓은 각 프리킥은 직접 슛 위협이 낮다.
       * (실제 축구에서도 벽은 대략 상대 진영 30~35m 안, 각이 있는 위치에서만 세운다.)
       */
      wallRangeM: number;
      /** 위협거리가 이 값 이하면 벽 인원 = `wallCountNear`. 여기서 `wallRangeM` 까지 선형 감소. */
      wallNearM: number;
      wallCountNear: number;
      wallCountFar: number;
      /** 횡오프셋을 위협거리에 더할 때의 가중(각도 대용). 0 이면 거리만 본다. */
      wallWideWeight: number;
      /** 벽이 서는 거리 = `rules.deadBall.opponentDistanceM` + 이 여유(m). 규칙 경계에 걸치지 않게. */
      wallStandoffM: number;
      /** 벽 선수 간 좌우 간격(m). */
      wallSpacingM: number;
      /**
       * 벽을 세우는 프리킥의 정지 틱 가산(실제 축구의 "벽 세우기" 시간). 벽·백업이 **걸어서**
       * 자리를 잡아야 하므로(#59/#174 순간이동 금지) 시간을 주지 않으면 자리 잡기 전에 재시작된다.
       */
      wallSetupTicks: number;
      /** 공격팀이 스팟 주변에 두는 지원 인원(숏 프리킥 옵션·리바운드 대비). */
      backupCount: number;
      /** 지원 인원이 서는 스팟 기준 반경(m). */
      backupRadiusM: number;
    };
  };

  /**
   * chain — **볼 소유자 결정을 행동 사슬 탐색으로 대체**하는 실험 코어(#279 W2 비교본).
   *
   * 왜 필요한가: 기존 `decideBallOwner` 는 각 행동의 **즉시 점수**를 가중 추첨한다. "이 패스를 하면
   * 그다음에 뭐가 되는가"를 볼 자리가 구조적으로 없어서, 백패스·슛위치·다이렉트함을 각각 노브로
   * 눌러야 하고 하나를 누르면 다른 게 튄다(0.15.0→0.17.0→0.18.0→0.19.0 매번 5~8개 재보정).
   * 사슬 탐색은 행동 하나가 아니라 **도달하는 상태**를 평가한다:
   *   EV(행동) = 성공확률 × V(성공 상태, 깊이−1) + (1−성공확률) × V(턴오버 상태)
   * 설계 출처 = RoboCup 2D agent2d 의 ChainAction(논문 공개, 코드 미사용) + 축구분석의 공간 평가.
   *
   * **`mode: "chain"` 이 기본이다(engine@0.24.0, #279 — A/B 실관전 후 hero 채택 결정).**
   * `"weighted"` 는 **롤백 스위치**로 남긴다 — 구 코어 코드는 지우지 않았고 한 줄도 바뀌지 않았으므로
   * 이 값만 되돌리면 0.23.0 의 행동으로 즉시 복귀한다(골든만 재갱신). 지우지 말 것.
   */
  chain: {
    /**
     * "chain" = 행동 사슬 EV 탐색(**기본**). "weighted" = 구 코어(즉시 점수 가중 추첨) = **롤백 스위치**.
     */
    mode: "weighted" | "chain";
    /** 탐색 깊이(1 = 이번 행동의 결과 상태만, 2 = 받은 선수의 다음 수까지). */
    depth: number;
    /** 상태 가치 V 의 항 가중치. 전부 0..1 정규화된 항에 곱한다. */
    advanceWeight: number; // 공격 진행도(0:자기골 ~ 1:상대골)
    /**
     * 진행도 항의 **볼록도**(진행도^exp). 1 이면 선형인데, 선형이면 "우리 진영에서 안전하게 돌리기"와
     * "상대 진영으로 밀고 가기"의 가치 차가 작아 **뒤로 빼는 게 최적**이 된다(1차 실행 실측:
     * 파이널서드 백패스 27%→67%). 실제 축구의 기대득점가치(EPV)도 골 근처에서 급상승하는 볼록 곡선이다.
     */
    advanceExponent: number;
    threatWeight: number; // 그 지점의 xG(슛 위협)
    spaceWeight: number; // 볼 홀더 주변 여유 공간
    /**
     * 깊이당 시간 할인(0..1). 없으면 "한 수 더 쓰는 비용"이 0 이라 **무한 리사이클이 최적**이 된다
     * (1차 실행 실측: 시퀀스당 패스 2.55→10.65, 슛 13.9→6.1). 축구에서 한 번 더 돌리는 것은
     * 공짜가 아니다 — 수비가 정렬할 시간을 준다.
     */
    discount: number;
    /** 공간 항의 기준 거리(m) — 최근접 상대가 이 거리 이상이면 공간 항 만점. */
    spaceRefM: number;
    /** 턴오버 상태의 가치를 만들 때 상대 관점 가치에 곱하는 계수(>0 = 뺏기면 손해). */
    turnoverWeight: number;
    /** 골의 가치(슛 EV = xg × 이 값 + (1−xg) × 턴오버). 전진·공간 항과 같은 스케일. */
    goalValue: number;
    /** 홀드(제자리)에 주는 시간 페널티 — 안 그러면 안전한 홀드가 최적이 된다. */
    holdPenalty: number;
    /** 드리블 성공확률(틱당). 태클 리스크 근사 — 실패하면 턴오버 상태. */
    dribbleSuccess: number;
    /** 사슬 EV 상위 K 후보에서 시드 가중 샘플할 때의 온도(0 = argmax). 변주 유지용. */
    temperature: number;
    /**
     * 탐색 예산(#279 S2). **깊이가 아니라 평가 노드 수로 상한을 건다.**
     *
     * 왜 깊이로는 안 되나: `depth` 만 있으면 비용이 분기폭^depth 다. 지금 분기폭은 "동료 수"라
     * 사실상 고정이지만, S5 가 생성기 4종(lead/through/cross/switch)을 붙이는 순간 분기폭이
     * 2~3배가 되고 depth-2 비용은 **제곱으로** 튄다. 그러면 생성기를 하나 넣을 때마다
     * "성능 때문에 못 넣는다"가 돼서 점진 도입 자체가 막힌다 — S5 의 최대 걸림돌이 이거다.
     * 노드 예산은 생성기를 아무리 늘려도 **비용 상한이 안 변한다**(RoboCup agent2d 선례:
     * 최대사슬 4 · 평가 상한 500 — 같은 이유로 노드 상한을 쓴다).
     */
    search: {
      /**
       * 한 결정(재귀 포함)에서 EV 를 평가할 수 있는 **최대 노드 수**. 여기 닿으면 그 시점의 best 로
       * 즉시 확정한다. 결정론이 안 깨지는 이유는 생성·정렬이 전순서라 **항상 같은 노드가 같은
       * 순서로** 소진되기 때문이다(자세한 논증은 chain.ts 의 컷오프 주석).
       */
      maxNodes: number;
      /** 값싼 스칼라로 프리필터한 뒤 EV 심층평가에 넣을 상위 후보 수(0 이하 = 무제한). */
      beamTop: number;
      /** 그중 **재귀**(다음 수까지)를 허용할 상위 후보 수(0 이하 = 무제한). 비용의 대부분이 여기다. */
      recurseBeam: number;
    };
  };

  /**
   * 극단 behavior(0 또는 1 근처)에 주는 소프트캡 페널티 계수.
   * ⚠️ **weighted 전용 — chain 기본(0.24.0+)에서는 실행 경로가 없어 튜닝해도 무효**(#338).
   * 유일한 소비자가 `decision.ts:softCapped` 이고 그건 `decideBallOwner` 의 가중치 계산에서만
   * 불린다. chain 은 behavior 를 EV 배수(`candidateEv` 의 `shootTendency`/`passRisk`/
   * `dribbleTendency`)로 직접 곱하며 소프트캡을 거치지 않는다.
   */
  softCap: number;

  /** 틱당 기본 피로 증가(0..1 스케일). 질주/압박 시 가중. */
  fatiguePerTick: number;

  /** 오프더볼/수비 움직임 튜닝. */
  movement: {
    /** 공격 시 전방 런 최대 전진량(정규화 x, 0..1). forwardRunFreq 로 가중. */
    forwardRunReach: number;
    /** 인포제션 폭 벌림 최대량(정규화 y 편차). widthTendency 로 가중. */
    attackWidthReach: number;
    /** 아웃오브포제션(블록) 폭(정규화 y 편차). */
    defendWidthReach: number;
    /** 인포제션 시 팀 전체 업필드 push(볼 x 를 따라 라인 전진 → length 압축·다이내믹). */
    attackLinePush: number;
    /** 아웃오브포제션 블록의 볼 x 방향 수축 강도. */
    defendCompactX: number;
    /** 아웃오브포제션 블록의 볼 y 방향 수축 강도. */
    defendCompactY: number;
    /** 수비 라인 유지 강도(base 로 복귀하는 비율). */
    lineDiscipline: number;
    /** 압박 발동 거리(m) — 볼과 이 거리 안이면 압박 런. */
    pressRange: number;
    /** 마크 시 상대 뒤쪽으로 붙는 간격(m). */
    markGap: number;
    /** 볼 소유팀이 공을 향해 지원 오는 최대 당김(정규화). */
    supportPull: number;
    /**
     * 리드패스 강도(0..1) — 패스를 리시버의 **미래 위치**로 조준하는 비율(#181).
     * 1 = 비행시간만큼 앞을 보고 찬다(= 공과 사람이 만난다). 0 = 레거시(현재 위치 조준 → 공이
     * 아무도 없는 곳에 떨어지고 도착 처리가 순간이동으로 메움).
     */
    passLeadWeight: number;
    /**
     * 골키퍼 포지셔닝(#314 C). 구버전은 **깊이가 상수**(골라인에서 피치 길이의 4%)였고 y 추종
     * 계수도 코드에 박혀 있었다(§2-4 위반). 그 결과 GK 목표가 사실상 고정점이라 **비소유팀
     * "거의 정지"의 최대 기여자**였다(역할별 실측: GK 38.6% vs 아웃필더 ~10%).
     * 실제 GK 는 공이 멀면 나오고 가까우면 골라인에 붙는다(스위퍼 라인).
     */
    gk: {
      /** 골라인에서의 최소 깊이(m) — 공이 코앞일 때. */
      baseDepthM: number;
      /** 공이 멀 때 추가로 나오는 거리(m). 실제 깊이 = base + reach·(공거리/refM). */
      sweepReachM: number;
      /** 위 비율의 기준 거리(m) — 이 거리 이상이면 최대로 나온다. */
      sweepRefM: number;
      /** 공 y 를 따라가는 비율(0..1). */
      ballYFollow: number;
    };
    /** positioningFreedom 기반 roam 계수(공 쪽 추가 당김). */
    roamFactor: number;
    /** 드리블 1틱당 골 방향 전진 비율(0..1). 박스 침투 속도. */
    dribbleReach: number;

    /**
     * 런 오더(#314 B) — hero 제보 ⓑ "차면 찰 때부터 뛰어들어가거나, 뛰어들어가는 선수를 보고 막는".
     *
     * `SimState.intents`(의도 게시판)와 `SimPlayer.runOrder` 는 S1 이 자리만 만들어 두고 아무도
     * 쓰지 않았다. 여기서 처음 소비된다: **패스를 쏘는 순간 그 도착 지점을 게시**하고,
     * 가까운 동료가 그 **앞으로 뛰어든다**.
     */
    runOrder: {
      enabled: boolean;
      /** 패스 도착 지점에서 이 반경(m) 안의 동료가 런 후보. */
      radiusM: number;
      /** 한 패스가 부르는 최대 러너 수. */
      maxRunners: number;
      /** 런 목표 = 도착 지점에서 상대 골 쪽으로 이만큼 더 앞(m). */
      aheadM: number;
      /** 런 유지 틱 = 패스 비행틱 + 이 값. */
      extraTicks: number;
      /**
       * **이 패스가 얼마나 전진해야 런을 부르는가**(m). 모든 패스가 런을 부르면 팀 전체가 상시
       * 전진 배치가 되어 공격이 구조적으로 과열된다(실측 슛/팀 12.5 → 20.1). 실제 축구의
       * 서드맨 런은 **전진 패스에 붙는 것**이지 백패스·횡패스에 붙는 게 아니다.
       */
      minPassGainM: number;
      /** 오프더볼 목표를 런 지점으로 당기는 비율(0..1). */
      pull: number;
      /**
       * 이 값(m)보다 전진 이득이 작으면 런을 걸지 않는다 — **되돌아 달리기 금지**.
       * (#181 이 "낙하점으로 되돌아 달리면 전진 런이 취소돼 공격이 죽는다"로 실측한 함정.)
       */
      minForwardGainM: number;
      /**
       * 패서 본인이 차자마자 따라 들어가는 거리(m). 0 이면 기존처럼 그 자리에 정지.
       * **전진 패스일 때만** 적용한다(#181 가드 — 뒤로 빼는 패스에 따라가면 형태가 무너진다).
       */
      passerFollowM: number;
    };
  };

  /**
   * vision — 오프더볼 시야 기반 인지·판단. (#147 W3, 후보 E)
   *
   * 레거시(enabled=false)는 오프더볼 선수가 **상대를 아예 안 봤다**(이동 목표가 상대 위치와
   * 완전 독립). 그 위에 "반경 안 전원에게 끌림" 을 얹으면 전원이 같은 정보로 같은 결론을 내
   * 공 쪽으로 몰린다. 그래서 두 계층을 함께 넣는다:
   *  1) **인지** — 1틱에 정밀 추적 가능한 상대 수가 유한(주의 예산). 나머지는 **마지막 본 위치**
   *     로 판단하고, 오래되면 잊는다 → 선수마다 아는 것이 달라진다.
   *  2) **판단** — 인지한 상대에게 무조건 붙지 않는다. 위협도 대비 도달비용으로 **한 명만** 고른다.
   *
   * 설계 근거(조사): 실제 시스템은 존재 여부를 하드 기하로 자르고 불확실성은 *정보의 질*에 둔다
   * (RoboCup 2D·SimSpark·UE·Thief 공통, "매 틱 보일 확률" 을 굴리는 사례는 없다). 기억은
   * "정확하지만 낡은" 값이며(librcsc pos_count: 선수 30틱=3초 폐기), 위치를 점점 흐리는 건
   * 표준이 아니라 연구 주제다. 우리는 1초 틱이라 순간 시야각/시선 스캔은 해상도 불일치로 기각
   * (RoboCup 은 360° 스윕이 600ms — 우리 1틱 안에 이미 한 바퀴 훑는다). 그래서 남는 이식 가능
   * 요소가 **주의 예산 + 기억/스테일** 이다.
   */
  vision: {
    /** 활성화. false 면 레거시(오프더볼이 상대를 전혀 안 봄) — 회귀 기준. */
    enabled: boolean;
    /** 인지 반경(m). 이 밖은 아예 모른다. 실측상 몰림의 레버가 아니므로 크게 흔들 값이 아니다. */
    radiusM: number;
    /** 주의 예산 기준값 — 1틱에 정밀 추적(기억 갱신)하는 상대 수. */
    attentionBase: number;
    /** 인지 속성(positioning·mental 평균)이 주의 예산에 주는 최대 가감(±명). 스탯이 시야를 넓히는 게 아니라 **주의를 늘린다**. */
    attentionAttrSwing: number;
    /** 기억 폐기 틱. 이 틱 넘게 못 본 상대는 판단에서 제외(librcsc pos_count 방식). */
    memoryTicks: number;
    /** 공격 시 아는 상대에게서 멀어지는 최대 거리(m) — 공간 찾기. */
    spaceReach: number;
    /** 수비 시 **선택한** 상대에게 붙는 최대 거리(m). */
    markReach: number;
    /** 마킹 대상 선택의 도달비용 가중(자기→상대 거리 계수). 클수록 먼 상대를 포기하고 자리를 지킨다. */
    markCostWeight: number;
    /**
     * `markTarget`(AI 전담 마크 지시)이 대상 선택 가치에 주는 가산(m 환산).
     * 레거시는 markTarget 을 **하드 오버라이드**(다른 판단 무시, 상대-내골 사이로 **목표 순간이동**)로
     * 처리했다. 이제는 대상 선택 가치의 가산이라, 실제 차이는 주로 **끌림의 형태**다 —
     * 목표를 통째로 덮어쓰는 대신 `markReach` 만큼만 당긴다.
     * 실측(4경기, chooseMarkTarget 208k 호출): 지시 대상이 인지됐을 때 **99.97% 는 지시를 따른다**
     * (bias 40 기준). 즉 "비용이 과하면 지시를 무시" 는 이론적 경계일 뿐 실경기에선 드물다.
     * ⚠️ bias 를 60 이상으로 올리면 인지 반경(radiusM 20) 안에서는 **하드 오버라이드와 구별 불가**
     * 해진다(도메인 전수탐색상 거부율 0%). 그래서 40 을 쓰고 계약이 그 경계를 지킨다.
     * (팀 레벨 상대별 가중치 opponentFocus 는 계약 #167 대기)
     */
    markTargetBias: number;
    /**
     * 마킹 가치의 기준선(m). 가치 = 기준선 − 내골까지거리 − 도달비용·가중 + markTarget 가산 이고,
     * 가치 ≤ 0 이면 **아무도 안 붙고 자리를 지킨다**. 즉 이 값이 "붙을 만한가" 의 임계 자체다.
     * 피치 대각(≈125m) 근처가 자연스러운 출발점이지만 **실측상 살아있는 노브**다 — 20시드에서
     * 90 으로 낮추면 슛 13.35→12.40(−7%), 슛→골 전환 11.15→12.43% 로 **벤치(10-12)를 벗어난다**.
     * (초판 주석은 "골 +40%" 라 적었는데 그건 4시드 표본구성 아티팩트였다 — 20시드로는 골 +3%.
     *  이 프로젝트가 반복해 밟은 함정이라 수치를 재측정해 교체했다. synchrony.ts 헤더 참조.)
     * 하드코딩 금지 대상이라 config 로 뺀다.
     */
    markValueBaseM: number;
    /**
     * **뛰어드는 선수를 보고 막는다**(#314 B 수비측). 마크 대상이 런 오더를 받은 상태면,
     * 그의 **현재 위치**가 아니라 도착 예정 지점 쪽으로 이 비율만큼 앞서 붙는다(0 = 현재 위치만).
     * 시야 계층 안에서만 작동한다 — 즉 **인지한 상대**의 런만 읽는다(전지적 정보가 아니다).
     */
    runReadFrac: number;
    /** 그 예측 선점의 상한(m). 라인을 통째로 버리고 러너를 따라가지 않게 한다. */
    runReadMaxM: number;
  };

  /** 포메이션 정규화 슬롯(0..1, 공격 방향 +x 프레임). 최소 4-3-3 정의. */
  formations: Record<string, Vec2[]>;
}

/**
 * 4-3-3 정규화 슬롯. x=진행방향(0:자기골, 1:상대골), y=폭(0:좌, 1:우).
 * 홈은 그대로, 어웨이는 엔진에서 x 를 미러(1-x)한다.
 */
const formation433: Vec2[] = [
  { x: 0.05, y: 0.5 }, // GK
  { x: 0.22, y: 0.2 }, // LB
  { x: 0.16, y: 0.4 }, // LCB
  { x: 0.16, y: 0.6 }, // RCB
  { x: 0.22, y: 0.8 }, // RB
  { x: 0.44, y: 0.32 }, // LCM
  { x: 0.4, y: 0.5 }, // CM
  { x: 0.44, y: 0.68 }, // RCM
  { x: 0.7, y: 0.2 }, // LW
  { x: 0.78, y: 0.5 }, // ST
  { x: 0.7, y: 0.8 }, // RW
];

/** 기본 EngineConfig. 밸런싱은 이 값만 조정한다. */
export const defaultEngineConfig: EngineConfig = {
  // 0.25.0 = hero 실관전 제보 5건 통합:
  //   공 물리 — #313 루즈볼 굴림 · #306 공중볼/헤딩 · #312 세기·정확도(의도 vs 실제)
  //   데드볼 — #307 프리킥 벽·백업 + 데드볼 "전원 정지" 해소
  // 0.26.0 = hero 실관전 제보 3건(#314 행동·의도 계층):
  //   ⓐ 걷어내기(clearance) 신설 — 행동 집합이 {shoot,pass,dribble,hold} 뿐이라 수비수가
  //      압박받는 자기 진영에서 "안전한 옵션 없음 → 홀드"로 굳던 것을 해소
  //   ⓑ 의도 게시판(intents)·런 오더(runOrder) 첫 소비 — 차면 그 틱에 따라 들어가고(패서·러너),
  //      수비는 그 런을 **읽어** 도착 예정 지점을 선점한다(vision.runReadFrac)
  //   ⓒ 수비 블록의 공 추종 비대칭 해소(defendCompactX 0.16→0.32) + GK 스위퍼 라인
  version: "engine@0.27.0",
  msPerTick: 1000,
  matchMinutes: 90,
  pitch: { width: 105, height: 68, goalWidth: 7.32 },
  coordMode: "continuous",
  gridSize: 5,
  fixedScale: 1000,
  perceptionRadius: 33,
  speed: {
    maxPerTick: 7.0, // ~7 m/s 질주
    minPerTick: 3.0,
    fatigueFloor: 0.55,
  },
  ball: {
    passSpeed: 18,
    shotSpeed: 26,
    // #320 마찰. 세 값 모두 **실측으로 고른 지점**이다(스윕: research 로그 대신 아래 근거).
    //  - ground 0.62: 계획 낙하점을 지나친 패스가 굴러가다 서는 총거리를 구 `settle()` 의
    //    체감 크기(~6m)와 같은 자리에 두는 값. 크게 잡으면 루즈볼이 라인 밖까지 굴러
    //    스로인이 폭증하고(구 looseDecay 0.82 실측 스로인 19.7 → 42.6/팀), 작게 잡으면
    //    "날다가 급정지"가 돌아온다.
    //  - lofted 0.92: 떠 있는 동안은 잔디에 안 닿는다 — 크로스·롱볼이 박스까지 **직선으로** 간다.
    //  - shot 0.96: 골문까지 등속. 슛이 목표 근처에서 느려지면 안 된다(hero #320 의 원문).
    friction: { ground: 0.62, lofted: 0.92, shot: 0.96 },
    // 1 m/tick 미만이면 정지. 이 아래로는 다음 틱 이동이 화면에서 정지와 구분되지 않는다.
    stopSpeedM: 1,
    // 굴림/비행 분류 상한(진단·계약 전용). 구 `settleSpeed` 와 같은 자리에서 같은 값.
    rollSpeedM: 4,
    // #306: 25m 이상은 띄워 보낸다(그 아래는 발밑 지상 패스). 롱볼은 거리 무관 항상 lofted.
    loftMinDistM: 25,
    loftSpeedMult: 0.8,
    // #327 착지. 0.36 = 아치에서 떨어진 공이 첫 바운드에 수평 속도의 64% 를 잃는다.
    // 이 값이 오버슛 거리(낙하점 → 실제 정지점)를 직접 정한다: 남은 속도 v 에 대해
    // 굴림 거리 = v·keep·ground/(1−ground) ≈ 1.63·keep·v.
    // 체공 상한 5틱 = 5초(실축 롱볼 체공 4~6초). 조준이 피치 밖인 공이 라인까지 가는
    // 동안은 덮지 않으면서(그건 계획대로 아웃이다) 무한 체공만 자르는 자리.
    //
    // 두 값은 **스로인/팀**(구조 밴드 17–19)으로 골랐다 — 60시드 스윕(#327):
    //   air6/keep0.45 20.91 ❌ · air5/keep0.45 19.60 ❌ · air5/keep0.40 18.65 ✅
    //   · air4/keep0.45 16.04 ❌ · air3/keep0.35 4.83 ❌❌ · **air5/keep0.36 18.54 ✅**
    // 착지 전이가 없던 상태는 30.05 였다. 0.25.0(stepToward, 오버슛 구조적 0)이 18.09.
    loftLandingKeep: 0.36,
    loftMaxAirTicks: 5,
    // #312: 세기 범위. 상한 16 은 구 상수(18)보다 낮다 — 공/선수 속도비 6.7배를 3~4배로
    // 내리는 것이 H1/H2 의 게이트이고, 그건 상한이 아니라 **평균**이 내려가야 달성된다.
    passSpeedMin: 8,
    passSpeedMax: 16,
    passSpeedFullDistM: 35,
  },
  decisionWeights: {
    // 슛 하향(37→~13.5/팀), 홀드/드리블 비중↑(패스 볼륨·찬스 남발 억제).
    pass: 0.5,
    dribble: 0.46,
    // G-A(#99): 슛 과다(팀 23.85→~13.6, 벤치 12-14). shoot 0.5→0.35 로 슛 성향 하향.
    // #147 W3: 시야 계층(vision)이 수비 효율을 바꿔 슛이 14.0→14.7 로 올랐다 → 벤치(12-14) 복귀용 재튜닝.
    // #181: 공이 **손 닿는 사람에게만** 가고 못 닿으면 낙하점에 멈추므로, 공이 무소유로 있는 틱이
    // 늘어 공격 볼륨(슛)이 줄었다 → 밴드(12-14) 복귀용 재튜닝 0.30→0.55(실측 슛/팀 13.68).
    // #176 리베이스: 데드볼 규칙 위에서 재도출한다(아래 재스윕 결과로 확정).
    shoot: 0.55,
    hold: 0.42,
    // shootInBox: 파이널서드 슛 후보에 곱하는 배수. 예전엔 슛을 "지배적"으로 만들려 >1(1.38) 였으나
    // 이는 슛 과다(G-A)의 주 원인 — 파이널서드에서 슛이 패스/드리블을 과하게 눌렀다. 0.6(<1)로 낮춰
    // 슛 지배를 완화(후진 리사이클은 backwardPassPenalty 2.4 + shootCentralBonus 1.35 로 계속 억제).
    // ⚠️ 위 문단은 **weighted 시절 서술이다**(#338) — chain 기본에서는 이 블록이 실행되지 않는다.
    // #178: 마크 당김 오버슛(진동) 제거로 수비 블록이 형태를 유지하게 되자 슛이 13.95→11.65 로
    // 밴드 아래로 떨어졌다(진동하던 수비수가 마크를 지나쳐 자리를 비우던 것이 슛 기회였다).
    // 0.6→0.9 로 파이널서드 슛 의지를 복원해 13.28(밴드 12-14)로 되돌린다. `shoot` 사다리 단조성
    // (shot-frequency A)은 이 값에서도 유지된다(11.63→11.68→13.28→14.35→15.28→15.78→16.83).
    shootInBox: 0.9,
    backwardPassPenalty: 2.4,
    shootCentralBonus: 1.35,
    // #314 A: 걷어내기 가중. 실측 스윕으로 팀당 10–25회/경기(실축 클리어 17–32 참고) 밴드에 맞춤.
    clearance: 0.9,
  },
  clearance: {
    enabled: true,
    // 자기 진영 절반까지만. 그보다 앞에서 걷어내면 그건 축구가 아니라 포기다.
    maxProgress: 0.42,
    minPressers: 1,
    // 최선 패스 점수가 이 값 이상이면 패스한다. scoreOption 의 실측 분포상 자기 진영 압박 국면의
    // 최선 점수는 대체로 10 미만이고, 안전한 옆 동료가 열려 있으면 그 위로 올라간다.
    passScoreCeil: 12,
    distM: 32,
    touchlineBias: 0.55,
    touchlineMarginM: 4,
    // 정밀 패스(passAimErrorDeg)의 몇 배 — 걷어내기는 조준이 아니라 처리다.
    aimErrorDeg: 14,
    powerErrorFrac: 0.2,
    speedM: 17,
    powerAttrSwing: 0.2,
    lofted: true,
    boxWeightMult: 2.2,
    retainProb: 0.45,
    // 20시드 스윕(최종 B/C 위): 1.0 → 0.3 · 1.5 → 7.9 · **1.8 → ~14** · 2.0 → 21.0 · 3.2 → 37.1 (팀·경기).
    // 게이트(팀당 10–25, 실축 클리어 17–32 참고) 한가운데를 잡는다. 스로인 20.3 → 17.3 으로
    // **줄고**(걷어내기가 라인 안쪽을 조준하므로) 파울도 안 늘어난다.
    chainEvBias: 1.8,
  },
  contest: {
    // E1(0.11.0): 패스 도착이 계획 outcome 존중(passOutcomeAuthoritative) → passBase/페널티가
    // 성공률의 실제 노브가 됨. 전진<숏(short≈0.95 fwd≈0.74 long≈0.47). 압박은 근접(6m)만.
    // E2(0.12.0): 롱패스(longPass) 추가로 평균이 낮아져 passBase 0.94→0.97 로 재보정 →
    // 리얼 20시드 패스성공 ≈80%(벤치 78-85) 유지. 스로인은 pfo 로 복원(≈17).
    passBase: 0.97,
    // #181 재보정: 도착/아웃 판정이 정확해지며 계획 실패가 전부 실현된다(구버전은 fail_out 패스가
    // 조기 도착으로 완성 처리돼 성공률이 실제보다 높게 측정됐다) → 페널티를 완화해 **실제** 성공률을
    // 벤치(78-85%)로 되돌린다. 계획확률 자체는 구버전도 ~0.70 이었다(측정만 79%로 부풀었음).
    passForwardPenalty: 0.12,
    passFinalThirdPenalty: 0.12,
    passPressurePenalty: 0.06,
    passPressureRangeM: 6.0,
    passDistancePenalty: 0.004, // #181 재보정(위와 동일 사유)
    passBaseDistM: 12,
    passAttrSwing: 0.14,
    // #181: 사이드라인 위에서 찬 공의 아웃 미검출(ball.boundaryCross t=0 누락)이 고쳐지고 조기
    // 도착이 사라지면서 계획된 fail_out 이 전부 실제 아웃이 됐다 → 같은 값이면 스로인 35(벤치 17-19).
    // 0.45→0.3 으로 스로인 20.0 (밴드 상단 근처).
    passFailOutProb: 0.26,
    passOutcomeAuthoritative: true,
    interceptBase: 0.06,
    tackleBase: 0.14,
    // G-A(#99): 슛당 xG 하향(0.13→~0.12, 벤치 0.10-0.12). 0.225→0.19.
    // #181: 슛당 xG 0.10 · 골 1.63(둘 다 밴드). v5.01 값(0.205) 유지였다.
    // #176: 데드볼 규칙으로 전개가 바뀌며 재보정. 20시드 골 1.45 · 60시드 1.53 · 슛당 xG 0.10/0.11
    // (둘 다 밴드). 코너를 걷기 캡에서 제외한 뒤 다시 잡은 값이다 — 캡 적용 시점에 맞춘 0.215 는
    // 코너 예외 후 골이 1.68 로 넘쳤다.
    // ── 0.25.0 볼륨 재보정 (0.195 → 0.42) ──────────────────────────────────────────
    // **hero 결정: 경기당 골(양팀 합) 평균 5.0 이 목표다.** 실제 축구(2.7–3.3)의 1.5~1.9배이며
    // 리얼리즘 밴드를 골에 적용하지 않는다("밸런스는 config 로 조정 가능하니 나중에. 중요한 건
    // 그런 플레이가 **가능한지**"). 그래서 이 값은 벤치(bench.ts 의 goals/shotConvPct/xgPerShot)와
    // **의도적으로 어긋난다** — 계약은 `realism/shot-frequency.test.ts` 쪽이 SoT 다.
    // 60시드 스윕 실측(gv=24 · controlRange=5.0 · onTargetBase=0.21 조합):
    //   xg 0.195→골/경기 2.7 · 0.30→3.5 · 0.40→5.2 · **0.42→5.10** · 0.44→6.2
    // ── #320 재보정 (0.42 → 0.35) ─────────────────────────────────────────────────
    // 밴드는 **하나도 안 건드렸다** — 움직인 것은 이 노브와 `chain.goalValue` 둘뿐이다.
    // 공 물리를 속도 벡터로 바꾸자 소유 틱이 회복되며(패스가 낙하점에 서지 않고 리시버에게
    // 그대로 간다) 슛 질과 양이 함께 올랐다: 팀당 슛 13.64→17.75 · 골/경기 5.10→7.15.
    // 20시드 2D 스윕(gv × xgBase) 실측: gv11 에서 0.31→골/경기 4.75 · **0.35→4.90** · 0.42→6.10.
    // 60시드 확정 실측(gv=11, xgBase=0.35): 슛 13.04 · 유효슛 4.99 · 골/경기 4.97 ·
    //   팀당 골 2.48 · 전환 19.23% · 슛당 xG 0.19 — `shot-frequency.test.ts` 여섯 밴드 전부 한가운데.
    xgBase: 0.35,
    shotBallSpeed: 14,
    shootXgThreshold: 0.07,
    // G-A(#99): 슛 사거리 20→19m. 원거리 speculative 슛 감축(슛 수 하향, 슛당 xG 는 유지 — 임계와
    // 달리 저xG 근거리 슛은 남겨 평균 xG 를 밴드에 유지).
    shootRange: 19,
    shootAngleFactor: 0.85,
    shootDistanceFactor: 0.025,
    // #147 후속: 파울 복원으로 늘어난 프리킥이 전환율을 밀어올려(10.89→13.8) 함께 낮췄다.
    // 부수 효과로 유효슛이 5.75→4.85 로 **벤치(4.5-5.5) 안에 들어왔다**(0.16.0 부터 초과였음).
    // #181 재보정: 유효슛/골을 밴드로(#178 재보정과 합산). 0.235 였다.
    // 0.25.0 볼륨 재보정: xgBase 상향으로 슛 질이 올라가자 유효슛이 5.89 로 벤치(4.5–5.5)를 넘겼다.
    // 0.235→0.21 로 되돌려 **유효슛은 벤치 안(5.37)에 유지**한다 — 골만 hero 목표로 올리고
    // 나머지 총량 지표는 리얼리즘에 붙여 두는 것이 이번 재보정의 규율이다.
    onTargetBase: 0.21,
    saveCornerProb: 0.6,
    saveCatchDepthM: 2.5, // 골라인 2.5m 앞에서 캐치 → 골문 밖(골 오인 방지). 0 이면 골라인 위.
    saveCornerWideMarginM: 1.5, // 세이브 굴절 코너: 공이 포스트 1.5m 밖(키퍼 근처=터치 보임 + 골 오인 방지).
    offTargetBlockCornerProb: 0.32,
    offTargetWideMarginM: 3.0,
    offTargetOverrunM: 3.5,
    offTargetSideBias: 0.72,
    centralShootHalfM: 12.0,
    tackleRange: 2.0,
    interceptRange: 1.5,
    interceptSpeedRefM: 18,
    // #181: 2.5m → 3.5m. 공은 이제 **손 닿는 사람에게만** 가고(순간이동 금지) 못 닿으면 낙하점에
    // 멈춰 기다리므로, 이 반경이 곧 템포다. 2.5m 면 공이 그라운드에 서 있는 시간이 과해 경기가
    // 죽는다(슛/팀 5.1). 3.5m = 한 걸음 뻗어 잡는 거리.
    // ── 0.25.0 볼륨 재보정 (3.5 → 5.0) ─────────────────────────────────────────────
    // 0.25.0 의 공 물리 3건(#313 루즈볼 굴림 · #306 공중볼 · #312 세기/정확도)이 합쳐지며
    // **공 소유 틱이 46.2% → 25.2% 로 반토막** 났다. 원인은 속도비(선수:공 6.7배→3.75배)라
    // 비행 시간이 소유 시간을 잡아먹은 것 — 그 속도비는 이번 수정의 핵심이라 **되돌리지 않는다**.
    // 대신 "첫 터치가 닿는 거리"를 새 물리에 맞춘다: 이제 패스는 조준 오차(#312, 실패 패스는 3배)를
    // 갖고 도착하고, 못 닿으면 서 있지 않고 **굴러간다**(#313). 3.5m 는 "공이 도착해 서서 기다리던"
    // 시절의 값이라 새 물리에서는 소유가 성립하지 않는다.
    // 5.0 = `aerial.rangeM`(점프·헤딩 반경)과 같은 값이라 **물리 가드가 약해지지 않는다** —
    // `realism/ball-continuity.test.ts` 의 TOUCH_REACH_M = max(controlRange, aerial.rangeM) 이
    // 이미 5.0 이었으므로 허용 접촉거리는 한 치도 안 넓어진다.
    // 60시드 실측(다른 노브 고정): 3.5→슛 7.27·코너 2.77·스로인 26.66 / 4.5→8.57 / **5.0→9.45**,
    // 그리고 최종 조합에서 코너 4.56(벤치 4–6)·스로인 18.09(17–19)가 **밴드로 복귀**한다.
    controlRange: 5.0,
    // #181: 리드패스가 조준을 맞춰주므로 대부분 대기 0틱이다. 예측이 빗나간 패스만 1~2틱 기다린다.
    // 스윕(10시드): 대기 0 → 빈공간꺾임 2건·최악 10.8m / **2 → 0건·최악 6.1m** / 3 → 0건이지만
    // 공이 멈춰 있는 시간(무소유틱)이 28.7% 로 과해 템포를 해친다.
    arrivalWaitMaxTicks: 2,
    // #316: 아래 둘은 chain 기본에서도 **살아 있다** — `decision.oneOnOneShot` 을 두 코어가 공유하고,
    // chain 은 루트(실제 슈터 자리)에서 한 번만 불러 **결과 xg + detail** 에 반영한다.
    oneOnOneClearM: 10.0,
    oneOnOneXgMult: 1.3,
    // G-A(#99): 1대1 강제슛 배수 3.2→1.8. 여전히 단독찬스는 슛을 선호하되(1v1은 슛이 정답),
    // 슛 과다에 기여하던 과도한 강제를 완화.
    // ⚠️ **weighted 전용 — chain 기본(0.24.0+)에서는 실행 경로가 없어 튜닝해도 무효**(#316/#338).
    // 이건 "슛 **가중치**"를 곱하는 노브인데 사슬 코어에는 가중치 공간이 없다(EV 만 있다).
    // EV 공간의 자명한 대응물이 없어 **의도적으로 이식하지 않았다** — 넣으면 슛 볼륨 레버가
    // `chain.goalValue` 와 이중이 된다(`decisionWeights.shoot` 이 chain 에서 무효인 것과 같은 이유).
    oneOnOneShootBias: 1.8,
    // #312(S5-B) 정확도. 기준 6도 = 20m 패스에서 횡 오차 ±2.1m(controlRange 3.5m 안) —
    // 성공 롤이 난 패스는 리시버가 한 걸음으로 흡수하고, 큰 오차는 굴러(#313) 쟁탈이 된다.
    passAimErrorDeg: 6.0,
    passFailAimErrorMult: 3.0,
    passAimAttrSwing: 0.45,
    passPressureAimPenalty: 0.35,
    passPowerErrorFrac: 0.16,
    passPowerAttrSwing: 0.15,
    passPressurePowerPenalty: 0.07,
    shotAimErrorDeg: 4.0,
    // #306(S6) 공중볼.
    aerial: {
      enabled: true,
      // 헤딩 경합 반경. 점프 포함이라 controlRange(3.5) 보다 넓다.
      rangeM: 5.0,
      physicalWeight: 0.7,
      distanceRefM: 6.0,
      // 공중볼은 발밑 패스보다 잡기 어렵다 — 절반 남짓만 컨트롤되고 나머지는 세컨볼이 된다.
      controlBase: 0.45,
      clearSpeed: 9.0,
      // 헤더는 발보다 약하다(실축 헤더 전환율 < 슛 전체).
      headerXgMult: 0.65,
      // 페널티박스 깊이(16.5m)에 맞춘다. 헤더는 멀리서 못 쏘지만 박스 안이면 시도한다 —
      // 12m 로 잡았을 때 8경기 헤더 슛이 1건뿐이었다(크로스 자체가 아직 S5 대기라 희소하다).
      headerShootRangeM: 16.5,
    },
  },
  rules: {
    foul: {
      // #147 후속: 시야 계층으로 수비수가 한 명만 붙고 자리를 지켜 접촉이 줄었다(파울 9.68→8.23,
      // 벤치 11-12). 태클 시도당 파울 확률을 올려 복원. 단독으로 올리면 프리킥이 늘어 골·전환이
      // 폭증하므로 boxFoulMult·onTargetBase 와 **함께** 잡았다(아래 주석 참조).
      // #178: 마크 당김 오버슛 제거로 수비수가 마크 옆에 **지속적으로** 머물게 되자 접촉이 늘어
      // 파울이 11.93→14.10 으로 튀었다 → 0.0185→0.016 으로 재보정(11.90).
      // #181: 패스가 실제 비행시간을 갖게 되며 틱당 태클 기회가 줄어 파울이 다시 내려갔다 →
      // 두 변경을 합친 상태에서 재측정해 벤치(11-12)로 맞춘 값(아래 §gap §5).
      // #176: 데드볼 재시작이 규칙대로 정리되며 정지 부근 접촉이 줄어 파울이 11.28→10.38(20시드)로
      // 밴드 아래로 내려갔다 → 0.0178→**0.0188**. 20시드 11.65 · 60시드 11.63(둘 다 밴드 11-12).
      base: 0.0188,
      aggressionWeight: 1.0,
      tacklingRelief: 0.6,
      boxFoulMult: 1.0,
      bookedRelief: 0.15,
    },
    card: {
      yellowProb: 0.15, // #181: #178 과 합산된 파울 총량에서 카드 밴드(1.8-2.0) 유지.
      redProb: 0.0015,
    },
    penalty: {
      boxDepthM: 16.5,
      boxHalfWidthM: 20.16,
      spotM: 11.0,
      xg: 0.76,
      stoppageTicks: 8,
      foulBeatTicks: 6,
    },
    offside: {
      enabled: true,
      toleranceM: 0.7,
      trapBiasM: 2.5,
      callProb: 0.013,
      trapCallMult: 1.8,
    },
    freeKickStoppageTicks: 8,
    deadBall: {
      opponentDistanceM: 9.15,
      throwInDistanceM: 2,
      boxClear: true,
      marginM: 0.05,
      shapeReachX: 0.35,
      shapeReachY: 0.25,
      gkShapeReach: 0,
      walkSpeedM: 2.5,
      cornerWalkSpeedM: 4.5,
      idleAmpM: 0.8,
      idlePeriodTicks: 6,
      // #307 H3. 총 이동량은 그대로 두고 "굳는 프레임"만 없앤다(계단 → 흐름).
      idleDriftSmooth: true,
      pacedArrival: true,
    },
  },
  variety: {
    // 리얼 default: 벤치마크(슛 12-16/팀, 코너 ~5/팀 등)를 유지하는 모던한 변주.
    dribbleChainProb: 0.7,
    dribbleChainBonus: 1.8,
    dribbleChainMaxTicks: 5,
    defenderOverlapProb: 0.1,
    overlapBaseLine: 0.4,
    overlapReach: 0.32,
    overlapPeriodTicks: 40,
    decisionTemperature: 0.4,
    roamNoiseAmp: 3.0,
    roamPeriodTicks: 25,
  },
  longPass: {
    // E2(0.12.0): 의도적 롱볼. 리얼 20시드 롱 시도 비율 ≈14.6%(벤치 12-15), 롱 성공<숏.
    enabled: true,
    minM: 30, // perceptionRadius(33) 근처 밖부터 롱볼 — 30m+ 전진 볼.
    maxM: 55, // 하프라인 넘는 전환/롱볼 상한.
    selectBias: 4.2, // #181: 패스 도착이 정확해지며 롱 시도 비율이 올라(16.5%) 밴드(12-15)로 재보정.
    fwdCapM: 22,
    distPenalty: 0.22,
  },
  setPiece: {
    stoppageTicks: 12,
    goalStoppageTicks: 25,
    shotAftermathStoppageTicks: 3,
    goalNetDepthM: 0.5,
    resetFormationOnKickoff: true,
    cornerBoxReach: 0.85,
    finalThirdLine: 0.66,
    crossSpeed: 16,
    crossDepthM: 10,
    crossWidthM: 12,
    // #182. 중립 팀(라인 0.55·템포 0.5)은 잔류 2명 = PL 표준. 수비적 팀 3명, 올인 1명.
    // 수비팀 아웃렛(leaveHigh)은 0/0 = 끔 — 양팀 동시 변경을 피하려 별도 이슈로 분리.
    corner: {
      enabled: true,
      stayBackMin: 1,
      stayBackMax: 3,
      leaveHighMin: 0,
      leaveHighMax: 0,
      commitLineWeight: 1.0,
      commitTempoWeight: 0.5,
      // 2.2 = "양방향 완전 오버라이드"에 필요한 하한. 슬롯 깊이 폭(CB 0.16~ST 0.78 = 0.62)을
      // 성향 폭(±0.5)이 넘어서려면 W>2.0 이어야 공격수를 잔류시킬 수 있다. 이 값에서도
      // 아키타입 기본 성향은 슬롯 순서와 같은 방향이라 자연 순서(ST>윙>미드>풀백>CB)는 보존된다.
      playerOverrideWeight: 2.2,
      stayBackLineX: 0.5,
      leaveHighLineX: 0.5,
      // 0.25 → CB(슬롯 0.16)는 라인보다 ~9m 깊게, 풀백(0.22)은 ~7m 깊게 = 역할 층.
      // 지터 0.03(±3.15m)은 슬롯이 동일한 LCB/RCB 를 갈라준다.
      slotSpread: 0.25,
      jitterX: 0.03,
    },
    // #307 H4. 중립 스팟(골 20m·정면)은 벽 4명, 사거리 경계(34m)는 2명 = PL 표준 범위.
    freeKick: {
      enabled: true,
      wallRangeM: 34,
      wallNearM: 18,
      wallCountNear: 4,
      wallCountFar: 2,
      wallWideWeight: 0.35,
      // 0.35m: 고정소수 반올림 + 스냅샷 2자리 반올림(0.05) 여유를 합쳐도 9.15m 경계를 안 넘는다.
      wallStandoffM: 0.35,
      wallSpacingM: 0.8,
      // ⚠️ **벽 형성 자체에는 0 으로도 충분하다** — 도착 페이싱(rules.deadBall.pacedArrival)이
      // 정지 창 안의 도착을 보장하므로 벽은 어차피 선다(8시드 아블레이션: 0→2.77명 · 3→2.70 ·
      // 6→2.63 · 9→2.50, 벽 0명 전부 0건).
      // 그럼에도 6 을 쓰는 이유는 **밸런스 밴드**다: 0 이면 60시드 팀당 슛이 11.98 로 밴드
      // (12–14, `realism/shot-frequency.test.ts`)를 0.02 아래로 벗어난다. 밴드를 넓히지 않는다는
      // 규율(#279)에 따라 통과 지점을 쓴다. 페이싱을 끄면 이 노브가 다시 **필수**가 된다.
      wallSetupTicks: 6,
      backupCount: 3,
      backupRadiusM: 8,
    },
  },
  chain: {
    // #279 채택(0.24.0): 사슬 탐색이 기본. "weighted" 로 되돌리면 0.23.0 행동으로 롤백된다.
    mode: "chain",
    depth: 2,
    advanceWeight: 1.0,
    advanceExponent: 3.0,
    threatWeight: 18.0,
    spaceWeight: 0.35,
    spaceRefM: 12,
    discount: 0.85,
    turnoverWeight: 0.5,
    // 0.25.0 볼륨 재보정 (12 → 24). 소유 틱이 반토막 나며 슛이 12.31 → 7.27 로 무너졌다.
    // `goalValue` 는 슛 EV 의 배수라 **슛 빈도의 실제 레버**다(사다리 계약이 박제).
    // 60시드 실측(controlRange=5.0 · xgBase=0.42 · onTargetBase=0.21 고정):
    //   8→3.35 · 10→8.67 · 12→10.91 · 14→11.92 · 18→13.67 · **24→13.64** · 26→13.78 · 40→14.28
    // 24 를 쓰는 이유: 팀당 슛이 벤치(12–14) 한가운데(13.64)라 위아래 여유가 있고, 골이
    // hero 목표 5.0 에 가장 가깝다(5.10). 12 로 두면 슛 10.91 로 벤치 하한을 못 넘는다.
    // ── #320 재보정 (24 → 11) ────────────────────────────────────────────────────
    // 0.25.0 이 24 까지 올려야 했던 이유가 **사라졌다**. 그 주석의 근거는 "소유 틱이 반토막 나며
    // 슛이 무너졌다"였는데, 그 반토막의 원인이 바로 목표점 보간이었다 — 패스가 낙하점에 서서
    // 아무도 못 잡는 무소유 구간을 만들었다. 속도 벡터로 바꾸자 소유가 회복되며 같은 24 에서
    // 슛이 17.75 로 넘쳤다(밴드 12–14). 즉 **노브를 원래 자리 근처로 되돌리는** 재보정이다.
    // 20시드 실측(xgBase 고정): gv 10→슛 11.93 · **11→12.83** · 12→15.33 · 13→14.65 · 24→17.38.
    // 60시드 확정 실측(gv=11, xgBase=0.35): 팀당 슛 **13.04** — 벤치 12–14 한가운데다
    // (나머지 다섯 밴드도 전부 한가운데. `contest.xgBase` 주석에 수치 정리).
    // ── #327 재보정 (11 → 9.4) ───────────────────────────────────────────────────
    // 위 "60시드 gv=11 → 슛 13.04" 는 **띄운 공이 착지하지 않던 상태**에서 잰 값이다.
    // 착지 전이(`ball.loftLandingKeep`/`loftMaxAirTicks`)가 들어오자 라인 밖으로 사라지던
    // 공이 인플레이로 남아 같은 gv 에서 슛이 16.79 로 넘쳤다 — 노브가 아니라 **표본이**
    // 바뀐 것이므로 재보정한다.
    // 60시드 실측(착지 전이 후, keep=0.36 고정): gv 7.6→슛 3.60 · 8.4→8.09 · 9.2→12.29
    //   · **9.4→12.93** · 9.6→14.23 · 10→15.01 · 11→16.79
    // 9.4 를 쓰는 이유: 팀당 슛 12.93(밴드 12–14 중앙) · 유효슛 5.34(4.5–5.5) ·
    // 경기당 골 5.32(hero 목표 5.0). 9.2 는 골 4.80 으로 목표에서 더 멀고, 9.6 은
    // 슛 14.23 으로 밴드를 넘는다.
    goalValue: 9.4,
    holdPenalty: 0.08,
    dribbleSuccess: 0.86,
    temperature: 0.35,
    // S2 기본값은 **의도적으로 비구속(non-binding)** 이다. 계측 실측(20시드 · 결정 56,672회)
    // 기준 한 결정의 루트 후보 최댓값 **12** · 결정당 평가 노드 평균 **70.2** 라, 아래 값에서는
    // 빔·예산이 한 번도 물리지 않는다(beamClipped 0 · recurseClipped 0 · budgetHit 0 으로 검증 —
    // `chain-search.test.ts` 가 계약으로 박제한다).
    // 왜 비구속인가: S2 의 게이트가 "행동을 안 늘렸으니 지표가 안 움직여야 한다"이기 때문이다.
    // 여기서 예산을 조이면 그 조임 자체가 지표 변화의 원인이 되어 무회귀 판정이 불가능해진다.
    // **조이는 건 S5** — 생성기 4종(lead/through/cross/switch)이 붙어 분기가 실제로 터질 때,
    // 그때 이 세 값만 내리면 되고 코드는 안 바뀐다(그게 이 웨이브의 산출물이다).
    search: { maxNodes: 512, beamTop: 32, recurseBeam: 32 },
  },
  softCap: 0.25,
  fatiguePerTick: 0.0009,
  movement: {
    forwardRunReach: 0.275,
    // #147 W3: 시야의 spaceReach(공격수가 상대에게서 밀려남)가 팀 폭을 +2.2m 넓혀 벤치(40-50)를
    // 벗어났다. 스윕(20시드) 결과 0.10 이 폭 −1.1m 이면서 **슛당 xG 를 밴드로 되돌리고**(0.13→0.12)
    // 골·전환·슛을 전부 밴드 안에 유지 — 출하 후보 중 이탈이 가장 적다. 노브 반응이 비단조라
    // (0.115 가 양옆보다 나쁨) 단일 점이 아니라 스윕으로 골랐다.
    attackWidthReach: 0.10,
    defendWidthReach: 0.09,
    attackLinePush: 0.56,
    // #314 C(hero ⓒ "레드만 움직이고 블루는 가만히"): 0.16 → 0.32.
    // 구조적 원인은 **비대칭**이었다 — 소유팀은 `attackLinePush` 0.56 으로 공을 따라 크게 움직이는데
    // 비소유팀은 0.16 이라 공이 10m 움직여도 목표가 1.6m 만 움직인다(실측 비소유 2.00 vs 소유 2.36 m/tick,
    // "거의 정지" 15.1% vs 13.3%).
    // ⚠️ 로드맵 R5 주석은 "0.16 을 키우면 블록이 공을 그대로 따라가 형태가 무너진다"였는데,
    // **실측은 반대였다**(20시드 스윕): 0.16 → 0.32 에서 백4 산포 10.32 → 9.81m(더 한 줄),
    // 볼 10m 내 수비 1.34 → 1.47명(더 촘촘), 정지 15.11 → 12.56%. 형태 지표가 **동시에 좋아진다**.
    // (대안으로 "블록 전체 평행이동" 항을 넣어 봤으나, 그건 자기 골 쪽으로 과잉 후퇴해
    //  박스 앞을 비웠다 — 슛 12.8 → 19.3 · 골 4.3 → 8.3. 기각.)
    defendCompactX: 0.32,
    defendCompactY: 0.16,
    lineDiscipline: 0.5,
    pressRange: 22,
    markGap: 2.5,
    supportPull: 0.08,
    passLeadWeight: 1,
    // 구버전 상수(깊이 0.04·피치길이 = 4.2m · y추종 0.3)를 중심에 두고 스위퍼 폭만 얹었다.
    // 20시드 스윕: reach 4/ref 60 은 공이 60m 밖이면 **포화**해 다시 고정점이 된다(GK 정지 23.6%).
    // reach 9 / ref 100 이면 깊이가 2.5~11.5m 로 연속 변하고(박스 깊이 16.5m 안), GK 정지 21.1% ·
    // 비소유 정지 12.09 → 11.40%. 더 키워도(12/100) 수익이 사라진다.
    gk: { baseDepthM: 2.5, sweepReachM: 9.0, sweepRefM: 100, ballYFollow: 0.35 },
    roamFactor: 0.08,
    dribbleReach: 0.12,
    // #314 B. 값은 20시드 스윕으로 골랐다 — **볼륨 과열이 이 축의 제약**이다.
    // 게이트 없이(모든 패스에 런) 돌리면 슛/팀 12.2 → 18.5 · 골 5.5 → 9.2 로 경기가 무너진다.
    // `minPassGainM`(전진 패스만) + `maxRunners` 1 + `radiusM` 18 이 "보이는데 안 무너지는" 지점.
    runOrder: {
      enabled: true,
      radiusM: 18,
      maxRunners: 1,
      aheadM: 5,
      extraTicks: 2,
      minPassGainM: 10,
      pull: 0.5,
      minForwardGainM: 3,
      passerFollowM: 5,
    },
  },
  vision: {
    enabled: true,
    radiusM: 20,
    attentionBase: 3,
    attentionAttrSwing: 2,
    memoryTicks: 3,
    spaceReach: 6,
    markReach: 3,
    markCostWeight: 2,
    markTargetBias: 40,
    markValueBaseM: 125,
    // #314 B(수비측): 러너의 도착 예정 지점 쪽으로 선점. 상한을 두어 라인을 버리지 않게 한다.
    runReadFrac: 0.5,
    runReadMaxM: 8,
  },
  formations: {
    "4-3-3": formation433,
  },
};

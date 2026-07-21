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
    shotSpeed: number;
    /** 굴러가는(주인 없는) 공 감속 배수/틱. */
    looseDecay: number;
  };

  /** 행동 선택 기본 성향 계수(볼 소유자). behavior 로 가중. */
  decisionWeights: {
    pass: number;
    dribble: number;
    shoot: number;
    hold: number;
    /** 파이널서드(공격 진영)에서 슛 후보 가중을 곱해 슛을 지배적 선택으로 만드는 배수(>=1). */
    shootInBox: number;
    /** 파이널서드에서 후진(음수 forwardGain) 패스 옵션에 주는 감점 계수(후진 m·(0.5+directness) 당). */
    backwardPassPenalty: number;
    /**
     * 파이널서드 + 사거리 안에서 슈터가 중앙(골 정면)에 가까울수록 슛 후보 가중에 주는 최대 추가 배수(>=1).
     * 실제 배수 = 1 + (shootCentralBonus-1)·centralFrac. centralFrac 은 lateral<=centralShootHalfM 에서 1→0.
     * "중앙·사거리에서 후진 패스 말고 슛" 을 강화(스트라이커 후진 리사이클 버그 대응).
     */
    shootCentralBonus: number;
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
    /** 레인 수비수의 인터셉트 기준선. */
    interceptBase: number;
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
    /** 중앙 슛 부스트(shootCentralBonus) 판정용 중앙 존 반폭(m). lateral<=이 값이면 완전 중앙(centralFrac=1). */
    centralShootHalfM: number;
    /** 볼 주인을 태클할 수 있는 접근 거리(m). */
    tackleRange: number;
    /** 비행 중 패스를 가로챌 수 있는 거리(m). */
    interceptRange: number;
    /** 도착·루즈볼을 잡을 수 있는 컨트롤 거리(m). */
    controlRange: number;
    /** 1대1(단독 찬스) 판정: 슈터 반경 이 거리(m) 안에 비-GK 상대가 없으면 단독 찬스로 본다. */
    oneOnOneClearM: number;
    /** 1대1 시 xG 배수(하이라이트·높은 xg). 1 이면 비활성(부스트 없음). */
    oneOnOneXgMult: number;
    /** 1대1(단독 찬스)로 판정되면 슛 후보 가중에 곱하는 배수(>=1). 슛을 거의 강제. */
    oneOnOneShootBias: number;
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
      /** 피파울 지점이 수비 박스 안이면 파울 확률에 곱하는 배수(박스 내 필사 태클 → 페널티 유발). */
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
  };

  /**
   * variety — 행동 변주·돌발성 노브(단조로움 해소). 모두 0 이면 결정 로직이
   * 이전(engine@0.3.0) 최적수렴 동작과 동일해진다(변주 OFF = 회귀 기준).
   * 오프더볼 변주(오버랩·로밍)는 시퀀셜 RNG 를 소모하지 않는 시드 노이즈(seed+id+tick 해시)로,
   * 볼 소유자 변주(드리블 체인·패스 후보 샘플)는 관통 Rng 로 결정한다.
   */
  variety: {
    /** 드리블 체인 강도(0..1). 직전 틱 드리블했다면 이 값·능력치·공간으로 wDribble 모멘텀 가중. 0 이면 체인 없음. */
    dribbleChainProb: number;
    /** 드리블 모멘텀 최대 추가 배수 계수. */
    dribbleChainBonus: number;
    /** 드리블 체인 최대 길이(틱). 이 이상 연속 드리블이면 모멘텀 소멸(볼 독점 방지). */
    dribbleChainMaxTicks: number;
    /** 수비/풀백 오버랩 발동 확률(시드 노이즈 임계). widthTendency·팀 전진성으로 가중. */
    defenderOverlapProb: number;
    /** 오버랩 대상 판정: base 진행도(0..1)가 이 값 미만인 선수(수비/풀백)만 오버랩. */
    overlapBaseLine: number;
    /** 오버랩 시 추가 전진량(정규화 x, 골 방향). 뒤 공간 노출 리스크 동반. */
    overlapReach: number;
    /** 오버랩 결정 시드 노이즈의 시간 버킷 길이(틱) — 여러 틱 지속(플리커 방지). */
    overlapPeriodTicks: number;
    /** 패스 후보 샘플 온도(0..1). 0 이면 argmax(최적 1개). 클수록 상위 후보 중 시드 가중 샘플 분산↑. */
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
  };

  /** 극단 behavior(0 또는 1 근처)에 주는 소프트캡 페널티 계수. */
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
    /** positioningFreedom 기반 roam 계수(공 쪽 추가 당김). */
    roamFactor: number;
    /** 드리블 1틱당 골 방향 전진 비율(0..1). 박스 침투 속도. */
    dribbleReach: number;
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
     * 레거시는 markTarget 을 **하드 오버라이드**(다른 판단 무시, 상대-내골 사이로 강제 이동)로
     * 처리해 "무조건" 동작의 원인이었다. 이제는 **강한 가중치**로만 작용해 지시는 먹히되
     * 도달비용이 과하면 붙지 않는다. (팀 레벨 상대별 가중치 opponentFocus 는 계약 #167 대기)
     */
    markTargetBias: number;
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
  version: "engine@0.17.0",
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
    looseDecay: 0.82,
  },
  decisionWeights: {
    // 슛 하향(37→~13.5/팀), 홀드/드리블 비중↑(패스 볼륨·찬스 남발 억제).
    pass: 0.5,
    dribble: 0.46,
    // G-A(#99): 슛 과다(팀 23.85→~13.6, 벤치 12-14). shoot 0.5→0.35 로 슛 성향 하향.
    // #147 W3: 시야 계층(vision)이 수비 효율을 바꿔 슛이 14.0→14.7 로 올랐다 → 벤치(12-14) 복귀용 재튜닝.
    shoot: 0.30,
    hold: 0.42,
    // shootInBox: 파이널서드 슛 후보에 곱하는 배수. 예전엔 슛을 "지배적"으로 만들려 >1(1.38) 였으나
    // 이는 슛 과다(G-A)의 주 원인 — 파이널서드에서 슛이 패스/드리블을 과하게 눌렀다. 0.6(<1)로 낮춰
    // 슛 지배를 완화(후진 리사이클은 backwardPassPenalty 2.4 + shootCentralBonus 1.35 로 계속 억제).
    shootInBox: 0.6,
    backwardPassPenalty: 2.4,
    shootCentralBonus: 1.35,
  },
  contest: {
    // E1(0.11.0): 패스 도착이 계획 outcome 존중(passOutcomeAuthoritative) → passBase/페널티가
    // 성공률의 실제 노브가 됨. 전진<숏(short≈0.95 fwd≈0.74 long≈0.47). 압박은 근접(6m)만.
    // E2(0.12.0): 롱패스(longPass) 추가로 평균이 낮아져 passBase 0.94→0.97 로 재보정 →
    // 리얼 20시드 패스성공 ≈80%(벤치 78-85) 유지. 스로인은 pfo 로 복원(≈17).
    passBase: 0.97,
    passForwardPenalty: 0.2,
    passFinalThirdPenalty: 0.12,
    passPressurePenalty: 0.06,
    passPressureRangeM: 6.0,
    passDistancePenalty: 0.008,
    passBaseDistM: 12,
    passAttrSwing: 0.14,
    passFailOutProb: 0.45,
    passOutcomeAuthoritative: true,
    interceptBase: 0.06,
    tackleBase: 0.14,
    // G-A(#99): 슛당 xG 하향(0.13→~0.12, 벤치 0.10-0.12). 0.225→0.19.
    xgBase: 0.185,
    shotBallSpeed: 14,
    shootXgThreshold: 0.07,
    // G-A(#99): 슛 사거리 20→19m. 원거리 speculative 슛 감축(슛 수 하향, 슛당 xG 는 유지 — 임계와
    // 달리 저xG 근거리 슛은 남겨 평균 xG 를 밴드에 유지).
    shootRange: 19,
    shootAngleFactor: 0.85,
    shootDistanceFactor: 0.025,
    onTargetBase: 0.28,
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
    controlRange: 2.5,
    oneOnOneClearM: 10.0,
    oneOnOneXgMult: 1.3,
    // G-A(#99): 1대1 강제슛 배수 3.2→1.8. 여전히 단독찬스는 슛을 선호하되(1v1은 슛이 정답),
    // 슛 과다에 기여하던 과도한 강제를 완화.
    oneOnOneShootBias: 1.8,
  },
  rules: {
    foul: {
      base: 0.0115,
      aggressionWeight: 1.0,
      tacklingRelief: 0.6,
      boxFoulMult: 3.0,
      bookedRelief: 0.15,
    },
    card: {
      yellowProb: 0.17,
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
    selectBias: 6.0,
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
  },
  softCap: 0.25,
  fatiguePerTick: 0.0009,
  movement: {
    forwardRunReach: 0.275,
    attackWidthReach: 0.13,
    defendWidthReach: 0.09,
    attackLinePush: 0.56,
    defendCompactX: 0.16,
    defendCompactY: 0.16,
    lineDiscipline: 0.5,
    pressRange: 22,
    markGap: 2.5,
    supportPull: 0.08,
    roamFactor: 0.08,
    dribbleReach: 0.12,
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
  },
  formations: {
    "4-3-3": formation433,
  },
};

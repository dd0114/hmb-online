package online.hmb.league;

/**
 * 시즌 seed 공급원 — 시즌 생성 시 1회 뽑아 저장한다. 저장된 seed 로부터 봇팀 구성·일정·봇전
 * 간이결과가 전부 <b>결정론</b>으로 파생되므로(재현 계약), 공급 자체는 게임 결정론 계약 밖이라
 * SecureRandom 을 쓴다({@link TradeSeedSource} 와 동일 규약). 테스트는 이 빈을 고정 시드 큐로
 * 교체해 동점 시나리오 등을 재현한다.
 */
@FunctionalInterface
public interface LeagueSeedSource {
    String newSeed();
}

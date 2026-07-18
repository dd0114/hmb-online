package online.hmb.trade;

/**
 * 트레이드 오퍼 시드 공급자 (GachaRandomSource와 동일 패턴). 프로덕션 = SecureRandom
 * 128-bit hex({@link SecureTradeSeedSource}). 오퍼 생성(kind/target/demand/대기)·판정 롤은
 * 저장된 시드에서 파생된 결정론 PRNG(TradeService)이므로, 테스트는 이 인터페이스를 고정
 * 시드 큐로 교체해 오퍼·판정을 결정론적으로 재현한다(ERD 설계 노트 "오퍼 생성·판정 재현").
 */
public interface TradeSeedSource {
    /** 새 트레이드 슬롯/오퍼 1개에 쓸 시드 문자열(감사/재현용으로 trade_slots.seed에 저장). */
    String newSeed();
}

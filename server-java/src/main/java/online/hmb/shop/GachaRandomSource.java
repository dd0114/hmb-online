package online.hmb.shop;

/**
 * 뽑기 시드 공급자. 프로덕션 = SecureRandom 128-bit hex(SecureRandomSeedSource).
 * 추첨 자체는 시드에서 파생된 결정론 PRNG(GachaService)이므로, 테스트는 이 인터페이스를
 * 고정 시드 구현으로 교체해 결과를 결정론적으로 만든다(ERD 설계 노트: "서버 RNG는
 * SecureRandom으로 시드 생성만, 추첨은 시드 기반 결정").
 */
public interface GachaRandomSource {
    /** 새 뽑기 1회에 쓸 시드 문자열(감사/재현용으로 gacha_pulls.seed에 저장됨). */
    String newSeed();
}

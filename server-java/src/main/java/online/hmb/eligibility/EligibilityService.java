package online.hmb.eligibility;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * 노출 자격 (#296) — <b>게임을 한 판이라도 한 유저만</b> 랭킹과 원정 상대 풀에 실린다.
 *
 * <p>왜 필요한가: 두 목록의 조건이 각각 "가입했음"(랭킹)과 "활성 덱 보유"(원정)였는데, 덱은
 * <b>온보딩이 자동 지급</b>한다(스타터 15장). 즉 둘 다 사실상 "가입했음"이라 가입만 한 계정이 전부
 * 실렸다 — 라이브 160계정 중 137이 그랬고, 원정 후보 40명 중 실플레이 흔적은 9명뿐이었다(#288).
 * 운영으로 레이팅을 깎아 눌러둘 수는 있지만 그건 데이터 조작이라 새 계정마다 재발한다.
 *
 * <p>기준은 <b>완료된 경기</b>({@code matches.result IS NOT NULL})다. 진행 중 매치를 세면 매치를
 * 열어놓기만 해도 목록에 들어오는 우회로가 생긴다. 모드는 가리지 않는다(연습 포함) — hero 확정 D1.
 *
 * <p><b>off 스위치의 모양</b>: 꺼졌을 때 임계를 0 으로 만든다. 그러면 호출부는 분기 없이
 * {@code finished >= threshold} 하나로 쓰고, 0 은 언제나 참이라 필터 도입 전 동작으로 정확히
 * 돌아온다. 분기를 호출부마다 두면 "한 곳만 안 껴진" 우회로가 생긴다.
 */
@Service
public class EligibilityService {

    private final boolean enabled;
    private final int minFinishedMatches;

    public EligibilityService(
            @Value("${hmb.eligibility.enabled}") boolean enabled,
            @Value("${hmb.eligibility.min-finished-matches}") int minFinishedMatches) {
        this.enabled = enabled;
        this.minFinishedMatches = minFinishedMatches;
    }

    /** 자격 임계 — 꺼져 있으면 0(= 전원 자격). SQL 파라미터로 그대로 넘겨 쓴다. */
    public int threshold() {
        return enabled ? Math.max(0, minFinishedMatches) : 0;
    }

    /** 완료 경기 수로 자격 판정. */
    public boolean isEligible(int finishedMatches) {
        return finishedMatches >= threshold();
    }
}

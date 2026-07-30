package online.hmb.mail;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 우편함 운영 노브(#323) — {@code hmb.mail.*}. <b>전부 상한이지 기능이 아니다</b>.
 *
 * <p>왜 상한이 필요한가: 전체 발송은 <b>되돌릴 수 없는 인플레이션</b>이다. 0 하나를 더 친 이벤트
 * 보상은 회수해도(=미수령분만 막는다) 이미 받은 사람의 지갑에서 빼지 못한다. 그래서 오타 한 번의
 * 폭을 코드가 먼저 막고, 진짜로 크게 줘야 하는 이벤트는 <b>나눠 보낸다</b>(각 건이 감사에 남는다).
 *
 * <p>env 로 무배포 조정 가능: {@code HMB_MAIL_FANOUTMAX=20000} 등.
 */
@Component
@ConfigurationProperties(prefix = "hmb.mail")
public class MailProperties {

    /**
     * 한 번의 발송이 만들 수 있는 최대 수신 행 수. 넘으면 <b>거부</b>한다(조용히 자르지 않는다 —
     * 절반만 받은 이벤트는 회수도 재발송도 어렵다). 이 값을 넘어설 규모가 되면 설계 문서 §3.2 의
     * 지연 구체화로 갈아탄다(유저 API 형태 불변).
     */
    private int fanoutMax = 5000;

    /** {@code audience=USERS} 대상 목록 길이 상한. */
    private int maxUserIds = 500;

    private long maxPoints = 1_000_000L;
    private long maxGems = 100_000L;
    /** 첨부에 넣을 수 있는 카드 <b>종류</b> 수. */
    private int maxPlayerKinds = 10;
    /** 종류당 장수. */
    private int maxPlayerCount = 99;

    private int titleMaxChars = 100;
    private int bodyMaxChars = 4000;
    private int reasonMaxChars = 500;

    /** 유저 우편함 목록 길이. 만료·수령 완료도 남으므로(hero 확정 ④) 이 상한이 자연 정리를 한다. */
    private int listLimit = 50;

    /**
     * admin 발송 이력 목록의 <b>하드 상한</b>(요청 limit 을 여기까지만 허용).
     *
     * <p>⚠️ 이 값이 config 인 것은 튜닝 때문이 아니라 <b>계약을 세울 수 있게</b> 하기 위해서다.
     * 상수로 박아 두면 "단건 조회가 목록 창에 갇히지 않는다"(독립검증 MAJOR-3)를 검증하려면 캠페인을
     * 101건 만들어야 하고, 그 비용 때문에 결국 <b>어차피 참인 명제</b>를 검증하는 테스트가 된다 —
     * 2차 독립검증이 그 상태를 blocker 로 잡았다(`detail()` 을 목록 스캔으로 되돌려도 841건 전부 통과).
     * 테스트는 이 값을 1 로 낮춰 실제 조건을 만든다({@code MailFanoutCapTest} 가 상한을 낮춰
     * 팬아웃 거부를 재현하는 것과 같은 패턴).
     */
    private int campaignListMax = 100;

    public int getCampaignListMax() {
        return campaignListMax;
    }

    public void setCampaignListMax(int campaignListMax) {
        this.campaignListMax = campaignListMax;
    }

    /**
     * 동시 수령(SQLITE_BUSY) 재시도 — {@code hmb.mail.busy-retry.*}. 수치 하드코딩 금지.
     * 없으면 두 탭에서 동시에 [받기]를 누른 한쪽이 <b>500</b> 을 본다(독립검증 MAJOR-2 실측).
     * 값·형태는 {@code hmb.trade.busy-retry} 와 같게 둔다 — 같은 함정에 같은 손잡이.
     */
    private BusyRetry busyRetry = new BusyRetry();

    public BusyRetry getBusyRetry() {
        return busyRetry;
    }

    public void setBusyRetry(BusyRetry busyRetry) {
        this.busyRetry = busyRetry == null ? new BusyRetry() : busyRetry;
    }

    public static class BusyRetry {
        private int maxAttempts = 4;
        private long backoffMs = 20;

        public int getMaxAttempts() {
            return maxAttempts;
        }

        public void setMaxAttempts(int maxAttempts) {
            this.maxAttempts = maxAttempts;
        }

        public long getBackoffMs() {
            return backoffMs;
        }

        public void setBackoffMs(long backoffMs) {
            this.backoffMs = backoffMs;
        }
    }

    public int getFanoutMax() {
        return fanoutMax;
    }

    public void setFanoutMax(int fanoutMax) {
        this.fanoutMax = fanoutMax;
    }

    public int getMaxUserIds() {
        return maxUserIds;
    }

    public void setMaxUserIds(int maxUserIds) {
        this.maxUserIds = maxUserIds;
    }

    public long getMaxPoints() {
        return maxPoints;
    }

    public void setMaxPoints(long maxPoints) {
        this.maxPoints = maxPoints;
    }

    public long getMaxGems() {
        return maxGems;
    }

    public void setMaxGems(long maxGems) {
        this.maxGems = maxGems;
    }

    public int getMaxPlayerKinds() {
        return maxPlayerKinds;
    }

    public void setMaxPlayerKinds(int maxPlayerKinds) {
        this.maxPlayerKinds = maxPlayerKinds;
    }

    public int getMaxPlayerCount() {
        return maxPlayerCount;
    }

    public void setMaxPlayerCount(int maxPlayerCount) {
        this.maxPlayerCount = maxPlayerCount;
    }

    public int getTitleMaxChars() {
        return titleMaxChars;
    }

    public void setTitleMaxChars(int titleMaxChars) {
        this.titleMaxChars = titleMaxChars;
    }

    public int getBodyMaxChars() {
        return bodyMaxChars;
    }

    public void setBodyMaxChars(int bodyMaxChars) {
        this.bodyMaxChars = bodyMaxChars;
    }

    public int getReasonMaxChars() {
        return reasonMaxChars;
    }

    public void setReasonMaxChars(int reasonMaxChars) {
        this.reasonMaxChars = reasonMaxChars;
    }

    public int getListLimit() {
        return listLimit;
    }

    public void setListLimit(int listLimit) {
        this.listLimit = listLimit;
    }
}

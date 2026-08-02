package online.hmb.mission;

import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 원정 데일리 미션 설정 — {@code hmb.mission.daily.*} (#408).
 *
 * <p><b>왜 카탈로그가 economy 가 아니라 여기 있나.</b> economy(=data 발행물)는 <b>가격 곡선</b>의
 * SoT 다 — 무배포 override + reload 로 운영이 돌리는 값. 미션 카탈로그는 값이 아니라 <b>게임 규칙의
 * 구조</b>(어떤 판정으로 무엇을 재는가)라, 바뀌면 판정 코드({@link MissionRule})와 같이 움직여야
 * 한다. #245 가 {@code hmb.away.reward.mode} 는 여기 두고 <b>금액은 economy 를 참조</b>한 것과 같은
 * 갈라짐이다. 그래서 티어→금액만 {@code economy mission.reward} 가 갖는다.
 *
 * <p><b>롤백 = {@code count: 0}</b>(설계 문서 §9 의 "카탈로그를 비우면"을 실제로 되는 방식으로 옮긴
 * 것). YAML 리스트는 env·property 하나로 비울 수 없어서 "카탈로그를 비운다"는 스위치가 실제로는
 * 재배포를 요구한다 — 그러면 롤백 수단이 아니다. {@code HMB_MISSION_DAILY_COUNT=0} 이면 새 미션이
 * 생성되지 않고(이미 달성한 미수령 보상은 그대로 받을 수 있다) 화면은 섹션을 그리지 않는다.
 * 카탈로그가 비어도 같은 결과다(방어).
 */
@Component
@ConfigurationProperties(prefix = "hmb.mission.daily")
public class MissionProperties {

    /** 하루에 주는 미션 수(hero 확정 2개). <b>0 = 기능 끄기</b>(롤백 스위치). */
    private int count = 2;

    /** 슬롯당 리롤 가능 횟수(hero 확정 1회). 0 이면 리롤 버튼이 사라진다. */
    private int rerollPerSlot = 1;

    /** 미션 풀. 비면 미션이 생성되지 않는다. */
    private List<Entry> catalog = new ArrayList<>();

    public int getCount() {
        return count;
    }

    public void setCount(int count) {
        this.count = count;
    }

    public int getRerollPerSlot() {
        return rerollPerSlot;
    }

    public void setRerollPerSlot(int rerollPerSlot) {
        this.rerollPerSlot = rerollPerSlot;
    }

    public List<Entry> getCatalog() {
        return catalog;
    }

    public void setCatalog(List<Entry> catalog) {
        this.catalog = catalog;
    }

    /**
     * 미션 한 종.
     *
     * @param id     카탈로그 키({@code away_streak_2}). 행에 박제되고 분석·디버깅의 축이다
     * @param tier   {@code EASY|NORMAL|HARD} — economy {@code mission.reward} 의 키이기도 하다
     * @param rule   판정 규칙
     * @param target 목표치
     * @param title  화면 문구. <b>hero 산출물이라 임의로 고치지 않는다</b>(설계 문서 §4 표 그대로)
     */
    public static class Entry {
        private String id;
        private String tier;
        private MissionRule rule;
        private int target;
        private String title;

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public String getTier() {
            return tier;
        }

        public void setTier(String tier) {
            this.tier = tier;
        }

        public MissionRule getRule() {
            return rule;
        }

        public void setRule(MissionRule rule) {
            this.rule = rule;
        }

        public int getTarget() {
            return target;
        }

        public void setTarget(int target) {
            this.target = target;
        }

        public String getTitle() {
            return title;
        }

        public void setTitle(String title) {
            this.title = title;
        }
    }
}

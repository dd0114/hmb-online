package online.hmb.mission;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RestController;

/**
 * 원정 데일리 미션 API (#408, 계약 = {@code docs/plan-v5/away-daily-mission.md} §8).
 *
 * <ul>
 *   <li>{@code GET  /api/missions/daily} — 오늘 미션 2개(문구·진행도·목표·보상액·상태 완성형)
 *       + 전 기간 미수령 요약</li>
 *   <li>{@code POST /api/missions/{id}/claim} — 보상 수령. 409 {@code MISSION_ALREADY_CLAIMED} ·
 *       409 {@code MISSION_NOT_COMPLETED}</li>
 *   <li>{@code POST /api/missions/{id}/reroll} — 미션 교체. 409 {@code MISSION_REROLL_USED} ·
 *       409 {@code MISSION_ALREADY_COMPLETED} · 410 {@code MISSION_EXPIRED}(지난 날짜)</li>
 * </ul>
 *
 * <p>⚠️ <b>인증 제외 목록에 넣지 마라.</b> {@code /api/missions/**} 는 정의상 <b>내 것</b>이다 —
 * 공지({@code /api/notices/active})가 공개인 이유는 유저별 데이터가 0인 방송이기 때문이고, 여기엔
 * 그 논거가 성립하지 않는다({@code WebMvcConfig} 주석의 우편함과 같은 자리).
 *
 * <p>{@code {id}} = {@code daily_missions} 행 id. 없는 id 와 <b>남의 미션</b>은 같은 404 다 —
 * 갈라 두면 id 실재가 새어 나간다(#297·#323 규율).
 */
@RestController
public class MissionController {

    private final MissionService missionService;

    public MissionController(MissionService missionService) {
        this.missionService = missionService;
    }

    @GetMapping("/api/missions/daily")
    public MissionService.DailyView daily(@RequestAttribute("userId") String userId) {
        return missionService.daily(userId);
    }

    @PostMapping("/api/missions/{id}/claim")
    public MissionService.ClaimResult claim(@RequestAttribute("userId") String userId,
                                            @PathVariable("id") String id) {
        return missionService.claim(userId, id);
    }

    @PostMapping("/api/missions/{id}/reroll")
    public RerollResponse reroll(@RequestAttribute("userId") String userId,
                                 @PathVariable("id") String id) {
        return new RerollResponse(missionService.reroll(userId, id));
    }

    /** 계약이 {@code {"mission": {...}}} 다 — 미션 객체를 그대로 내면 나중에 필드를 얹을 자리가 없다. */
    public record RerollResponse(MissionService.MissionView mission) {
    }
}

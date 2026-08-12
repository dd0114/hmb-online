package online.hmb.match;

import java.util.List;
import online.hmb.match.MatchService.MatchDetail;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** 매치플로우 엔드포인트 (openapi §matches). 상태 검증·전이 = MatchService, 잡 = Orchestrator. */
@RestController
public class MatchController {

    private final MatchService matchService;
    private final MatchOrchestrator orchestrator;
    private final MatchClockService clockService;
    private final MatchLockService lockService;
    private final MatchSkipService skipService;
    private final MatchPromptsService promptsService;

    public MatchController(MatchService matchService, MatchOrchestrator orchestrator,
                           MatchClockService clockService, MatchLockService lockService,
                           MatchSkipService skipService, MatchPromptsService promptsService) {
        this.matchService = matchService;
        this.orchestrator = orchestrator;
        this.clockService = clockService;
        this.lockService = lockService;
        this.skipService = skipService;
        this.promptsService = promptsService;
    }

    /**
     * teamTactics(P2-D4): 브리핑 최종 수동 전술 {line,press,tempo,width}(0..1) — 매치 스냅샷
     * (user_deck_json)에 포함돼 AI 컨텍스트로 전달된다(LLD-p2-server §2·§4). 생략 시 미포함(additive).
     */
    public record CreateMatchRequest(String botId, com.fasterxml.jackson.databind.JsonNode teamTactics,
                                     /**
                                      * #493 W6-v3 — 튜토리얼 고정 매치로 만든다(미리 구운 로그 · AI 0 ·
                                      * 대기 0 · 전 유저 동일 결과 · 유저 승리). 생략·false = 기존 연습경기.
                                      * ⚠️ {@code botId} 는 무시된다(상대는 구운 자산이 정한다).
                                      */
                                     Boolean tutorial) {
    }

    @PostMapping("/api/matches")
    public ResponseEntity<MatchDetail> create(@RequestAttribute("userId") String userId,
                                              @RequestBody(required = false) CreateMatchRequest request) {
        // #217 AC2: 끝나지 않은 매치가 있으면 새로 만들지 않는다 — 409 MATCH_IN_PROGRESS(detail.matchId)
        // 로 그 매치를 알려주면 web 이 "이어하기"로 보낸다(빈 손 409 는 유저를 막다른 길에 세운다).
        lockService.assertCanCreateMatch(userId);
        MatchService.MatchRow row = matchService.createMatch(userId,
                request == null ? null : request.botId(),
                request == null ? null : request.teamTactics(),
                request != null && Boolean.TRUE.equals(request.tutorial()));
        // A 프리페치(#95): 유저팀 A + 봇 A(덱 베이스)를 브리핑 진입 즉시 크로스매치 캐시로 enqueue.
        // 유저가 프롬프트 쓰는 동안 A 생성 → 킥오프 때 프롬프트 없으면 콜0 재사용, 있으면 가벼운 B 패치.
        orchestrator.prefetchBaseInputs(row.id());
        return ResponseEntity.status(HttpStatus.CREATED).body(matchService.toDetail(row));
    }

    /**
     * 시계 지연 평가(P4-E2 #170): 조회 시점에 만료된 단계를 먼저 진행시킨다 — 스위퍼(1s)가 죽어 있어도
     * <b>보고 있는 화면은 정확</b>하고, 스위퍼는 아무도 안 보는 매치를 진행시킨다(서로의 백스톱).
     *
     * <p>단 <b>가벼운 전이만</b>이다({@link MatchClockService#advanceDueForRead}). 후반 시작은 엔진 RPC 를
     * 물고 있어 요청 스레드에서 하면 1초 폴링이 그만큼 붙잡힌다(독립검증 blocker) — 그건 스위퍼 몫이고
     * 유저 체감 지연은 최대 sweep-interval-ms 다.
     */
    @GetMapping("/api/matches/{id}")
    public MatchDetail get(@RequestAttribute("userId") String userId, @PathVariable("id") String id) {
        // 접근 판정 먼저(남의 매치 시계를 밀지 않게). #245: 소유자 + 원정 수비자(읽기 전용).
        // 수비자가 여는 매치는 언제나 FINISHED 라 시계 전진은 무의미하지만, 판정을 먼저 두는
        // 이유는 그대로다 — 볼 자격이 없는 요청이 상태를 건드리면 안 된다.
        matchService.getViewable(userId, id);
        clockService.advanceDueForRead(id);
        // toDetailFor: 관전자(원정 수비자)에게는 상대의 덱 스냅샷(=선수별 지시·팀 전술)을 떼고 준다.
        return matchService.toDetailFor(userId, matchService.getViewable(userId, id));
    }

    /**
     * <b>이 매치에 실제 반영된 지시</b>(#431) — 덱 ← pre ← halftime 병합 결과. <b>소유자 전용</b>이라
     * 비소유자는 404 다(관전 경로 {@code getViewable} 을 쓰지 않는다 — 지시문은 {@code toDetailFor}
     * 가 관전자에게서 명시적으로 떼는 정보다).
     *
     * <p>이게 없어서 후반에 선수 상세를 열면 방금 바꾼 지시가 아니라 덱의 옛 지시가 떴다.
     */
    @GetMapping("/api/matches/{id}/prompts")
    public MatchPromptsService.MatchPrompts getPrompts(@RequestAttribute("userId") String userId,
                                                       @PathVariable("id") String id) {
        return promptsService.of(userId, id);
    }

    @PostMapping("/api/matches/{id}/prompts")
    public MatchDetail prompts(@RequestAttribute("userId") String userId,
                               @PathVariable("id") String id,
                               @RequestBody MatchService.PromptRequest request) {
        matchService.submitPrompt(userId, id, request);
        // 제출한 그 순간 해당 하프의 잡을 (재)해소해 AI 생성을 유저가 지시를 쓰는 시간 뒤에 숨긴다.
        // pre = 킥오프 전(#193 라운드2, hero 원 스펙 "프롬프트 제출하면 취합"),
        // halftime = 전반 재생 중에도 낼 수 있다(#170) → 감독시간에 기다릴 게 남지 않는다(#193 W2b-B2).
        // 둘 다 supersede 가 재편집 안전(유효 잡 1개)을 보장하고, 상태가 안 맞으면 각 메서드가 no-op.
        if ("halftime".equals(request.phase())) {
            orchestrator.resolveSecondHalfInputs(id);
        } else if ("pre".equals(request.phase())) {
            orchestrator.resolveFirstHalfInputs(id);
        }
        return matchService.toDetail(matchService.getOwned(userId, id));
    }

    /**
     * kickoff 바디(선택): teamTactics — 브리핑 최종 수동 전술. W0 이월 a(AC-B2): 킥오프 시점에
     * 현재 활성 덱 + 이 teamTactics 로 매치 스냅샷을 <b>재캡처</b>해 브리핑 중 수정을 반영한다
     * (create 시점 캡처는 폴백; teamTactics 생략 시 기존 스냅샷 전술 유지).
     */
    public record KickoffRequest(com.fasterxml.jackson.databind.JsonNode teamTactics) {
    }

    @PostMapping("/api/matches/{id}/kickoff")
    public ResponseEntity<MatchDetail> kickoff(@RequestAttribute("userId") String userId,
                                               @PathVariable("id") String id,
                                               @RequestBody(required = false) KickoffRequest request) {
        // 재캡처는 CAS 전(BRIEFING 상태에서만) — 현재 덱 편집 상태를 매치 스냅샷에 반영(AC-B2).
        matchService.recaptureSnapshotAtKickoff(userId, id, request == null ? null : request.teamTactics());
        MatchService.MatchRow row = matchService.kickoffCas(userId, id);
        orchestrator.enqueueHalf(id, 1);
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(matchService.toDetail(matchService.getOwned(userId, id)));
    }

    /**
     * teamTactics(#254, 선택): 감독시간 팀 전술 {line,press,tempo,width}(0..1). hero 결정 = <b>허용</b>
     * — 후반에 전술을 바꿀 수 있다. 생략하면 손대지 않은 것이라 전반 전술이 그대로 이어진다(additive).
     *
     * <p>formation + starters(#276, 선택): 감독시간 <b>배치</b>. hero 결정 = "덱 구성과 같은 조작으로
     * 통일" → 포메이션 문자열만이 아니라 <b>슬롯 재배치까지</b>. <b>둘 다 있거나 둘 다 없어야</b> 하고
     * (반쪽 배치는 뜻이 없다) starters 는 <b>교체 반영 후의 실효 선발</b> 11명이다. 생략 = 손대지 않음.
     */
    public record HalftimeRequest(List<MatchService.Substitution> substitutions,
                                  com.fasterxml.jackson.databind.JsonNode teamTactics,
                                  String formation,
                                  List<MatchService.ShapeSlot> starters) {
    }

    @PostMapping("/api/matches/{id}/halftime")
    public MatchDetail halftime(@RequestAttribute("userId") String userId,
                                @PathVariable("id") String id,
                                @RequestBody HalftimeRequest request) {
        matchService.submitHalftime(userId, id,
                request == null ? null : request.substitutions(),
                request == null ? null : request.teamTactics(),
                request == null ? null : request.formation(),
                request == null ? null : request.starters());
        // 교체는 h2 해소 분기를 바꾼다(패치/재사용 → 풀 생성) — 선행 생성된 결과를 무효화하고 다시
        // 태우기 위해 여기서도 재해소한다(#193 W2b-B2). 교체 없음(빈 배열)이면 같은 잡 → no-op.
        // 전술 변경(#254)도 같은 이유로 여기를 지난다 — 선행 생성된 후반 인풋은 전반 전술로 만든 것이다.
        orchestrator.resolveSecondHalfInputs(id);
        return matchService.toDetail(matchService.getOwned(userId, id));
    }

    @PostMapping("/api/matches/{id}/resume")
    public ResponseEntity<MatchDetail> resume(@RequestAttribute("userId") String userId,
                                              @PathVariable("id") String id) {
        matchService.resumeCas(userId, id);
        orchestrator.enqueueHalf(id, 2);
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(matchService.toDetail(matchService.getOwned(userId, id)));
    }

    /** 스킵 바디(#421) — 필수. 유저가 지금 보고 있다고 주장하는 단계. */
    public record SkipRequest(String phase) {
    }

    /**
     * 경기 스킵 (#421) — 재생 중인 하프의 창을 <b>지금으로 당긴다</b>. 새 전이 엣지는 없다: 창을 닫고
     * 그 자리에서 기존 만료 전이를 밟아(감독시간 개시 / 종료·정산) <b>전이 후</b> 상태를 돌려준다.
     * "닫으면 바로 후반"이 성립하려면 스위퍼 주기(1s)를 기다려선 안 되기 때문에 무거운 전이도 여기서
     * 끝낸다({@link MatchClockService#advanceDue} — 조회 경로가 쓰는 가벼운 버전이 아니다).
     *
     * <p>바디 {@code phase} 는 <b>필수</b>고 CAS 키다 — 이유·계약은 {@link MatchSkipService} 참고.
     * 롤백 스위치 = {@code hmb.match.skip.enabled}(false 면 409).
     */
    @PostMapping("/api/matches/{id}/skip")
    public MatchDetail skip(@RequestAttribute("userId") String userId,
                            @PathVariable("id") String id,
                            @RequestBody(required = false) SkipRequest request) {
        skipService.skip(userId, id, request == null ? null : request.phase());
        return matchService.toDetail(matchService.getOwned(userId, id));
    }

    public record AutoRequest(Boolean auto) {
    }

    /**
     * 오토 모드 on/off (#249). 켜 두면 전반이 끝날 때 감독시간(3분) 없이 후반이 바로 시작된다.
     *
     * <p>후반 인풋은 <b>새 경로를 만들지 않는다</b> — 감독시간 만료와 같은 전이를 타서
     * #193 W2b-B2 프리페치({@link MatchOrchestrator#resolveSecondHalfInputs}, 전반 진입 직후 선행 생성)
     * 결과를 그대로 쓴다. 그래서 여기서 AI 를 부르는 코드가 없다.
     *
     * <p>감독시간이 이미 열린 뒤 ON 이면 그 자리에서 후반이 열린다(경합 창 무해화) — 그 경우에만
     * {@code enqueueHalf} 를 부른다. 부르는 자리·인자는 {@code POST /resume} 과 동일하다.
     */
    @PostMapping("/api/matches/{id}/auto")
    public MatchDetail auto(@RequestAttribute("userId") String userId,
                            @PathVariable("id") String id,
                            @RequestBody(required = false) AutoRequest request) {
        // openapi 가 `required: [auto]` 로 선언한 필드다 — 빠졌으면 400 이지 "조용히 OFF" 가 아니다
        // (독립검증 minor-2). 실패가 조용히 상태를 바꾸면, 클라 버그 하나가 유저의 감독시간을
        // 말없이 없애거나 되살린다.
        if (request == null || request.auto() == null) {
            throw new online.hmb.common.ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "auto 값이 필요합니다", java.util.Map.of("field", "auto"));
        }
        MatchService.AutoToggleResult result = matchService.setAutoCas(userId, id, request.auto());
        if (result.resumedNow()) {
            orchestrator.enqueueHalf(id, 2);
        }
        return matchService.toDetail(matchService.getOwned(userId, id));
    }

    @GetMapping(value = "/api/matches/{id}/halves/{half}/log", produces = MediaType.APPLICATION_JSON_VALUE)
    public String halfLog(@RequestAttribute("userId") String userId,
                          @PathVariable("id") String id,
                          @PathVariable("half") int half) {
        matchService.getViewable(userId, id);   // #245 수비자 관전(읽기 전용)
        clockService.advanceDueForRead(id); // 재생 요청 시점 기준으로 단계를 맞춘 뒤 허용 여부를 판정
        return matchService.halfLogJson(userId, id, half); // match_log_json 그대로 (AC-M3)
    }

    @GetMapping("/api/matches/{id}/result")
    public MatchService.MatchResult result(@RequestAttribute("userId") String userId,
                                           @PathVariable("id") String id) {
        matchService.getViewable(userId, id);   // #245 수비자 관전(읽기 전용)
        clockService.advanceDueForRead(id); // 후반 창이 방금 끝났으면 여기서 정산하고 결과를 준다
        return matchService.result(userId, id);
    }

    /**
     * 포기 — ACTIVE → ABANDONED (#217 AC3). 잠금의 탈출구다: 이게 없으면 고아 매치 하나가 계정을
     * 영구히 잠근다. 정상 재생 중에는 409(리롤 방지) — 허용 조건은 {@link MatchLockService#abandonable}.
     */
    @PostMapping("/api/matches/{id}/abandon")
    public MatchDetail abandon(@RequestAttribute("userId") String userId, @PathVariable("id") String id) {
        matchService.getOwned(userId, id); // 소유권 먼저(남의 매치 시계를 밀지 않게)
        clockService.advanceDueForRead(id); // 방금 끝난 매치를 "포기"로 닫지 않게 현재 단계부터 판정
        return matchService.toDetail(lockService.abandon(userId, id));
    }

    @PostMapping("/api/matches/{id}/retry")
    public ResponseEntity<MatchDetail> retry(@RequestAttribute("userId") String userId,
                                             @PathVariable("id") String id) {
        int half = matchService.retryCas(userId, id);
        orchestrator.enqueueHalf(id, half);
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(matchService.toDetail(matchService.getOwned(userId, id)));
    }
}

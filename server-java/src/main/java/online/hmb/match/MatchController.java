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

    public MatchController(MatchService matchService, MatchOrchestrator orchestrator) {
        this.matchService = matchService;
        this.orchestrator = orchestrator;
    }

    public record CreateMatchRequest(String botId) {
    }

    @PostMapping("/api/matches")
    public ResponseEntity<MatchDetail> create(@RequestAttribute("userId") String userId,
                                              @RequestBody(required = false) CreateMatchRequest request) {
        MatchService.MatchRow row = matchService.createMatch(userId,
                request == null ? null : request.botId());
        // #1 프리페치: 봇(away) h1 잡을 브리핑 진입 즉시 enqueue — 유저가 프롬프트 쓰는 동안 백그라운드 생성.
        // 봇은 유저 입력 무관이라 킥오프 때 enqueueHalf 와 동일 promptHash(멱등). 크리티컬 패스에서 봇 제거.
        orchestrator.prefetchBotHalf(row.id(), 1);
        return ResponseEntity.status(HttpStatus.CREATED).body(matchService.toDetail(row));
    }

    @GetMapping("/api/matches/{id}")
    public MatchDetail get(@RequestAttribute("userId") String userId, @PathVariable("id") String id) {
        return matchService.toDetail(matchService.getOwned(userId, id));
    }

    @PostMapping("/api/matches/{id}/prompts")
    public MatchDetail prompts(@RequestAttribute("userId") String userId,
                               @PathVariable("id") String id,
                               @RequestBody MatchService.PromptRequest request) {
        matchService.submitPrompt(userId, id, request);
        return matchService.toDetail(matchService.getOwned(userId, id));
    }

    @PostMapping("/api/matches/{id}/kickoff")
    public ResponseEntity<MatchDetail> kickoff(@RequestAttribute("userId") String userId,
                                               @PathVariable("id") String id) {
        MatchService.MatchRow row = matchService.kickoffCas(userId, id);
        orchestrator.enqueueHalf(id, 1);
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(matchService.toDetail(matchService.getOwned(userId, id)));
    }

    public record HalftimeRequest(List<MatchService.Substitution> substitutions) {
    }

    @PostMapping("/api/matches/{id}/halftime")
    public MatchDetail halftime(@RequestAttribute("userId") String userId,
                                @PathVariable("id") String id,
                                @RequestBody HalftimeRequest request) {
        MatchService.MatchRow row = matchService.submitHalftime(userId, id,
                request == null ? null : request.substitutions());
        return matchService.toDetail(row);
    }

    @PostMapping("/api/matches/{id}/resume")
    public ResponseEntity<MatchDetail> resume(@RequestAttribute("userId") String userId,
                                              @PathVariable("id") String id) {
        matchService.resumeCas(userId, id);
        orchestrator.enqueueHalf(id, 2);
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(matchService.toDetail(matchService.getOwned(userId, id)));
    }

    @GetMapping(value = "/api/matches/{id}/halves/{half}/log", produces = MediaType.APPLICATION_JSON_VALUE)
    public String halfLog(@RequestAttribute("userId") String userId,
                          @PathVariable("id") String id,
                          @PathVariable("half") int half) {
        return matchService.halfLogJson(userId, id, half); // match_log_json 그대로 (AC-M3)
    }

    @GetMapping("/api/matches/{id}/result")
    public MatchService.MatchResult result(@RequestAttribute("userId") String userId,
                                           @PathVariable("id") String id) {
        return matchService.result(userId, id);
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

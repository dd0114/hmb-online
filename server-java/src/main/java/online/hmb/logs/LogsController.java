package online.hmb.logs;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 로그 탭 API (AC-E1/E3, openapi-v2 logs 2종). 컨트롤러는 얇게 — 조회 로직은 {@link LogsService}.
 */
@RestController
public class LogsController {

    private final LogsService logsService;

    public LogsController(LogsService logsService) {
        this.logsService = logsService;
    }

    @GetMapping("/api/logs/matches")
    public List<LogsService.MatchLogItem> matches(@RequestAttribute("userId") String userId,
                                                  @RequestParam(name = "mode", required = false) String mode,
                                                  @RequestParam(name = "season", required = false) Integer season,
                                                  @RequestParam(name = "limit", defaultValue = "30") int limit) {
        return logsService.listMatches(userId, mode, season, limit);
    }

    @GetMapping("/api/logs/trades")
    public List<LogsService.TradeLogItem> trades(@RequestAttribute("userId") String userId,
                                                 @RequestParam(name = "limit", defaultValue = "30") int limit) {
        return logsService.listTrades(userId, limit);
    }
}

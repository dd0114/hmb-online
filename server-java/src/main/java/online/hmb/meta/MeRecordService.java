package online.hmb.meta;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 모드별 전적 (#286 W4 · #319) — {@code GET /api/me/record}.
 *
 * <p><b>출처는 {@code matches} 한 곳</b>이다. 새 표를 만들지 않는 이유는 ERD 설계 노트와 같다 —
 * 전적은 파생값이고, 별도 집계 테이블을 두면 정산 경로가 하나 늘 때마다 조용히 어긋난다.
 *
 * <p>⚠️ <b>{@code byMode.away} 는 "내가 친 원정"만이다.</b> 피침공(방어)은 여기 없다 —
 * {@code matches} 는 내가 만든 경기의 표이기 때문이다. 섞으면 {@code overall ≠ Σ byMode} 가 되어
 * 같은 화면이 두 말을 한다. 방어 전적은 이미 {@code GET /api/me/away-reports.summary} 가 소유하고
 * 있고, 한 사실의 주인은 하나여야 한다.
 *
 * <p>⚠️ <b>승률은 서버가 계산해서 준다</b>(클라 복제 금지 — #262 규율). 규칙 = {@code wins / played}
 * (무승부는 승이 아니다). {@code RankingService} 의 {@code winRate} 와 <b>같은 규칙</b>이라 두 화면이
 * 다른 승률을 말하지 않는다. 규칙을 바꾸려면 두 곳을 같이 봐라.
 */
@Service
public class MeRecordService {

    /** 최근 폼 길이 — 화면이 한 줄에 그리는 칸 수(설계 §5 의 10). */
    private static final int RECENT_FORM = 10;

    private static final List<String> MODES = List.of("practice", "league", "away");

    private final JdbcClient jdbcClient;

    public MeRecordService(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /** winRate 는 0~1. played=0 이면 0.0(나눗셈을 클라로 미루지 않는다). */
    public record RecordBlock(int played, int wins, int draws, int losses, double winRate) {
    }

    /**
     * @param current 지금 이어지는 연승(전 모드) · @param best 통산 최고 연승 ·
     *     @param awayBest 원정 시즌 최고 연승({@code away_streaks.best_streak}) — 축이 달라 같이 싣는다.
     */
    public record Streak(int current, int best, int awayBest) {
    }

    public record MyRecord(RecordBlock overall, Map<String, RecordBlock> byMode,
                           List<String> recentForm, Streak streak) {
    }

    public MyRecord recordOf(String userId) {
        // 시간순 결과열 하나로 overall·byMode·연승·최근폼을 전부 만든다 — 같은 사실을 네 번 세면
        // 어긋날 자리가 네 개 생긴다.
        record Played(String mode, String result) {
        }
        List<Played> chronological = jdbcClient.sql("""
                        SELECT mode, result FROM matches
                         WHERE user_id = ? AND result IS NOT NULL
                         ORDER BY created_at ASC, id ASC
                        """)
                .param(userId)
                .query((rs, n) -> new Played(rs.getString("mode"), rs.getString("result")))
                .list();

        Acc overall = new Acc();
        Map<String, Acc> byMode = new LinkedHashMap<>();
        for (String mode : MODES) {
            byMode.put(mode, new Acc());
        }
        int best = 0;
        int current = 0;
        for (Played p : chronological) {
            overall.add(p.result());
            byMode.computeIfAbsent(p.mode(), k -> new Acc()).add(p.result());
            if ("WIN".equals(p.result())) {
                current++;
                best = Math.max(best, current);
            } else {
                current = 0;
            }
        }

        Map<String, RecordBlock> modes = new LinkedHashMap<>();
        byMode.forEach((mode, acc) -> modes.put(mode, acc.toBlock()));

        // 최근 폼은 **최신이 앞**(설계 §5). 시간순 열의 꼬리를 뒤집는다.
        List<String> form = new ArrayList<>();
        for (int i = chronological.size() - 1; i >= 0 && form.size() < RECENT_FORM; i--) {
            form.add(chronological.get(i).result());
        }

        int awayBest = jdbcClient.sql("SELECT best_streak FROM away_streaks WHERE user_id = ?")
                .param(userId)
                .query(Integer.class)
                .optional()
                .orElse(0);

        return new MyRecord(overall.toBlock(), modes, form, new Streak(current, best, awayBest));
    }

    private static final class Acc {
        int wins;
        int draws;
        int losses;

        void add(String result) {
            switch (result) {
                case "WIN" -> wins++;
                case "LOSS" -> losses++;
                default -> draws++;
            }
        }

        RecordBlock toBlock() {
            int played = wins + draws + losses;
            double winRate = played == 0 ? 0.0 : (double) wins / played;
            return new RecordBlock(played, wins, draws, losses, winRate);
        }
    }
}

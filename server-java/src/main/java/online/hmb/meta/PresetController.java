package online.hmb.meta;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import online.hmb.common.ApiException;
import online.hmb.common.Ulid;
import org.springframework.beans.factory.annotation.Value;
import online.hmb.common.SqliteErrors;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 프리셋 CRUD (LLD §4 — 수정=삭제+생성으로 단순화). 덱 적용은 웹이 prompt_text를 복사해
 * PUT /api/deck으로 저장한다 — 그래서 프리셋 삭제가 이미 덱에 들어간 본문에 영향 없음(AC-S4).
 */
@RestController
public class PresetController {

    private final JdbcClient jdbcClient;
    private final int promptMaxChars;

    public PresetController(JdbcClient jdbcClient,
                             @Value("${hmb.deck.player-prompt-max-chars}") int promptMaxChars) {
        this.jdbcClient = jdbcClient;
        this.promptMaxChars = promptMaxChars;
    }

    @GetMapping("/api/presets")
    public List<PromptPreset> list(@RequestAttribute("userId") String userId) {
        return jdbcClient.sql("""
                        SELECT id, name, prompt_text, created_at FROM prompt_presets
                        WHERE user_id = ? ORDER BY created_at, id
                        """)
                .param(userId)
                .query((rs, rowNum) -> new PromptPreset(
                        rs.getString("id"), rs.getString("name"),
                        rs.getString("prompt_text"), rs.getString("created_at")))
                .list();
    }

    @PostMapping("/api/presets")
    public ResponseEntity<PromptPreset> create(@RequestAttribute("userId") String userId,
                                                @RequestBody PresetCreateRequest request) {
        if (request == null || request.name() == null || request.name().isBlank()) {
            throw ApiException.validation("프리셋 이름이 비어 있습니다");
        }
        if (request.promptText() == null || request.promptText().isBlank()) {
            throw ApiException.validation("프리셋 본문이 비어 있습니다");
        }
        if (request.promptText().length() > promptMaxChars) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR",
                    "프리셋 본문이 최대 길이(" + promptMaxChars + "자)를 초과했습니다",
                    Map.of("length", request.promptText().length(), "max", promptMaxChars));
        }

        String id = Ulid.next();
        String now = Instant.now().toString();
        try {
            jdbcClient.sql("""
                            INSERT INTO prompt_presets(id, user_id, name, prompt_text, created_at)
                            VALUES (?, ?, ?, ?, ?)
                            """)
                    .params(id, userId, request.name(), request.promptText(), now)
                    .update();
        } catch (DataAccessException e) {
            if (!SqliteErrors.isUniqueViolation(e)) {
                throw e;
            }
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR",
                    "이미 같은 이름의 프리셋이 있습니다", Map.of("name", request.name()));
        }

        return ResponseEntity.status(HttpStatus.CREATED)
                .body(new PromptPreset(id, request.name(), request.promptText(), now));
    }

    @DeleteMapping("/api/presets/{id}")
    public ResponseEntity<Void> delete(@RequestAttribute("userId") String userId,
                                        @PathVariable("id") String id) {
        int deleted = jdbcClient.sql("DELETE FROM prompt_presets WHERE id = ? AND user_id = ?")
                .params(id, userId)
                .update();
        if (deleted == 0) {
            throw ApiException.notFound("프리셋을 찾을 수 없습니다");
        }
        return ResponseEntity.noContent().build();
    }

    public record PromptPreset(String id, String name, String promptText, String createdAt) {
    }

    public record PresetCreateRequest(String name, String promptText) {
    }
}

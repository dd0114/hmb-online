package online.hmb.meta;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** GET /api/modes — LLD §4. 싱글은 available, 멀티는 "준비중"(D10). */
@RestController
public class ModesController {

    @GetMapping("/api/modes")
    public List<ModeInfo> modes() {
        return List.of(
                new ModeInfo("single", true, null),
                new ModeInfo("multi", false, "준비중")
        );
    }

    public record ModeInfo(String id, boolean available, String label) {
    }
}

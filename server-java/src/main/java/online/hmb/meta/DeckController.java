package online.hmb.meta;

import online.hmb.match.MatchLockService;
import online.hmb.meta.DeckService.DeckResponse;
import online.hmb.meta.DeckService.DeckUpdateRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** GET/PUT /api/deck — LLD §4, AC-S2. */
@RestController
public class DeckController {

    private final DeckService deckService;
    private final MatchLockService lockService;
    private final online.hmb.match.DeckPrewarmService prewarmService;
    private final online.hmb.events.BusinessEventRecorder events;

    public DeckController(DeckService deckService,
                          MatchLockService lockService,
                          online.hmb.match.DeckPrewarmService prewarmService,
                          online.hmb.events.BusinessEventRecorder events) {
        this.deckService = deckService;
        this.lockService = lockService;
        this.prewarmService = prewarmService;
        this.events = events;
    }

    /**
     * 조회이면서 <b>보증</b>이다: "활성 덱이 있으면 그 덱의 AI 인풋(A)도 있다" (#402 AC2).
     *
     * <p>왜 읽기 경로에 다나: A 재생성 트리거가 {@code PUT /api/deck} 뿐이라 <b>덱을 안 건드리는
     * 유저는 영영 복구되지 않았다</b> — 라이브 활성덱 유저 61명 중 36명(59%)이 현재 덱의 A 가 없었고
     * (전원 A 키 규약 범프 #324 이전 저장), 그 사람들은 경기마다 20~180초를 새로 만들어 기다렸다.
     * 앱을 켜서 덱을 한 번 보기만 하면 채워지는 자리가 여기다.
     *
     * <p>순서가 계약이다: <b>먼저 응답 데이터를 확보하고</b> 보증을 건다. 보증은 최적화라 실패해도
     * 조회는 성공해야 한다({@code ensureWarm} 이 안에서 전부 삼키고, 이미 준비된 흔한 경우엔 쓰기 0).
     */
    @GetMapping("/api/deck")
    public DeckResponse getDeck(@RequestAttribute("userId") String userId) {
        DeckResponse deck = deckService.getActiveDeck(userId);
        prewarmService.ensureWarm(userId);
        return deck;
    }

    /**
     * 순서가 계약이다: <b>잠금 검사 → 저장 → 선실행</b>.
     * 잠긴 매치(#217)면 저장 자체가 409 라 선실행도 일어나지 않아야 하고(안 그러면 거부된 덱으로 AI 를
     * 태운다), 선실행은 저장이 커밋된 뒤여야 그 덱의 A 를 만든다(#215).
     */
    @PutMapping("/api/deck")
    public DeckResponse putDeck(@RequestAttribute("userId") String userId,
                                 @RequestBody DeckUpdateRequest request) {
        // #217 AC2: 이미 킥오프한 매치가 있으면 덱은 읽기 전용이다. 덱은 하프타임 교체 벤치의
        // 원장이라, 진행 중에 바꾸면 화면(현재 덱)과 매치 스냅샷이 소리 없이 어긋난다.
        // BRIEFING 은 잠그지 않는다 — 킥오프 재캡처(AC-B2)가 명시적으로 지원하는 창이다.
        lockService.assertNotLocked(userId, "deck.replace");
        // #492: "이번에 새로 만든 덱인가"는 저장 **전**에만 알 수 있다. 맨몸으로 조회하면 계측이
        // 본 저장을 실패시킬 수 있으므로 recorder.probe 로 감싼다(실패·계측 off 면 기본값).
        boolean existedBefore = events.probe(() -> deckService.hasActiveDeck(userId), true);
        DeckResponse saved = deckService.replaceDeck(userId, request);
        // 훅이 **컨트롤러**인 이유 = DeckService.replaceDeck 은 OnboardingService.complete 의
        // 트랜잭션 안에서도 불린다(튜토리얼 덱 지급). 서비스 안에 훅을 두면 그 경로에서 기록이
        // tx 안으로 들어가 실패 시 덱 지급이 롤백된다. 여기라면 어느 경로에서도 tx 밖이다.
        events.record(online.hmb.events.BusinessEvent.DECK_SAVE, userId, () -> java.util.Map.of(
                "source", "deck",
                "formation", saved.formation(),
                "slotCount", saved.slots() == null ? 0 : saved.slots().size(),
                "created", !existedBefore));
        // 저장이 커밋된 뒤 AI 인풋을 미리 돌린다(#215 W2) — 응답을 막지 않도록 큐잉만 하고 끝낸다.
        // 컨트롤러에서 부르는 건 MatchController 의 prefetchBaseInputs 와 같은 자리·같은 이유다.
        prewarmService.onDeckSaved(userId);
        return saved;
    }
}

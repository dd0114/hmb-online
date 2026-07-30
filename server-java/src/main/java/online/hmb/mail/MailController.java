package online.hmb.mail;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RestController;

/**
 * 우편함 — 유저 엔드포인트 3개(#323).
 *
 * <p><b>공지와 달리 인증이 필요하다</b>. 공지는 유저별 데이터가 0인 브로드캐스트라 공개지만
 * (점검 공지는 로그인이 안 될 때 가장 필요하다), 우편함은 정의상 <b>내 것</b>이다 —
 * {@code /api/mails/**} 를 인증 제외 목록에 넣지 마라.
 *
 * <p>수령이 별도 엔드포인트인 이유: 열람({@code read})과 수령({@code claim})은 서로 다른 사건이다.
 * 여는 순간 자동 지급하면 "읽었는데 뭘 받았는지 못 봤다"가 되고, 무엇보다 <b>첨부를 확인하고
 * 받는다</b>는 유저의 동의 절차(hero 발제의 "수락")가 사라진다.
 */
@RestController
public class MailController {

    private final MailService mails;

    public MailController(MailService mails) {
        this.mails = mails;
    }

    /** 내 우편함 + 뱃지 수. 만료·수령 완료도 목록에 남는다(hero 확정 ④) — 뱃지에만 안 센다. */
    @GetMapping("/api/mails")
    public MailService.MailListResponse list(@RequestAttribute("userId") String userId) {
        return mails.list(userId);
    }

    /** 열람 기록(멱등). web 이 상세를 펼칠 때 부른다. */
    @PostMapping("/api/mails/{id}/read")
    public MailService.MailView read(@RequestAttribute("userId") String userId,
                                     @PathVariable("id") String id) {
        return mails.read(userId, id);
    }

    /**
     * 수령. 더블탭은 <b>실패가 아니다</b> — 200 {@code applied:false} + 현재 잔액.
     * 만료·회수는 410, 남의 우편물은 404(존재를 숨긴다).
     */
    @PostMapping("/api/mails/{id}/claim")
    public MailService.ClaimResult claim(@RequestAttribute("userId") String userId,
                                         @PathVariable("id") String id) {
        return mails.claim(userId, id);
    }
}

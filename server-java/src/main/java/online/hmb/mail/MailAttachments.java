package online.hmb.mail;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.util.List;

/**
 * 우편물 첨부(#323) — 지급될 것들의 <b>선언</b>이다. 실제 지급은 {@link MailService} 가 기존 경로
 * (지갑·원장·보유풀)로 수행한다.
 *
 * <p><b>첨부 0 도 유효하다</b>(텍스트 전용 안내 메일). 그래서 이 타입은 "없음"을 예외가 아니라
 * 정상값(0/빈 리스트)으로 표현한다 — null 을 흘려 보내면 소비자마다 다르게 방어한다.
 *
 * <p>DB 에는 이 레코드를 그대로 직렬화한 JSON 이 {@code mail_campaigns.payload_json} 에 들어간다.
 * 컬럼으로 펴지 않는 이유: 첨부 종류는 늘어난다(장비·티켓…). 종류마다 마이그레이션을 만들면
 * 운영이 배포에 묶인다 — 이 에픽이 없애려던 바로 그 의존이다.
 */
public record MailAttachments(long points, long gems, List<PlayerGrant> players) {

    /** 카드(유닛) 지급 — {@code user_players} 의 (playerId, count) 그대로다. */
    public record PlayerGrant(String playerId, int count) {
    }

    public static final MailAttachments EMPTY = new MailAttachments(0, 0, List.of());

    /** null 을 정상값으로 접는다 — 역직렬화(구 행)·부분 바디 양쪽에서 같은 모양이 나오게. */
    public static MailAttachments normalize(MailAttachments raw) {
        if (raw == null) {
            return EMPTY;
        }
        return new MailAttachments(raw.points, raw.gems, raw.players == null ? List.of() : raw.players);
    }

    public MailAttachments {
        players = players == null ? List.of() : List.copyOf(players);
    }

    /**
     * 받을 게 있는가. {@code mail_campaigns.has_attachments} 의 정의이자, 뱃지가 "읽었어도 아직
     * 안 받았다"를 계속 세는 근거다.
     */
    @JsonIgnore
    public boolean isEmpty() {
        return points == 0 && gems == 0 && players.isEmpty();
    }
}

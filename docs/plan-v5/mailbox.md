# 우편함 — 설계 SoT (에픽 #323, W1)

> hero 발제: **메시지로 보상(카드·G·Z)+텍스트를 보내고, 유저가 수락하면 수령**한다.
> 주 용도 = **패치 보상·이벤트 지급**, **별도 배포 없이 admin API 로 발송**(#309 무배포화 계보).
>
> 이 문서 = W1 설계의 정본. W2(서버)·W3(웹)은 여기 적힌 계약을 구현하기만 한다.
> **hero 확정 결정은 §6** — 위치 A(홈 헤더 ✉️) · 이름 **우편함** · 만료 기본 무기한 ·
> 만료 미수령은 회색 "만료됨"으로 목록에 남긴다.

---

## 0. 한 장 요약

```
admin ──POST /api/admin/mails──► mail_campaigns (발송 1건 = 캠페인 1행, 첨부 payload 여기 하나)
             (Idempotency-Key)        │ 팬아웃(같은 트랜잭션)
                                      ▼
                                 user_mails (유저×캠페인 1행 — read_at / claimed_at 상태만)
유저 ──GET /api/mails──────────► 목록 + 안읽음 수
     ──POST /api/mails/{id}/claim──► CAS(claimed_at IS NULL) + 기존 지급 경로 재사용
                                      · G  = WalletService.apply     (point_ledger, ref=user_mail id)
                                      · Z  = WalletService.applyGems (gem_ledger,   ref=user_mail id)
                                      · 카드 = user_players upsert    (GachaService 와 동일 upsert)
```

**재발명하지 않는 것**: 지갑·원장(`WalletService`) · 멱등 유니크 인덱스(`uq_ledger_reason_ref`) ·
감사 원장(`admin_ops_audit`, #209) · admin 게이트(`AdminInterceptor`) · 유닛 보유 upsert(`user_players`).
우편함이 새로 만드는 것은 **"보낼 것과 받을 것"의 상태 2개(테이블)와 그 전이**뿐이다.

---

## 1. 공지(#248)와의 관계 — 헷갈리면 안 되는 두 축

|  | 공지 (notice) | 메시지 (mail) |
|---|---|---|
| 성격 | **방송** — 전원이 같은 것을 본다 | **개인 수신함** — 내 것만 본다 |
| 상태 | 서버에 유저별 상태 **없음**(억제는 브라우저 저장소) | 서버에 유저별 상태 **있음**(읽음·수령) |
| 지급 | 없음 | **있다**(G·Z·카드) — 그래서 서버 상태가 필수 |
| 진입점 | 홈 헤더 **📢 스피커** 글리프(`NoticeCenter`) | 홈 헤더 **✉️ 봉투**(안읽음 뱃지) — §5 |
| 소실 | 기간이 끝나면 사라져도 손해 없음 | **사라지면 보상을 잃는다** → 만료 정책이 계약(§3.4) |

⚠️ **글리프를 같게 두지 마라.** 공지는 확성기(`NoticeGlyph`), 메시지는 봉투다. 둘 다 헤더에 서므로
모양이 겹치면 "보상 왔다"와 "점검 공지"가 구별되지 않는다. 뱃지도 다르다 — 공지는 **점**(개수 무의미),
메시지는 **숫자**(몇 통인지가 곧 할 일 개수).

---

## 2. 스키마 (Flyway, 번호는 merge-ready 시 main 배정 — 현재 V32 까지 사용)

```sql
-- 발송 1건 = 캠페인 1행. 본문·첨부·대상·만료가 여기 하나에만 있다.
CREATE TABLE mail_campaigns (
  id             TEXT PRIMARY KEY,                    -- ULID
  audience       TEXT NOT NULL,                       -- 'ALL' | 'USERS'
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,                       -- 공지와 같은 마크다운 부분집합(렌더 살균 = web, NoticeBody 재사용)
  payload_json   TEXT NOT NULL,                       -- {"points":0,"gems":0,"players":[{"playerId":"P001","count":1}]}
  expires_at     TEXT,                                -- NULL = 무기한. 수령 마감(초 절삭 ISO-8601 UTC)
  revoked_at     TEXT,                                -- 회수(오발송 수습) — 미수령분만 막는다
  target_count   INTEGER NOT NULL,                    -- 팬아웃한 행 수(발송 시점 스냅샷)
  reason         TEXT NOT NULL,                       -- 운영 사유(필수 — admin_ops_audit 와 같은 값)
  idem_key       TEXT NOT NULL,                       -- Idempotency-Key(없으면 서버 채번)
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_mail_campaigns_idem ON mail_campaigns(idem_key);

-- 유저 × 캠페인 = 수신함 1행. **상태만** 산다(내용은 캠페인이 SoT).
CREATE TABLE user_mails (
  id            TEXT PRIMARY KEY,                     -- ULID — 원장 ref_id 로 그대로 쓴다
  user_id       TEXT NOT NULL REFERENCES users(id),
  campaign_id   TEXT NOT NULL REFERENCES mail_campaigns(id),
  expires_at    TEXT,                                 -- 발송 시점 캠페인 값의 **스냅샷**(§3.4)
  read_at       TEXT,
  claimed_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_user_mails_user_campaign ON user_mails(user_id, campaign_id);
CREATE INDEX idx_user_mails_inbox ON user_mails(user_id, created_at DESC);
```

### 왜 이 모양인가 (되돌리려는 사람을 위해)

1. **내용을 유저 행에 복사하지 않는다.** 1000명에게 보낸 이벤트 메일의 본문·첨부를 1000번 적으면
   오탈자 수정이 1000행 UPDATE 가 되고, 무엇보다 **행마다 다른 내용이 될 수 있는 구조**가 된다
   (= 원장이 거짓말할 자리). 캠페인이 내용의 SoT, 유저 행은 상태의 SoT.
2. **`user_mails.id` 가 곧 멱등키다.** G/Z 지급은 기존 `uq_ledger_reason_ref(user_id, reason, ref_id)`
   에 `reason='mail_claim'`, `ref_id=user_mails.id` 로 들어간다 — 새 멱등 메커니즘을 만들지 않는다.
   같은 유저가 같은 캠페인 행을 두 번 수령할 길이 **상태(CAS)와 원장(유니크) 두 겹**으로 막힌다.
3. **`expires_at` 을 유저 행에 복사한다**(내용과 반대). 만료는 "이 사람의 수령 창"이고, 캠페인
   만료를 나중에 당기면 **이미 받아 든 사람의 마감이 소급으로 짧아진다**. 스냅샷이 정직하다.
4. **`revoked_at` 은 캠페인에 둔다.** 오발송 회수는 캠페인 단위 사건이고, 이미 수령한 건은
   손대지 않는다(§3.5) — 유저 행을 지우면 "왜 사라졌나"가 복원 불가능해진다.
5. **`payload_json` 은 문자열 JSON.** SQLite 에 타입이 없고, 첨부 종류는 늘어난다(장비·티켓…).
   컬럼으로 펴면 종류마다 마이그레이션이다. 검증은 서버 DTO 가 한다.

### 확장점 (지금 만들지 않는다)

- **유저별 다른 첨부**(보상 정산 케이스): `user_mails.payload_json` nullable 을 추가하고
  수령 시 `COALESCE(user_mails.payload_json, campaigns.payload_json)`. 지금은 요구가 없어
  **쓰지 않는 컬럼을 만들지 않는다**(쓰이지 않는 경로는 반드시 썩는다).
- **지연 구체화**(§3.2 대안): 유저 API 응답 형태가 그대로라 나중에 갈아끼울 수 있다.

---

## 3. 동작 계약

### 3.1 발송 (admin)

```
POST /api/admin/mails
Headers: Idempotency-Key: <ULID 권장>          # 없으면 서버 채번(그 요청은 재전송 보호 없음)
{
  "audience": "ALL" | "USERS",
  "userIds": ["u_…", …],                      # audience=USERS 일 때 필수(1~500명)
  "title": "패치 보상",
  "body": "…마크다운 부분집합…",
  "attachments": { "points": 5000, "gems": 10, "players": [{"playerId":"P001","count":1}] },
  "expiresInDays": 14,                         # 또는 expiresAt(둘 중 하나, 없으면 무기한)
  "reason": "v3.02 패치 보상 (#323)"           # 필수
}
→ 201 { campaignId, audience, targetCount, expiresAt, applied: true }
```

- **첨부 상한**(config, `hmb.mail.*`): points ≤ 1,000,000 · gems ≤ 100,000 · players 종류 ≤ 10 ·
  종류당 count ≤ 99. 근거: 전체 발송은 되돌릴 수 없는 인플레이션이라 오타 한 번의 폭을 코드가 막는다.
  넘으면 400(`VALIDATION`). 상한을 넘겨야 하는 이벤트는 **여러 번 나눠 보낸다**(각 건이 감사에 남는다).
- **playerId 는 발송 시점에 검증**한다(카탈로그에 없으면 400). 수령 시점에도 다시 보되 그땐
  **없는 id 를 건너뛴다** — 그 사이 유닛이 회수됐다고 유저의 G·Z 수령까지 막을 이유가 없다
  (economy 지급 경로가 같은 규율: 최상위 누락 ≪ 서비스 중단).
- **첨부가 0**이어도 유효하다(텍스트 전용 공지성 메시지).
- **멱등**: 같은 `Idempotency-Key` 재전송 → **200** `{applied:false, campaignId, targetCount}`(아무것도
  더 보내지 않는다). **단, 내용이 다르면 409** — `AdminPointsService` 가 겪은 함정 그대로다
  (같은 키에 다른 금액을 조용히 삼키면 admin 은 정정에 성공했다고 믿는데 아무 일도 안 일어난다).
- **"같은 내용"의 판정 = 요청 원문의 해시 하나**(`mail_campaigns.request_hash`). 필드를 하나씩
  비교하면 **빠뜨린 필드가 곧 구멍**이다 — 독립검증이 실제로 두 개를 뚫었다:
  - ⚠️ **대상은 목록으로 비교한다**(인원 "수"가 아니라). 수만 보면 같은 키로 **수신자만 바꾼**
    요청이 200 으로 삼켜져, 운영자는 보냈다고 믿는데 그 사람은 아무것도 못 받는다(BLOCKER-1).
  - ⚠️ **만료는 요청에 적힌 방식 그대로 비교한다**(파생 절대 시각이 아니라). `expiresInDays: 14`
    를 절대 시각으로 바꿔 비교하면 **초가 하나 지나는 것만으로** 같은 바디가 409 가 되고 —
    그것도 멱등키가 존재하는 정확히 그 상황(타임아웃 후 재전송)에서 — 안내대로 새 키를 쓰면
    **전 수신자에게 이중 지급**된다(BLOCKER-2).
  - `audience=ALL` 은 **해소된 명단을 넣지 않는다**('ALL' 문자열). 대상의 정의가 "발송 시점 전원"
    이므로 그 사이 한 명이 가입했다고 재전송이 거부되면 같은 함정이다.
  - `title`/`body`/`reason` 은 비교하지 않는다(오타 수정 재전송을 막게 된다 — 돈을 움직이는 필드가
    아니다). 계약 = `sameKeyWithDifferentRecipientsIsRejected` · `relativeExpiryResendIsStillTheSameRequest`.
- **감사**: `admin_ops_audit`(V18) 에 `action='mail_send'`, `result='ok'|'failed'`,
  `detail_json={campaignId, audience, targetCount, payload, expiresAt}`. **실패도 남긴다.**
  admin_audit(V5)이 아닌 이유 = 그 테이블은 `target_user_id NOT NULL` 이라 전체 발송이 표현 불가
  (공지 #248 이 같은 이유로 ops 원장을 쓴다).
- **트랜잭션**: 캠페인 INSERT + 팬아웃 INSERT + 감사가 **한 트랜잭션**. 셋 중 하나만 남는 상태가
  존재할 수 없다(포인트 지급 3중 기록과 같은 규율).

### 3.2 브로드캐스트 — 팬아웃 vs 지연 구체화 (**결정: 발송 시 팬아웃, 상한 가드**)

| | A. 발송 시 팬아웃 (**채택**) | B. 수신 시 구체화(lazy) |
|---|---|---|
| 읽기 경로 | `user_mails` **한 곳** | 실행 + 가상(ALL 캠페인) **UNION** — 목록·뱃지·수령 셋 다 두 소스 |
| 행 수 | 유저수 × 캠페인 (1000명·100건 = 10만 행) | 수령한 만큼만 |
| 신규 가입자 | 못 받는다(= 패치 보상의 올바른 의미) | 규칙을 따로 정해야 한다 |
| 실패 모드 | 발송이 느려진다(가드로 상한) | 목록·뱃지·수령이 **서로 다른 답**을 낼 수 있다 |

- **채택 이유**: 지금 규모(오픈베타, SQLite 단일 라이터)에서 1000행 INSERT 는 한 트랜잭션 수 ms 다.
  "행 폭발"의 실제 비용보다 **읽기 경로가 둘로 갈라지는 비용이 크다** — 뱃지 숫자와 목록이 어긋나는
  버그는 보상 CS 로 직결된다.
- **가드**: `hmb.mail.fanout-max`(기본 5000). 대상 수가 넘으면 **발송을 거부**(400)하고 로그에 남긴다.
  조용히 자르지 않는다 — 절반만 받은 이벤트는 회수도 재발송도 어렵다.
- **넘어설 때**: 그때 B 를 넣는다. 유저 API 응답 형태가 바뀌지 않으므로 web 은 무변경이다.
  (구체화 지점 = 목록 조회 시 `INSERT OR IGNORE … SELECT` 한 번.)
- **`audience='ALL'` 의 정의 = 발송 시점에 존재하는 유저 전원**. 이후 가입자는 대상이 아니다.
  근거: 보상의 사유(패치 피해·이벤트 참여)가 그 시점에 있던 사람에게만 성립한다.

### 3.3 수령 (유저)

```
GET  /api/mails                  → { mails:[…], unread: n }      # 목록 + 뱃지 수
POST /api/mails/{id}/read        → { id, readAt }                # 열람 기록(멱등)
POST /api/mails/{id}/claim       → { id, claimed:true, applied:true,
                                     granted:{points,gems,players:[{playerId,count,isNew}]},
                                     wallet:{points,gems} }
```

- **수령 = CAS 한 줄**: `UPDATE user_mails SET claimed_at=? WHERE id=? AND user_id=? AND claimed_at IS NULL`.
  0행이면 **이미 수령** → 200 `{claimed:true, applied:false, wallet:{현재}}`. 409 가 아닌 이유 =
  더블탭·재전송은 **같은 의도**이고, 유저에게 실패로 보일 이유가 없다(관리자 멱등키 케이스와 다르다).
- **지급은 그 트랜잭션 안에서 기존 경로로**:
  `WalletService.apply(userId, points, "mail_claim", userMailId)` ·
  `applyGems(userId, gems, "mail_claim", userMailId)` · 카드는 `user_players` upsert(`INSERT OR IGNORE` +
  `count+1`, `GachaService.upsertOwned` 와 같은 형태 — 공용 헬퍼로 뽑을지는 W2 구현 판단).
  ⚠️ **원장 유니크가 CAS 의 백스톱**이다. CAS 가 뚫려도(미래의 잘못된 리팩터) 돈은 두 번 나가지 않는다.
- **만료**: `expires_at < now` 면 **410 GONE**(`MAIL_EXPIRED`). 회수됨(`revoked_at`)도 같은 410
  (사유 문구만 다름) — 유저에게 "운영이 회수했다"까지 노출할 필요는 없고, 못 받는다는 사실이 같다.
- **남의 메일**: 404(존재를 숨긴다 — 공지 단건의 SCHEDULED 처리와 같은 규율).
- **첨부 0**(텍스트 전용)이면 `claim` 은 열람 확인일 뿐 지급이 없다. 그래도 같은 엔드포인트다
  (클라가 "첨부가 있나"로 분기해 다른 API 를 부르면 판정이 두 곳이 된다).

### 3.4 목록·뱃지·보존

- **목록**: `user_id` 기준 `created_at DESC`, 최대 50건. 각 항목 = `{id, title, body, attachments,
  sentAt, expiresAt, readAt, claimedAt, state}`.
  `state` 는 **서버가 계산해 준다**: `UNREAD | READ | CLAIMED | EXPIRED`.
  클라가 `expiresAt < now` 를 계산하면 **기기 시계가 진실이 된다**(공지 #248 이 남긴 규율 3번과 동일).
- **만료된 미수령도 목록에 남는다 — 회색 "만료됨"**(hero 확정 2026-07-30). 세션 권장은 "숨김"이었으나
  hero 가 **남기는 쪽**을 골랐다: 놓쳤다는 사실 자체가 유저에게 보여야 다음엔 안 놓친다.
  · `state='EXPIRED'` 로 내려보내고 web 은 흐리게 + [받기] 없이 그린다.
  · **뱃지에는 세지 않는다**(§ 아래) — 끌 수 없는 숫자가 남으면 뱃지가 무의미해진다.
  · 목록 상한 50건이 자연 정리를 한다(별도 보존 기간 규칙을 만들지 않는다 — 규칙이 늘면 "왜 이건
    사라졌나"가 또 하나의 답할 수 없는 질문이 된다). 수령한 메일도 만료 여부와 무관하게 남는다.
- **뱃지 수(`unread`) = "내가 아직 할 일"** = `read_at IS NULL` **또는** (`첨부 있음` **and**
  `claimed_at IS NULL`), 만료·회수 제외.
  ⚠️ 읽음만으로 뱃지를 끄면 **열어 보고 안 받은 보상이 조용히 사라진다** — 뱃지가 지켜야 하는 것이
  정확히 그 케이스다.
- `POST /read` 는 web 이 상세를 펼칠 때 호출한다(멱등, 이미 읽었으면 no-op).
- **홈 헤더 뱃지 전용 조회는 만들지 않는다** — `GET /api/me` 응답에 `mail:{unread, total}` 을 더한다.
  홈이 이미 부르는 유일한 호출이라 왕복이 늘지 않는다(인덱스 COUNT 2회).
  ⚠️ **`total` 이 함께 있어야 이 설계가 성립한다**(독립검증 MINOR-1): 진입점 유무 판정("우편 0건이면
  숨긴다")을 목록으로 하면 홈 진입마다 본문까지 실린 목록을 받게 되어, `unread` 필드는 아무도 안 쓰는
  죽은 값이 되고 왕복은 오히려 늘어난다. 지금은 **헤더 = `/api/me` 두 숫자**, **목록 = 열 때** 다.

### 3.5 회수 (오발송 수습)

```
POST /api/admin/mails/{id}/revoke  { "reason": "…" }  → { campaignId, revokedAt, unclaimed: n }
```
미수령분만 못 받게 만든다. **이미 수령한 건은 건드리지 않는다** — 원장을 되감는 것은 별개의
(그리고 훨씬 위험한) 조작이고, 필요하면 `admin points` 차감 경로로 개별 처리한다.
감사 `action='mail_revoke'`.

### 3.6 admin 조회

```
GET /api/admin/mails            → 캠페인 목록(최근순) + {targetCount, claimedCount, readCount}
GET /api/admin/mails/{id}       → 상세 + 수령 통계
```
"보냈나 / 몇 명이 받았나"는 운영이 가장 먼저 묻는 질문이라 목록에 수령률을 같이 싣는다.

---

## 4. openapi (프리즈 절차)

`docs/plan-v2/api/openapi.yaml` 에 추가할 것 — path 6개(`/api/admin/mails`,
`/api/admin/mails/{id}`, `/api/admin/mails/{id}/revoke`, `/api/mails`, `/api/mails/{id}/read`,
`/api/mails/{id}/claim`) + 스키마 5개(`MailAttachments`, `AdminMailSendRequest`, `AdminMailCampaign`,
`Mail`, `MailListResponse`) + `MeResponse.mail`. tag `mails` 신설.
W2 에서 **서버 구현과 같은 PR** 에 넣는다(계약이 코드보다 늦으면 web 이 추측으로 만든다).

---

## 5. 화면 위치 — **A 확정**(hero, 2026-07-30)

목업 = `docs/plan-v5/mock/mailbox/index.html` (로컬, 390px). 두 안이 **같은 목록·상세 화면**을
쓰고 **진입점만** 달랐다. hero 가 **A(홈 헤더 ✉️)** 를 골랐다.

| | **A. 홈 헤더 봉투 아이콘**(✅ 확정) | ~~B. 내 정보 탭 안~~ |
|---|---|---|
| 진입 | 홈 헤더, 닉네임 옆 ✉️ + 숫자 뱃지 | 하단탭 [내 정보] → 목록 안 "우편함" 행 |
| 발견성 | **홈에 들어오면 보인다** — 보상 즉시성 | 탭 하나 더 → 보상이 며칠 잠들 수 있다 |
| 헤더 비용 | 아이콘 1개 추가(공지 벨 옆). 390px 실측 필요 — #248 이 같은 자리에서 **왼쪽(닉네임 옆)만 +8px** 로 끝남을 이미 측정했다(오른쪽은 한 줄 접힘) | 0 |
| 만료 압박 | 뱃지가 계속 보여 만료 전에 받는다 | 만료로 잃을 확률이 높다 |
| 확장 | 메일이 늘면 헤더 뱃지 하나로 계속 커버 | 탭 안이라 항목이 늘어도 여유 |

근거: 첨부가 **만료되는 자산**이라 발견성이 곧 손해와 직결된다. 공지(놓쳐도 손해 없음)와 다른
축이다. 비용은 아이콘 한 개이고, 그 자리(닉네임 옆)의 헤더 증가는 #248 이 이미 +8px 로 실측했다.

### ⚠️ W3 실측이 이 절의 전제를 뒤집었다 — **닉네임을 헤더에서 뺐다**(hero 확정 2026-07-31)

위 표의 "닉네임 옆 +8px" 는 #248 이 **구 로비 헤더**에서 측정한 값이고, 지금 홈 헤더에서는 성립하지
않았다. 실측(390px, 내부 폭 362px):

| 조각 | 폭 |
|---|---|
| 오른쪽(지갑 2칩 204 + [로그아웃] 62 + gap) — `flex: 0 0 auto` **고정** | **272** |
| 왼쪽에 남는 몫 | 90 |
| 공지(28) + 우편(28) + gap(12) | 68 |
| → 닉네임 몫 | **22px** |

닉네임에 하한을 주면 줄어들 곳이 없어 **지갑 칩 위로 겹쳐 그려졌다**(캡처 `.smoke/p323-opt0-now.png`).
대안 3개(로그아웃 아이콘화 34px 절약 / 지갑 축약 68px / 두 줄 허용)를 **실제 화면에 적용해 캡처**했고
한 줄을 지키는 것은 닉네임 제거뿐이었다 → hero 가 그 안을 골랐다.

- **정보 손실 0**: 바로 아래 팀 카드가 "{닉네임}의 팀", [내 정보] 탭에도 그대로.
- **되살리는 조건**: 오른쪽에서 무언가를 **먼저** 빼야 한다(왼쪽에 넣는 것만으로는 자리가 없다).
  근거는 `apps/web/src/home/HomePage.module.css` 주석에 박아 뒀다.
- ⚠️ **이 결함은 넘침 지표를 통과했다** — 겹친 상태에서도 `docOverflow = 0` 이었다. 헤더에 무언가를
  얹을 때는 수치만 보지 말고 **찍어서 눈으로 봐라**(루트 §2-2).

> [내 정보]에 같은 진입점을 하나 더 두는 것은 자유다(같은 화면으로 간다) — W3 판단.

---

## 6. hero 확정 결정 (2026-07-30, 세션 창)

| # | 항목 | 확정 | 비고 |
|---|---|---|---|
| 1 | 위치 | **A — 홈 헤더 ✉️ + 숫자 뱃지** | 세션 권장과 동일 |
| 2 | 이름 | **"우편함"** | 아이콘 ✉️ 유지. 화면 문구·API 문서 전부 우편함으로 통일(테이블·경로는 `mail*` 영문 유지) |
| 3 | 만료 기본값 | **무기한**(발송 시 미지정이면) | 유저가 보상을 잃는 경로는 "운영이 명시적으로 기간을 정한 경우"뿐 |
| 4 | 만료 미수령 표시 | **회색 "만료됨"으로 목록에 남긴다** | ⚠️ 세션 권장(숨김)의 **반대** — §3.4 에 반영. 뱃지에는 세지 않는다 |
| 5 | 홈 헤더 닉네임 | **제거**(2026-07-31 추가 컨펌) | W3 실측이 §5 의 "+8px" 전제를 뒤집었다 — 4안을 실화면으로 비교해 hero 가 A(제거)를 선택. 되살리는 조건은 §5 |

---

## 7. 게이트 (W2/W3 공통)

- server: `./gradlew test --rerun-tasks` (절대경로) — 멱등 재전송·CAS 이중수령·만료·회수·팬아웃 상한 계약.
- web: `npm --prefix apps/web run build`(타입 게이트) + 목킹 e2e 390px(뱃지·목록·수령·만료).
- openapi 갱신 동반. 마이그레이션 번호는 merge-ready 시 main 배정.
- 최종 = **독립검증**(module-verifier, 별도 컨텍스트) PASS 후 merge-ready 보고.

---

## 8. 운영 런북 — 무배포 발송 (W2 착지 후)

> 이 절이 이 에픽의 **목적**이다: 패치 보상·이벤트 지급을 **재배포 없이** 보낸다.
> 배포 좌표·터널 주소는 `docs/plan-v4/deploy-playbook.md`, 발송 이력은 `GET /api/admin/mails`.

### 준비 — admin 토큰
```bash
API=https://<터널URL>            # 현재 주소는 infra/status.sh 가 알려준다
TOKEN=$(curl -s -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"provider":"local","nickname":"<admin닉>","password":"<admin비번>"}' | jq -r .token)
```

### 전체 유저에게 패치 보상
```bash
curl -s -X POST "$API/api/admin/mails" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "audience": "ALL",
    "title": "v3.02 패치 보상",
    "body": "리그 승급 판정 오류로 불편을 드려 죄송합니다. 보상을 첨부하니 받아 주세요.",
    "attachments": { "points": 5000, "gems": 10, "players": [{"playerId":"P001","count":1}] },
    "expiresInDays": 14,
    "reason": "v3.02 패치 보상 (#323)"
  }' | jq
```

⚠️ **`Idempotency-Key` 를 항상 붙여라.** 없으면 서버가 채번하므로 그 요청은 재전송 보호를 받지
못한다(응답의 `idempotencyKey` 로 그 사실이 관측된다). 응답 코드로 결과를 구분한다:
**201 = 이번에 보냈다 · 200 = 재전송이라 아무것도 더 보내지 않았다 · 409 = 같은 키에 다른 내용**.

### 특정 유저에게
```bash
# 유저 id 는 GET /api/admin/users?q=<닉> 로 찾는다
-d '{"audience":"USERS","userIds":["u_…","u_…"], … }'
```

### 보낸 뒤 — 얼마나 받았나
```bash
curl -s "$API/api/admin/mails" -H "Authorization: Bearer $TOKEN" | jq '.campaigns[0]'
# → targetCount / readCount / claimedCount
curl -s "$API/api/admin/mails/history" -H "Authorization: Bearer $TOKEN" | jq   # 성공·실패 전부
```

### 잘못 보냈다 — 회수
```bash
curl -s -X POST "$API/api/admin/mails/<campaignId>/revoke" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"금액 오기입 — 재발송 예정"}' | jq
```
**미수령분만** 막힌다(그들에겐 410). 이미 받은 사람의 지갑은 건드리지 않는다 — 되감아야 하면
`POST /api/admin/users/{id}/points` 로 개별 차감한다(그 경로에 잔액 하한·감사가 이미 있다).

### 실패했을 때 읽는 법
| 응답 | 뜻 | 할 일 |
|---|---|---|
| 400 `VALIDATION_ERROR` | 없는 유저·없는 카드·음수/상한 초과 첨부·사유 누락·**팬아웃 상한 초과** | 메시지대로 고친다. **아무것도 보내지지 않았다**(부분 발송 없음) |
| 409 `CONFLICT` | 같은 멱등키에 다른 내용 | 내용을 바꿀 거면 **새 키**로. 조용히 삼키지 않는 것이 의도다 |
| 403 | admin 아님 | 토큰 확인 |

### 상한을 바꿔야 할 때 (무배포)
`hmb.mail.*` 는 전부 env 로 뜬다 — `HMB_MAIL_FANOUTMAX` · `HMB_MAIL_MAXPOINTS` · `HMB_MAIL_MAXGEMS` ·
`HMB_MAIL_MAXPLAYERKINDS` · `HMB_MAIL_LISTLIMIT`. 컨테이너 재기동만 필요하고 이미지는 그대로다.
⚠️ 상한을 올리기 전에 **나눠 보내기**를 먼저 검토해라 — 상한은 오타 한 번의 폭을 막는 장치이고,
전체 발송은 되돌릴 수 없는 인플레이션이다(회수는 미수령분만 막는다).

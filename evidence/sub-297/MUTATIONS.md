# #297 변이체 검증 — 새 계약이 실제로 무엇을 죽이나

"통과만 하고 아무것도 안 잡는 계약은 없느니만 못하다". 각 변이는 **구현을 되돌리거나 조건을
상수화**해 적용한 뒤 콜드 재실행(`--rerun-tasks`)했고, 확인 후 `git checkout` 으로 되돌렸다.
로그 전문은 같은 디렉토리의 `MUT-*.log`.

| 변이 | 무엇을 되돌렸나 | 죽은 계약 | 로그 |
|---|---|---|---|
| **M1** | `WebMvcConfig.excludePathPatterns` 에서 `"/api/notices/{id}"` 제거 (= 인증 뒤로 되돌림) | **14 failed / 24** — `NoticeByIdApiTest` 6/6 + `NoticeByIdStatusTest` 8건 전부 401 | `MUT-M1-auth-exclude.log` |
| **M2a** | 예약 공지를 200 으로 흘림 (`status == LIVE \|\| status == SCHEDULED` 로 통과) | **3 failed / 10** — `scheduledNoticeIs404` · `scheduledIsIndistinguishableFromAbsent` · `theSameNoticeMovesThroughTheTableAsTimeMoves` | `MUT-M2a-scheduled-200.log` |
| **M2b** | 예약 공지를 410 으로 (존재는 흘리되 본문만 가림 — "친절한" 우회) | **3 failed / 10** — 같은 3건 | `MUT-M2b-scheduled-410.log` |
| **M3** | `PublicNotice` 에 운영 필드 `deletedAt` 한 칸 추가 | **3 failed / 24** — `operationalFieldsNeverLeak` · `nullWindowStillCarriesTheKeys` · (기존) `NoticeActiveApiTest.payloadCarriesExactlyWhatThePopupNeedsAndNothingMore` | `MUT-M3-leak-field.log` |
| **M4** | 상태 판정을 SQL 로 우회 (`WHERE id = ? AND active = 1 AND deleted_at IS NULL`) | **1 failed / 10** — `switchedOffNoticeIs410`(OFF 가 410 이 아니라 404 로 뭉개진다) | `MUT-M4-sql-filter.log` |

## 왜 이 다섯인가

- **M1** = AC1 이 막으려는 결함 그 자체(인증 제외가 조용히 되돌려지는 것). 이 목록은 사람이 손으로
  관리하는 한 줄이라 리팩터링에 쉽게 휩쓸린다.
- **M2a** = 이슈가 지정한 필수 변이(예약 유출 가드). **M2b 를 같이 돌린 이유**: 코드만 404 로 맞추고
  "아직 시작 전입니다" 라고 안내하는 쪽이 구현자에게 더 자연스러운 유혹이다 — 그 우회도 죽는지
  확인해야 "존재를 숨긴다"가 계약이 된다. 본문까지 동등 단언(`scheduledIsIndistinguishableFromAbsent`)이
  그 역할을 한다.
- **M3** = AC3. 부분집합 단언이었다면 **셋 다 통과**했을 변이다(필드가 늘기만 했으므로).
- **M4** = "규칙을 두 곳에 적지 마라"가 말뿐이 아님을 보이는 변이. 조건을 SQL 로 옮기면
  `Notices.status` 는 호출되지만 **OFF/삭제 행이 애초에 안 읽혀** 410 이 404 로 뭉개진다.

## 정직하게 적는 관측 하나 (변이가 **안 죽은** 케이스)

`NoticeController.BLOCKED` 표에서 `SCHEDULED` 항목만 지우는 변이는 **아무 테스트도 죽이지 않는다**.
`getOrDefault(..., absent)` 가 표에 없는 상태를 404 로 떨어뜨리기 때문이다 — 즉 이 변이는 동작을
바꾸지 않는 no-op 이다(fail-safe 설계의 의도된 결과). 표에서 항목이 빠졌을 때 위험한 방향은
"200 이 새는 것"인데 그 길은 코드상 존재하지 않는다. 결정표의 구멍 자체는
`NoticeByIdStatusTest.everyStatusHasADecision` 이 테스트 쪽 표에서 잡는다.

## 시행착오 기록

`NoticeActiveApiTest.activeNoticesAreReachableWithoutAuth` 의 javadoc 은 *"`excludePathPatterns` 에서
이 경로를 빼면 실제로 깨진다"* 라고 적혀 있었는데, `"/api/notices/{id}"` 를 같은 목록에 넣은 뒤로는
**사실이 아니다**(`{id}` 패턴이 `active` 세그먼트도 매칭한다). 주석을 사실에 맞게 정정했다 —
변이체 주장이 틀린 계약 문서는 다음 사람에게 거짓 안전감을 준다.

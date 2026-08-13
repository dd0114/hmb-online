# #497 — 다음 **자연** 재부팅에서 확인할 것 (STATE 반영본, 2026-08-13)

> ⚠️ **인위적 재부팅 금지.** 이 맥에는 라이브 백엔드(hmb-java/-runner)와 **다른 도메인 컨테이너 6개**,
> 그리고 다른 도메인 세션들이 붙어 있다. 아래는 *언젠가 자연히* 재부팅이 났을 때 그대로 훑는 목록이다.
> 이 파일이 존재하는 이유: 재부팅 검증은 **몇 주 뒤 다른 세션이** 하게 된다 — 이슈 코멘트에만 두면
> 그때 사람이 스크롤해서 찾아야 한다.

## 0. 지금까지 확정된 것 (재부팅 없이 검증 끝난 것)

| 항목 | 상태 | 근거 |
|---|---|---|
| 워치독 기동 전제 결함(`WorkingDirectory` → `EX_CONFIG(78)`) | ✅ 해소 | `evidence/497/workdir-removal-proof.log` · 커밋 `9d610228` |
| 심박 파일 · `status.sh` 가시화 | ✅ 동작 | 라이브 실측 `HEAL_OK` (URL 회전 흡수 확인) |
| Docker Desktop `autoStart` = **true** | ✅ 파일에 박힘 | 매니저 직접 실행, #497 코멘트 **5280856314** |
| 컨테이너 8개 자동 복귀(`restart: unless-stopped`) | ✅ 실측 | 데몬 ~10초 · 전체 healthy ~24초 · **총 다운타임 약 1분** · `status.sh` 10/10 ✓ |
| 워치독 **규칙 4**(백엔드 사망 시 터널 재기동 안 함) | ✅ **실증** | 정지 창에 `13:07:00Z BACKEND_DOWN` 만 찍고 재기동 안 함 → cloudflared **pid 3562 불변 · URL `pack-pipe-python-madrid` 불변 · web 재배포 불필요** |

**적용 경위 요약**(상세 = 코멘트 5280856314): hero 가 GUI 에서 켰다고 했으나 파일은 `false` 였고,
Docker 종료 후에도 `false` 라 "종료 시 플러시" 가설도 아니었다. 4.21.1 은 `docker desktop` CLI 가
없어 **파일 직접 편집이 유일 경로**였다 → 백업(sha256 `4766a782498c46a7…`) → 정규식 1건 치환(치환 수
assert) → JSON 유효성 확인 → 기동. **기동 후에도 true 유지** = Docker 가 되돌려 쓰지 않는다(이게 진짜
확인 포인트였다).

⚠️ **왜 laptop 워커가 안 했나**: 반경이 hmb 밖이었다(tfs-ledger-view 는 20초마다 폴링하는 **살아 있는
소비자**). 남의 도메인 가용성을 hmb 권한으로 소비할 수 없어 정지 → hero 승인 → **매니저가 직접** 실행,
워커는 레이스 방지로 잠갔다.

## 1. ⚠️ 미검증 — 여기가 이 체크리스트의 본체

- [ ] **`autoStart=true` 가 재부팅에서 실제로 발화하나** — 파일 값이 true 인 것과 로그인 시 뜨는 것은 다른 명제다.
- [ ] **로그인 아이템/백그라운드 항목에 Docker 가 등록됐나** — 플립 시점에는 **미등록 상태에서 파일만 true** 였다.
      `autoStart` 가 하는 일은 `DockerHelper.app` 을 `SMLoginItemSetEnabled` 로 등록하는 것뿐이므로,
      **등록이 안 됐으면 파일 값은 무의미**하다. ⚠️ `sfltool dumpbtm` 은 **매달린다**(매니저·워커 양쪽에서
      재현, 죽여야 했다) — 이 확인은 `osascript -e 'tell application "System Events" to get the name of
      every login item'` 이나 재부팅 실측으로 한다.
- [ ] ⚠️ **자동 로그인이 아니면 autoStart 로는 부족하다** — 로그인 세션이 열려야 발화한다.
      아니라면 autoStart 도 `infra/install-docker-autostart.sh` 대안도 같은 한계를 갖는다(별도 판단 항목).

## 2. 재부팅 직후 훑을 순서

- [ ] Docker Desktop 이 **사람 개입 없이** 떴나 (`docker info`)
- [ ] 컨테이너 8개가 자동 복귀했나 (`docker ps` — hmb 2 + tfs-ledger-view + hmb-growth 3 + komodo 2)
- [ ] java·runner·executor 가 Up 인가 (`cd infra && docker compose ps`)
- [ ] 백엔드 `:18080` 응답 → 워치독이 터널을 스스로 복구했나 (`bash infra/status.sh`)
- [ ] **재부팅을 건너 심박이 이어지나** ← #497 fix 의 핵심 (`~/.local/state/hmb/last-tick` 신선도)
- [ ] `launchctl print gui/$(id -u)/online.hmb.tunnel-heal` 의 `last exit code` **≠ 78**
      (78 = 또 다른 **기동 전제**가 남아 있다는 뜻. 그 경우 프로그램이 아예 실행되지 않아 로그도 비어 있다)
- [ ] `/var/tmp/hmb-wrangler-work` 가 재부팅을 넘겼나 ← **미검증 가정의 실측 기회**.
      실패해도 fix 는 성립한다(보증은 소비자의 매 실행 `mkdir -p`)

## 3. 되돌리기

`autoStart` 를 되돌리려면 **Docker 가 종료된 상태에서** `settings.json` 의 `"autoStart": true` → `false`.
돌아가는 중에 고치면 종료할 때 자기 메모리 상태로 덮어쓴다. 원본 sha256 = `4766a782498c46a7…`
(백업 위치는 매니저 실행 로그 = 코멘트 5280856314).

⚠️ 되돌릴 때도 **반경은 컨테이너 8개**다 — hmb 단독 판단으로 하지 마라.

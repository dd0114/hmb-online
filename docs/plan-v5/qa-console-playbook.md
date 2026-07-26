# QA 콘솔 플레이북 (#191) — 다른 세션이 이걸 보고 쓴다

> **한 줄**: hero 는 브라우저 탭 하나(`http://127.0.0.1:8300/qa/console`)만 본다. 워커 세션은 자기 탭을 등록하고
> `wait` 로 잠들었다가, hero 가 남긴 문장을 **지시로 받아** 이어서 진행한다.
> 설계 근거·결정표는 `qa-console.md`. 이 문서는 **복붙용 레시피**다.

---

## 0. 콘솔 띄우기 (hero 또는 QA 매니저 세션이 1회)

```bash
node tools/qa-console.mjs start     # nohup 분리기동(API 8301 + vite 8300) + health 확인
node tools/qa-console.mjs status    # 두 포트 응답 · pid 생존 · 최근 git 기록
node tools/qa-console.mjs stop      # pid 파일의 PID 만 종료
node tools/qa-console.mjs logs      # 최근 80줄
```

- 레지스트리: `~/hmb-qa-console/`(고정 경로 · 자체 git 리포). `HMB_QA_CONSOLE_HOME` 으로 변경.
- **재부팅/재시작 복구**: `start` 한 번. 탭·피드백·ack 은 파일이라 그대로 살아 있다.
  세션 쪽은 `wait --since <ack 커서>` 로 놓친 것부터 받으므로 **유실 0**.
- 로컬 전용(127.0.0.1, 인증 없음). 외부 노출·아티팩트 금지.

---

## 1. 워커 세션 루프 (이 6줄이 전부)

```bash
# 0) ⚠️ 탭은 hero 가 요청했거나 "탭 만들까요?" 컨펌을 받았을 때만 만든다(자율 생성 금지)
# 1) 등록 — stdout 으로 나온 URL 한 줄을 hero 에게 알린다
node tools/qa-tab.mjs register --id 182-corner-stay --issue 182 \
  --title "코너 전원 전진 → 잔류 1~3명" \
  --summary-file .qa/182.md \
  --ask "잔류 인원이 자연스러운가? 잔류 선수가 멍하니 서 있지 않은가?" \
  --log packages/engine/dev-viewer/e2e/fixture-real.json@after:"after (fix)" \
  --log .qa/before-182.json@before:"before (0.19.0)" \
  --point "12:34 첫 코너 — 잔류 확인" \
  --point "12:34@before 같은 장면 before"

# 2) 판정 대기 상태로 전환
node tools/qa-tab.mjs status --id 182-corner-stay --set waiting

# 3) 잠든다 — **백그라운드로** 걸어라(run_in_background). 피드백 도착 = 프로세스 종료 = 세션 자동 재진입
node tools/qa-tab.mjs wait --id 182-corner-stay --timeout 900

# 4) 깨어나면 받는다 (wait 의 stdout 에 이미 들어 있다. 다시 보려면:)
node tools/qa-tab.mjs feedback --id 182-corner-stay --unread --json

# 5) hero 문장을 **사용자 지시 그대로** 수행한다. 처리 상태를 남긴다
node tools/qa-tab.mjs ack --id 182-corner-stay --seq 2 --state working --note "재현 중"
#    approve → 다음 단계 진행 / reject → 고치고 update 후 2번으로 / 태그 없음 → 문장대로 판단

# 6) 끝나면
node tools/qa-tab.mjs status --id 182-corner-stay --set resolved
node tools/qa-tab.mjs export --id 182-corner-stay      # issues/qa-182-corner-stay.md → 픽스 PR 에 같이 싣는다
```

### `wait` 를 어떻게 거는가 (중요)

Claude Code 세션에서는 **Bash `run_in_background: true`** 로 건다. 그러면 프로세스가 끝날 때
하네스가 세션을 다시 불러준다 — 주기적으로 깨어나 확인할 필요가 없다(그건 조용할 때도 비용을 태운다).

```
Bash(command: "node tools/qa-tab.mjs wait --id 182-corner-stay --timeout 900", run_in_background: true)
```

exit code: `0` 피드백 도착 · `3` 타임아웃(다시 걸면 됨) · `4` 없는 탭 · `5` 탭 삭제됨.

---

## 2. 탭에 무엇을 담나 (hero 가 읽는 것)

hero 는 **탭 설명만 읽고** 판단한다. 그래서 이 세 개가 실제 내용을 가져야 한다.

| 필드 | 무엇 | 나쁜 예 → 좋은 예 |
|---|---|---|
| `--summary` | **무엇이 문제였고 무엇을 고쳤나** | "코너 수정" → "코너킥에서 11명 전원이 박스로 올라가 잔류 0명이었다. 팀축/선수축/롤백 3층 + 잔류 지터로 1~3명 잔류" |
| `--ask` | **hero 가 눈으로 봐줄 것**(질문 형태) | "확인 부탁" → "잔류 인원이 자연스러운가? 잔류 선수가 멍하니 서 있지 않은가?" |
| `--point` | **어느 초의 어느 장면**(클릭하면 그 초로 점프) | 없음 → `"12:34 첫 코너 — 잔류 확인"` |

- `--point` 시각 표기: `12:34` · `12'34"` · `12 34` · `754`(초=틱) 다 된다. `12:34@before` 처럼 **볼 뷰**도 지정.
- `--log <경로>@<id>:<라벨>` 를 두 번 주면 콘솔에 **before/after 전환 버튼**이 생긴다. 상대경로 OK(세션 cwd 기준).
- 로그는 **복사되지 않는다** — 세션 체크아웃의 파일을 콘솔이 그대로 읽는다. 로그를 다시 만들면 다음 로드에 자동 반영.
- 등록 시 로그 존재를 검증한다. 없으면 register 가 실패 → hero 가 빈 화면을 보기 전에 세션이 안다.

---

## 3. hero 쪽 조작 (콘솔 화면)

1. 좌측에서 탭 선택(`내 확인 필요` 가 위로 정렬). `?tab=<id>` 딥링크로 바로 열 수도 있다.
2. 좌측 브리핑을 읽고 **확인 포인트 클릭** → 그 초로 점프. 뷰 버튼으로 before/after 왕복.
3. #180 컨트롤로 정밀 확인: `←/→` ∓1초 · `Shift+←/→` ∓5초 · `,`/`.` ∓1프레임 · `Space` 재생/정지.
4. 아래 한 줄에 **본 대로 적고** `💬 전달 ⏎`. 태그는 선택:
   - `✅ 승인` = "다음 단계 진행해라" (본문 없이도 가능)
   - `❌ 거부` = "고치고 다시 올려라" (**사유 필수** — 없으면 세션이 뭘 할지 모른다)
   - 태그 없이 전달 = 그 문장대로 판단하라는 뜻
5. `지금 장면` 체크가 켜져 있으면 보고 있던 뷰·초가 함께 전달된다.
6. 이력에 `세션 미수신 → 세션 수신 ✓ 처리중/완료` 배지가 붙어 **전달됐는지**가 보인다.

---

## 4. 기록·이력 (git)

레지스트리는 자체 git 리포라 **변경마다 커밋**된다.

```bash
node tools/qa-tab.mjs history --id 182-corner-stay      # 그 탭의 QA 왕복 이력
git -C ~/hmb-qa-console log --oneline                    # 전체
node tools/qa-tab.mjs sync                               # 원격이 붙어 있으면 push(환경 이동용)
```

픽스 PR 에는 `export` 산출물(`issues/qa-<탭>.md`)을 같이 싣는다 → **그 픽스의 QA 근거가 main 히스토리에 남는다.**

---

## 5. 정리 규약

| 상황 | 무엇을 한다 |
|---|---|
| 작업 끝 | `status --set resolved`. 탭은 남는다(기록) — 목록에서 아래로 내려간다 |
| 잘못 만든 탭 | `remove --id …`. 파일은 지워지고 **git 이력에는 남는다** |
| 세션이 죽었다 | 갱신 6시간 초과 + 미수신 피드백 있음 → 콘솔에 `⚠ 세션 응답 없음` 배지. hero 가 그 세션 창으로 가면 된다 |
| 세션 재시작 | `wait --since <ack 커서>` 로 놓친 피드백부터 받는다 |

---

## 6. 문제가 생기면

| 증상 | 먼저 볼 것 |
|---|---|
| 콘솔이 "서버 무응답" | `node tools/qa-console.mjs status` → `logs` |
| 탭이 안 보인다 | `qa-tab.mjs list` (레지스트리에 있나) → `HMB_QA_CONSOLE_HOME` 이 서로 같은가 |
| 경기가 안 뜬다 | `qa-tab.mjs show --id …` 의 로그 경로 존재 확인. 허용 경로는 홈 아래 + 임시 디렉토리(`HMB_QA_LOG_ROOTS` 로 추가) |
| 피드백을 못 받는다 | `feedback --id … --unread` → 비었으면 ack 커서가 이미 지나갔다(`show` 로 확인) |
| 확인 포인트가 엉뚱한 초로 | `--point` 표기 확인. 로그보다 큰 초는 마지막 틱으로 클램프된다 |

## 7. 테스트 (이 시스템을 고칠 때)

```bash
npx vitest run tools/qa-console apps/web/src/qa            # 레지스트리·wait·CLI·API·화면로직
cd apps/web && WEB_E2E_PORT=5288 npx playwright test e2e/qa-console.spec.ts   # 왕복 전체
```

E2E 는 `HMB_QA_CONSOLE_HOME`=tmp 로 격리한다 — **hero 의 실제 탭을 절대 건드리지 않는다.**
(apps/web 전체 e2e 는 돌리지 말 것 — 데모 백엔드에 붙는다. 스펙 지정 + 대체 포트.)

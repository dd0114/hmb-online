---
name: fleet-health
description: hmb 매니저(hmb:main)가 하위 워커 세션 상태를 점검할 때의 행동강령. 겉모습이 아니라 실활동 증거로 판정하고, 멈춘 세션을 안전하게 되살린다. "진행 상황 보고/확인", "세션 살아있냐", 오래 조용할 때 반드시 이 절차를 따른다.
---

# fleet-health — 워커 세션 실활동 점검·되살리기

## 왜 (실패에서 나옴)
매니저가 세션 화면의 겉모습(`← 4 agents`, 스피너, `Baked/Worked for Xh`)만 보고 "진행 중"으로 오판한 적이 있다.
실제로는 **작업 완료 후 다음 지시가 입력창에 미제출로 남아 6~32시간 방치**돼 있었다. 겉모습은 살아있는 것처럼 보인다 — **믿지 마라.**

## 철칙
1. **겉모습 신뢰 금지.** `4 agents`·스피너·`Worked for Xh`는 활동 증거가 아니다.
2. **실활동 = ① 워크트리 브랜치 마지막 커밋 시각 ② 이슈 마지막 코멘트 시각 ③ 화면에 `esc to interrupt`(=생성 중) ④ 입력창(`❯`) 미제출 텍스트 유무.** 이 네 개로만 판정한다.
3. 상태 확인·보고 요청이 오면 **항상 먼저** `bash .claude/skills/fleet-health/check.sh hmb` 를 돌린다.

## 판정 (check.sh 출력)
- **WORKING** = 화면에 `esc to interrupt`. 실제 생성 중. 건드리지 마라.
- **STUCK** = 미제출 입력이 입력창에 있고 생성 중 아님. **되살려야 함**(아래 절차).
- **IDLE** = 입력창 비었고 커밋 30분+ 정지. 작업 완료 후 대기 — **다음 웨이브 지시가 필요**하거나 정말 끝. 이슈/브랜치를 확인해 머지 요청·완료 여부를 판단하고 지시하거나 머지한다.
- **RECENT** = 방금 커밋. 정상 진행.

## STUCK 되살리기 절차 (중요 — 그냥 Enter 금지)
입력창에 텍스트가 남은 상태에서 tmux `Enter`만 치면 **제출이 안 된다**(그래서 방치됐던 것).
1. **입력창 텍스트를 먼저 읽어라**(`tmux capture-pane`). 유효한 미제출 지시일 수 있다 — 지우면 손실.
2. `tmux send-keys -t hmb:<w> C-u` 로 입력창을 **비운다**.
3. `fleet send hmb:<w> "<지시>"` 로 재전송한다(fleet send가 텍스트+Enter를 함께 보낸다).
   - 입력창 텍스트가 유효했으면 그 취지 그대로, 무효/스테일이면 새 지시로.
4. 6~8초 후 `tmux capture-pane` 로 `esc to interrupt`(생성 시작) 확인. 안 뜨면 재시도, 그래도 안 되면 세션 hang → `FLEET_FORCE=1 fleet done` 후 재기동 고려(워크트리 커밋은 보존됨).

## 정기 규율
- 매 상태 보고 전 check.sh 1회.
- 브랜치 커밋 시각이 마지막 확인 대비 안 늘고 IDLE/STUCK이면 즉시 개입.
- WORKING만 믿고 지나치지 말 것 — WORKING이어도 다음 확인 때 커밋이 안 늘었으면 그 서브에이전트가 hang일 수 있다(브랜치 시각 교차검증).

## 정적 순찰 (비용 0 — Claude 무조건 깨우지 않기)
매니저를 매 20분 무조건 깨우던 ScheduleWakeup 순찰은 **비쌌다**(아무 일 없어도 Claude 턴 소비).
대신 **`patrol-static.sh`** 를 **launchd(5분 주기, `~/Library/LaunchAgents/com.hmb.patrol.plist`)** 로 돌린다 — 순수 bash, **Claude 0호출**.
- 정적으로 각 워커 판정(check.sh 로직). **STUCK 또는 IDLE 일 때만** `fleet send hmb:main` 으로 매니저 Claude 를 깨운다. WORKING/RECENT 면 조용히 종료(비용 0).
- 쿨다운(STUCK 20분·IDLE 60분, `~/.cache/hmb-patrol/last_*`)으로 같은 상황 반복 호출 방지. 로그=`~/.cache/hmb-patrol/patrol.log`.
- 제어: `launchctl list com.hmb.patrol` · 중단 `launchctl bootout gui/$(id -u)/com.hmb.patrol` · 재로드 `launchctl bootstrap gui/$(id -u) <plist>`.
- **원칙**: 비싼 Claude 개입은 "실상황(STUCK/IDLE) 감지 시에만". 시스템 cron 은 macOS TCC 로 막혀 launchd 사용.

## 도구
- `patrol-static.sh [session]` — 정적 감시+조건부 에스컬레이션(launchd 가 주기 실행).
- `check.sh [session]` — 한 방 점검 표(기본 hmb).
- `fleet status` — 트리 전체 프로세스/브랜치.
- 이슈 실시각: `gh issue view N --json comments -q '.comments[-1].updatedAt'`.

# 랩탑(WSL2) 자가치유 — 설치 순서와 근거

SoT = **#489 단계 3.5**. 맥의 자가복구(#183)를 랩탑으로 옮기되, **워치독 본체는 이식이지 재작성이 아니다**.

## 왜 재작성하지 않나

`infra/tunnel-heal.sh` 안의 판정 규칙 5개는 전부 **실장애에서 나온 것**이다:

1. **PID 생존은 헬스가 아니다** — 2026-07-22 장애는 프로세스가 살아 있는 채로 터널 등록이 만료됐다.
2. **해석기는 다중** — `1.1.1.1` 이 이 회선에서 안 뜬다. *전부* 실패해야 DNS 사망으로 친다.
3. **토큰 없는 401 프로브** — `GET /internal/health` 가 401 이면 그것 자체가 터널→백엔드 경로 생존의 증거다
   (000/502/503/504/530 이 사망). 부작용이 없어 매분 돌려도 안전하다
   (`status.sh` 의 `POST /api/auth/login` 은 틱마다 유저를 만든다).
4. **백엔드가 죽었으면 터널을 재기동하지 않는다** — 다른 고장이고, 재기동은 스래시만 만든다.
5. **종료는 PID 로만** — `pkill -f cloudflared` 는 다른 세션 스택을 죽인다.

실제로 그 스크립트엔 macOS 관용구가 **하나도 없다**. 갈아끼우는 것은 **스케줄러뿐**이다.

| 부품 | 맥 | 랩탑 |
|---|---|---|
| 워치독 본체 | `infra/tunnel-heal.sh` | **같은 파일** (그대로 설치) |
| 60초 틱 | launchd `StartInterval` | systemd `.timer` `OnUnitActiveSec` |
| 부팅 첫 틱 | launchd `RunAtLoad` | systemd `.timer` `OnBootSec` |
| 치유가 띄운 터널 보호 | `AbandonProcessGroup` | **`KillMode=process`** ← 없으면 매 틱 새 터널 스래시 |
| 스택 기동 | (수동/compose) | `hmb-stack.service` |
| OS 부팅 진입 | (불필요) | **Windows 작업 스케줄러 AtStartup → `wsl -d Ubuntu --exec sleep infinity`** (아래 ⚠️) |

## ⚠️ WSL 은 **깨우는 것만으로 부족하다 — 붙잡아야 한다** (2026-08-12 실측)

부팅 태스크의 초판은 `wsl -d Ubuntu -- /bin/true` 였다. 깨우고 **즉시 끝난다**. 그러면 WSL 은 붙어 있는
클라이언트가 없다고 보고 **배포판을 내린다** — systemd·docker·컨테이너·cloudflared·역방향 ssh 가 전부
같이 죽는다. 실측: 저널이 `22:59:51 → 00:38:34` **1시간 39분** 통째로 비었고, 그동안 힐 틱 **0회**,
터널 소멸, 맥에서 ssh 로 깨울 때까지 **아무도 되살리지 않았다**. (그날 역방향 ssh 가 끊긴 것도 같은 원인이다.)

**절전이 아니다** — AC 전원의 `STANDBYIDLE`·`HYBRIDSLEEP`·`HIBERNATEIDLE` 이 전부 `0`(안 잠)이고
`powercfg /lastwake` 기록도 0 이다. **`.wslconfig` 의 `vmIdleTimeout=-1` 로도 안 막힌다** — 그건
유틸리티 **VM** 을 잡는 값이지 **배포판**을 잡는 값이 아니다.

⚠️ 진단이 헷갈리는 이유: WSL2 는 VM 커널을 공유해서 배포판이 재시작해도 `boot_id` 와 `/proc/uptime` 이
**연속으로 보인다**(`journalctl --list-boots` 도 한 부트로 뭉친다). 실제로 움직이는 것은 **journald 의
시작 시각과 `who -b`** 뿐이다 — 배포판 사망을 의심하면 그 둘을 봐라.

→ 그래서 부팅 태스크가 `sleep infinity` 를 **머신 수명 동안 붙잡는다**. 태스크는 의도적으로 `Running`
상태에 머문다(그래서 `ExecutionTimeLimit=PT0S`). 태스크가 `Ready` + 결과 `0` 이면 홀더가 죽은 것이고,
배포판은 곧 idle 로 내려간다.

## ⚠️ 저널의 `left-over process (sleep)` 경고는 **정상이다 — 고치지 마라**

매 틱 이런 줄이 찍힌다:

```
hmb-tunnel-heal.service: Found left-over process 375419 (sleep) in control group while starting unit. Ignoring.
hmb-tunnel-heal.service: Unit process 375419 (sleep) remains running after unit stopped.
```

정체는 워치독의 **자기 실행시한 감시자**다(`RUN_DEADLINE=420`). 2026-08-01 장애에서 `--once` 한 번이
58분 매달려 락을 쥔 채 후속 틱을 전부 굶겼고, 그 처방으로 "어디서 매달리든 420초 안에 스스로 죽는다"가
들어갔다. 감시자는 서브셸이고 `trap EXIT` 이 서브셸을 죽이지만 그 안의 `sleep` 은 고아로 남아 제 수명을
채우고 끝난다 — **틱 60초 / 수명 420초라 정상상태 7개로 유한**하고 스스로 사라진다(실측 2026-08-12: 7개).

⚠️ 이 경고를 `KillMode=control-group`(기본값)으로 되돌려 없애면 **치유가 방금 띄운 cloudflared 를
systemd 가 같이 회수한다** → 매 틱 새 터널을 만드는 스래시 루프. 맥에서 실제로 그랬다.
**노이즈를 없애려다 자가치유를 없애는 교환이다.**

## 설치 순서

```bash
# ① Windows 쪽 (랩탑에서 1회) — WSL 을 부팅 때 깨운다
powershell -NoProfile -ExecutionPolicy Bypass -File infra\laptop\install-windows-boot-task.ps1

# ② WSL 안 — 백엔드 스택 (AC1)
bash infra/laptop/install-stack-systemd.sh

# ③ WSL 안 — 워치독 (AC2~AC4)
bash infra/laptop/install-heal-systemd.sh
```

전제:
- `/etc/wsl.conf` 에 `[boot] systemd=true` (⚠️ 이 랩탑에서 **`wsl --shutdown` 금지** — `LxssManager` 가
  `STOP_PENDING` 으로 물린다. `wsl --terminate Ubuntu` 또는 재부팅).
- `~/.config/hmb/deploy.env` (CF 토큰) — **AC5 의 전제**. 없으면 `--selftest` 가 ✗ 로 잡는다.
- `cloudflared` · `node`/`npm` · `dig`(dnsutils) · `curl`.

## ⚠️ 랩탑의 자가치유는 **라이브 web 을 건드리면 안 된다**

치유의 마지막 단계는 새 터널 URL 을 web 에 전파하는 것이다. 랩탑이 그걸 **라이브 Pages 프로젝트**로
하면, 워치독이 도는 순간 테스터가 랩탑으로 넘어간다 = **이사가 계획 밖에서 일어난다**. 단계3.5 의
고정 제약은 "맥 무중단"이다.

그래서 랩탑에서는 전파 대상을 **별도 Pages 프로젝트**로 돌린다.

```bash
# ~/.local/state/hmb/heal.conf  (런타임 노브 — 워치독이 매 틱 다시 읽는다)
export PAGES_PROJECT=hmb-online-lab
```

### ⚠️ 이 한 줄을 **아무것도 강제하지 않던 것**이 AC5 반려 사유였다 (패널 렌즈②)

초판은 이게 전부였다 — 설치기가 이 파일을 **만들지 않고**(README 가 사람에게 부탁만),
`--selftest` 가 **보지 않고**, `publish-backend-url.sh:26` 의 기본값은 **라이브**(`hmb-online`)이며,
워치독은 `PAGES_PROJECT` 를 **env 상속**으로만 넘겼다(= `export` 한 글자에 안전이 걸려 있었다).
그래서 세 경로가 전부 **조용한 라이브 배포**로 끝나고 AC1~AC4 는 그걸 못 잡는다:
① 설치 직후 콜드 스타트(파일 없음) ② 파일 삭제 ③ `export` 누락.

지금은 **세 겹**이다:

| 층 | 어디 | 무엇을 막나 |
|---|---|---|
| 생성 | `install-heal-systemd.sh` — 없으면 `export PAGES_PROJECT=hmb-online-lab` 로 **만든다**(있으면 덮어쓰지 않는다) | ① 콜드 스타트 |
| 검사 | `tunnel-heal.sh --selftest` — 파일 존재 · `export` 선언 · `PAGES_PROJECT ≠ hmb-online` 을 검사하고 어긋나면 **rc≠0**. 설치기는 이 점검을 **타이머 기동 전**에 돌려 ✗ 면 `enable --now` 를 하지 않고 실패로 끝난다 | ①② + 오설정 |
| 전달 | `tunnel-heal.sh:publish_verified` — 자식(`publish-backend-url.sh`)에 `PAGES_PROJECT` 를 **명시 전달**(`env PAGES_PROJECT=…`) | ③ `export` 누락 |

⚠️ 전달 층은 **값이 없을 때의 동작을 바꾸지 않는다** — 없으면 종전대로 `publish-backend-url.sh` 의
기본값 결정에 맡긴다. 여기에 랩탑 기본값을 하드코딩하면 컷오버가 *코드 변경*이 되기 때문이다.

### 컷오버(단계4) — 게이트가 컷오버를 막지 않는다

컷오버는 "라이브로 내보내는 것이 정답"이 되는 시점이다. 그래서 게이트에 **명시 옵트아웃**이 있다:

```bash
rm ~/.local/state/hmb/heal.conf                                   # 또는 그 한 줄만 삭제
HMB_ALLOW_LIVE=1 bash infra/laptop/install-heal-systemd.sh        # 설치기: heal.conf 를 만들지 않는다
HMB_ALLOW_LIVE=1 ~/.local/bin/hmb-tunnel-heal.sh --selftest       # 점검: 게이트 우회(출력에 명시된다)
```

옵트아웃 **없이** 라이브를 겨누고 있으면 `--selftest` 는 ✗ 다. 우회했을 때는 조용히 넘어가지 않고
`! 전파 대상 게이트 우회 (HMB_ALLOW_LIVE=1) — 대상 = hmb-online (라이브 허용 모드)` 를 찍는다.

⚠️ 맥(라이브를 겨누는 것이 정상인 쪽)에서 `infra/tunnel-heal.sh --selftest` 를 수동으로 돌리면
같은 이유로 ✗ 가 난다 → `HMB_ALLOW_LIVE=1` 을 붙여서 돌린다. 맥의 **워치독 동작 자체는 무변경**이다
(게이트는 `--selftest` 에만 있고 `--once`/`--check` 경로엔 없다).

## ⚠️ `WorkingDirectory` 가 사라지면 워치독은 **한 틱도 못 돈다** (2026-08-13 실측, AC5 반복 회차4)

`.service` 의 `ExecStartPre=-/bin/mkdir -p $WORKDIR` 는 "작업 디렉토리가 청소돼도 자가복구가 죽지
않게" 넣은 것인데, **그 자체로는 동작하지 않았다** — systemd 는 `WorkingDirectory` 를 `ExecStartPre`
를 포함한 **모든 Exec 줄에** 적용하므로, 디렉토리가 없으면 되살리는 mkdir 이 먼저 CHDIR 에서 죽는다.

AC5 반복 재현 회차4 에서 workdir 을 지우고 터널을 죽였더니 실제로 이렇게 됐다:

```
Failed at step CHDIR spawning /root/.local/bin/hmb-tunnel-heal.sh: No such file or directory
hmb-tunnel-heal.service: Main process exited, code=exited, status=200/CHDIR
```

터널은 죽은 채였고 워치독은 **사람이 `mkdir` 할 때까지 단 한 틱도 돌지 못했다**(실측 135초).
타이머는 그동안 계속 `active` 로 보인다 — 2026-08-12 의 `/tmp` 청소 사고와 **같은 실패 모양**이고,
그때 넣은 처방이 실은 발화하지 않았다는 뜻이다.

→ `WorkingDirectory=-$WORKDIR`(선행 `-` = chdir 실패 무시). 그러면 `ExecStartPre` 가 디렉토리를
되살리고 다음 Exec 줄의 chdir 이 성공한다. 전파는 `publish-backend-url.sh` 가 자기 workdir 로 다시
`cd` 하므로 cwd 에 의존하지 않는다.

## ⚠️ 랩탑에 닿는 경로가 **하나뿐**이었다 — 그게 끊겨 12시간 넘게 아무도 못 들어갔다 (2026-08-13)

랩탑은 멀쩡했다. 덮인 채로 6시간짜리 배치를 완주했고(R9 치유 `09:07:50 KST`) 터널은 계속
`401 · 0.107s` 로 답했다. 죽은 것은 **역방향 ssh 포워드 하나**다. 그런데 그 하나가 유일 경로라
증빙 로그(`/opt/hmb/evidence/…`) 회수도, 어떤 원격 조치도 전부 막혔다.

정체는 스케줄 작업 `HMB-ReverseTunnel` 의 트리거가 **AtStartup 하나뿐**이었다는 것이다 —
*재부팅하면 복구*지 *끊기면 복구*가 아니다. 그리고 이 작업은 **리포에 없었다**(손으로 만든 것).
버전관리 밖이라 개선 대상으로 보이지도 않았다.

> ### ⚠️ 위 문단의 진단은 **틀렸다** (2026-08-18 정정, 실측)
>
> 트리거가 AtStartup 하나인 것은 맞다. 그러나 **"그래서 끊겨도 아무도 다시 걸지 않았다"는 거짓**이다.
> 그 작업이 실행하는 본체 `C:\ProgramData\hmb\tunnel.ps1` 을 그때 **아무도 읽지 않았다** — 리포 밖에
> 있었기 때문이다. 이번에 read-only 로 회수해 보니 그 안에는 **이미 재다이얼 루프가 있다**:
> `while($true){ ssh -R 2223:localhost:22 ...; sleep 15 }`. AtStartup 은 그 루프를 *시작*할 뿐이고,
> 끊김을 견디는 것은 루프다. 전문 = **`legacy-tunnel.ps1`**(회수한 원문 그대로).
>
> **그래서 cloudflared 비대칭 논증도 근거를 잃는다** — "cloudflared 는 자기 재접속이 있고 맨 `ssh -R`
> 은 없다"가 전제였는데, 여기의 `ssh -R` 은 맨 것이 아니라 **루프에 감겨 있었다**.
>
> 실제 취약점은 재다이얼 유무가 아니라 그 루프의 **구조적 천장 둘**이다(실측):
>
> | 취약점 | 왜 재시도로 못 넘나 |
> |---|---|
> | **다이얼 대상이 LAN 전용** (`peter.park@BH-L175.local` · `172.30.1.33`) | 랩탑이 이 LAN 을 떠나면 **몇 번을 걸어도** 닿을 곳이 없다 |
> | **포트 2223 고정 + `ExitOnForwardFailure=yes`** | 맥에 좀비 홀더가 끼면 **모든** 재다이얼이 거절된다. 루프는 바쁘게 도는데 성과가 0 이고, 밖에서는 건강해 보인다 |
>
> ⚠️ 그날 밤 둘 중 무엇이 발화했는지는 **규명되지 않았다**. 규명된 것처럼 적지 마라 — 그렇게 적으면
> 다음 사람이 "재다이얼을 넣었으니 해결"로 읽고 LAN 천장을 그대로 남긴다.

### 처방 ① 재다이얼 — `install-reverse-tunnel-task.ps1`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File infra\laptop\install-reverse-tunnel-task.ps1 -Status
powershell -NoProfile -ExecutionPolicy Bypass -File infra\laptop\install-reverse-tunnel-task.ps1
```

- **끊기면 다시 건다** — `ssh -R` 을 무한 루프로 감싸고 지수 백오프(5s→300s), 오래 붙어 있던
  세션이 끊긴 경우엔 백오프를 리셋한다(정상 재접속과 즉시 실패를 구분).
- **루프가 죽어도 되살아난다** — AtStartup 에 더해 5분 반복 트리거(`MultipleInstances=IgnoreNew`
  라 정상 가동 중엔 아무 일도 안 일어난다). 트리거 하나에 의존하지 않는다.
- ⚠️ **다이얼 파라미터를 지어내지 않는다** — 설치 시 기존 작업의 `Actions` 를 **읽어서 그대로
  재사용**하고 화면에 찍는다. 버전관리 밖에 있던 그 명령이 그 자리에서 기록으로 회수된다.
- **포트를 번갈아 시도한다**(2223↔2222) — 아래 좀비 홀더 문제 때문.
- ⚠️ **WSL 안이 아니라 Windows 쪽에 둔다.** 이 디렉토리의 나머지는 전부 systemd 소유지만
  (`Restart=always` 가 더 쌌을 것이다), 이 연결은 **구조선**이다. WSL 배포판 사망은 여기서
  실측된 고장 모드고(1h39m), **구조하려는 대상과 같이 죽는 구조선은 구조선이 아니다.**

### 처방 ② 맥 쪽 끝 — `check-reverse-tunnel-mac.sh`

재다이얼을 넣으면 **다음 실패 모양이 맥으로 옮겨간다**: 네트워크가 툭 끊긴 세션을 맥 sshd 는
수 시간 모르고, 그동안 그 포트를 **좀비가 쥐고 있어** 랩탑의 정상적인 재다이얼이 매번
`ExitOnForwardFailure` 로 거절된다 = 재다이얼을 넣고도 접근이 0 이 될 수 있다.

```bash
bash infra/laptop/check-reverse-tunnel-mac.sh          # 점검(부작용 0)
bash infra/laptop/check-reverse-tunnel-mac.sh --reap   # 좀비 홀더만 PID 로 정리
```

- **리스너 존재 ≠ 살아있음** — 실제로 `ssh … true` 를 통과시켜 본다(좀비는 포트를 쥔 채 못 넘긴다).
- 근본 처방(사람 1회, sudo)은 맥 `sshd_config` 의 `ClientAliveInterval` 이고, 스크립트가 그
  명령을 찍어 준다.
- ⚠️ **리스닝 판정에 `lsof` 를 쓰지 마라** — 일반 사용자의 `lsof` 는 **root 소유 소켓을 못 본다**.
  초판이 그래서 맥 sshd 를 "✗ 없음" 으로 오판했다(같은 순간 `nc -z` 는 열려 있었다).
  소유자와 무관한 `netstat` 로 판정한다. 종료는 **PID 로만**(`pkill -f` 금지, 전역 규칙).

### 처방 ③ 두 번째 경로 — tailscale ⓑ

①②는 같은 경로를 튼튼하게 만들 뿐이다. **경로가 하나면 여전히 하나다.**

| 제약 | 결과 |
|---|---|
| 맥은 **회사 tailnet** 유지 | 시스템 `tailscaled` **무접촉** |
| 랩탑은 회사 tailnet 에 **올리면 안 됨** | 개인 tailnet 에만 조인 |
| 노드당 활성 tailnet 은 **1개**(프로필은 동시가 아니라 전환) | → 맥에 **두 번째 데몬** |

그래서 ⓑ = 맥에 `--tun=userspace-networking` 데몬을 하나 더 띄우고(커널 인터페이스·라우팅에
손대지 않는다) SOCKS5 로만 내보내 ssh `ProxyCommand` 가 탄다. 랩탑이 **회사 tailnet 에 아예
안 올라가는 것**이 정책이 아니라 **위상**으로 보장된다. (기각한 ⓐ 노드 공유 = 회사 ACL +
계정 아이덴티티 의존. 맥 계정이 `debug.yoon@gmail.com` 이라 같은 계정으로 개인 tailnet 을
만들면 자기 자신에게 공유가 안 된다.)

```bash
bash infra/laptop/install-tailscale-b-mac.sh            # 맥: 데몬 설치(로그아웃 상태로 대기)
bash infra/laptop/install-tailscale-b-mac.sh --login    # 맥: hero 가 **개인 계정**으로 로그인
# 랩탑:
powershell -NoProfile -ExecutionPolicy Bypass -File infra\laptop\join-personal-tailnet.ps1
```

- ⚠️ **auth key 는 일회용·짧은 만료**. 이슈·로그·커밋 어디에도 값을 남기지 않는다. 랩탑 스크립트는
  키를 화면에 안 찍고 디스크에 안 남긴다(SecureString → ACL 제한 임시파일 → 즉시 덮어쓰고 삭제).
- ⚠️ **어느 tailnet 에 붙었는지 사후 검사한다** — 어느 tailnet 인지는 **키가 정한다**. 회사
  tailnet 으로 붙으면 스크립트가 즉시 `logout` 한다.
- ⚠️ **기존 `hmb-laptop`(역방향 포워드) ssh 항목은 남긴다** — 경로가 둘이어야 이중화다.
- ⚠️ **검증은 첫 경로를 일부러 끊고 한다.** 첫 경로가 살아 있는 동안만 되는 두 번째 경로는
  이중화가 아니다.

### 착지 상태 (2026-08-18 실측)

| 항목 | 값 |
|---|---|
| 랩탑 tailscale | **이미 조인돼 있었다** — `hmb-laptop 100.65.56.104 · ehgus0114@ · windows` |
| 맥 ⓑ 데몬 | `bh-l175-personal 100.84.111.73` · tailnet `ehgus0114@gmail.com` · BackendState **Running** |
| 회사 tailnet | 무영향 — `tail3401b2` 정상 · **랩탑 노드 0건** · `100.64/10` 라우트는 `utun0`(회사) 그대로 |
| userspace 유지 | 개인 IP 가 **어느 인터페이스에도 바인드되지 않음**(0건) |
| ⓑ 경로 통과 | `ssh hmb-laptop-ts 'exit 0'` **OK** · peer `active; direct 172.30.1.42:41641` · ping 7ms |

⚠️ **auth key 는 결국 필요 없었다** — 랩탑이 이미 개인 tailnet 에 있어서 맥 쪽 브라우저 로그인
한 번으로 닫혔다. `join-personal-tailnet.ps1` 은 **새 기계용**으로 남긴다.

⚠️ **`utun 개수 불변(7)` 은 불변식이 아니다** — 로그인 후 7 → 9 가 됐지만 새 utun 들은 IP 도
라우트도 없다(맥OS 가 수시로 만든다). 검증해야 할 성질은 개수가 아니라 **①개인 IP 가 어느
인터페이스에도 바인드되지 않을 것 ②`100.64/10` 이 계속 `utun0`(회사) 로 갈 것** 두 가지다.

⚠️ **아직 안 한 검증**: 첫 경로를 실제로 끊고 ⓑ 로만 들어가 보기. 지금 증거는 **구조적 독립성**
(`path1 = 127.0.0.1:2223` 역방향 포워드 ↔ `path2 = tailscale peer :22 via SOCKS`)까지다.
그리고 오늘은 ⓑ 도 **같은 LAN 직결**로 붙었다 — 오프-LAN 에서 DERP 로 넘어가는 것은 설계상
참이지만 **실측되지 않았다**. 랩탑을 다른 네트워크로 옮길 일이 생기면 그때가 그 검증이다.

## ⚠️ 자가복구가 **자기 고장에 무음**인 부류 — 맥에서도 같은 것이 터졌다 (#497)

랩탑의 `WorkingDirectory` 사고(위 §)와 **같은 부류**가 2026-08-13 맥에서 발화했다. launchd plist 의
`WorkingDirectory=/tmp/hmb-wrangler-work` 가 재부팅으로 사라져 launchd 가 **프로그램을 실행조차
하지 않고** `EX_CONFIG(78)` 로 끝냈다 — 스크립트가 안 돌았으니 `StandardOutPath`·`StandardErrorPath`·
`tunnel-heal.log` 가 **전부 무음**이었고, 그 33분간 테스터 접속이 끊긴 채 자가복구가 발화하지 않았다.

**교훈은 systemd 쪽 `WorkingDirectory=-` 처방과 같다**: 스케줄러에 **사라질 수 있는 기동 전제**를
주지 마라. 맥 쪽 처방은 (1) plist 에서 `WorkingDirectory` 를 **제거**(소비자인 `publish-backend-url.sh`
가 매 실행 `mkdir -p` + `cd` 한다 — 애초에 없어도 되던 키였다) (2) 경로 기본값을 `/tmp` 밖으로
(3) **심박**(`~/.local/state/hmb/last-tick`)을 매 틱 무조건 남겨 "정상이라 조용" 과 "죽어서 조용" 을
가른다. 대조군 실측 = `evidence/497/workdir-removal-proof.log`.

## 알려진 이식 결함 (AC 경로 밖, 미수정)

- `infra/deploy-pages.sh:67` 이 BSD 전용 `sed -i ''` 를 쓴다 → **리눅스에서 실패**한다.
  AC1~AC5 의 경로가 아니어서(전파는 `deploy-web.sh`) 이번 스코프에서는 건드리지 않는다.
  랩탑에서 Pages 프로젝트를 새로 만들거나 CORS 오리진을 바꿀 때 처음 물린다.

## 이사 리허설 — 실측으로 드러난 함정 4개 (2026-08-19, #489)

랩탑을 **라이브 데이터로 실제로 띄워** 봤다. 결과: 부팅은 되는데 **그대로 컷오버했으면 4곳이 깨졌다.**
전부 "부팅 성공"이라는 신호 뒤에 숨어 있어서, 리허설 없이는 컷오버 당일에 만났을 것들이다.

| # | 함정 | 어떻게 드러났나 | 처방 |
|---|---|---|---|
| 1 | **스키마가 코드보다 앞선다** | Flyway `Schema "main" has a version (44) that is newer than the latest available migration (41)` — 경고만 내고 **부팅은 된다** | 랩탑 리포를 **라이브 java SHA `d76c6c68`**(v3.29)로 고정 + 이미지 재빌드 → `44 migrations validated` |
| 2 | **`.env` 에 admin 짝이 없다** | `admin bootstrap disabled (hmb.admin.nickname unset) — admins=0 (revoked=1)` — **기존 admin 을 revoke 까지 했다** | 이송 팩 복원(P0-5) → `admins=1 (hmbadmin)`. `check-env-contract.sh` = 오류 0 |
| 3 | **web 빌드가 낡았다** | 랩탑 `dist-current` = `git 21b9562`(8/12) vs 라이브 `c938c6d7`(8/14). 컷오버 발행이 **web 을 되돌린다** | 이송 팩이 `dist-current` 를 실어 온다 — 복원 후 meta 가 라이브 값인지 **눈으로 확인** |
| 4 | **`unpack-move.sh` 가 `~/.local/state/hmb` 를 통째로 교체한다** | 그 안의 `heal.conf`(`PAGES_PROJECT=hmb-online-lab`)가 지워지면 기본값이 **라이브** → 랩탑 워치독이 컷오버 **전에** 라이브 `config.json` 을 자기 주소로 덮는다 | **순서로 막는다**: 워치독 정지 → unpack → `heal.conf` 복원 → 워치독 재기동. selftest 가 `전파 대상 = 'hmb-online-lab'` 을 확인 |

⚠️ **4번이 가장 위험하다** — 나머지 셋은 랩탑만 망가뜨리지만 4번은 **라이브 유저를 빈/낡은 스택으로 보낸다.**
그리고 `unpack` 은 그 파일을 지웠다고 말해주지 않는다(백업은 남긴다: `~/.local/state/hmb/move/pre-unpack/`).

### 리허설 착지 상태

```
DB       라이브 = 랩탑 (226 users · 131 matches · 동일 max id) · sha256 양측 일치
Flyway   44 migrations validated · up to date · 경고 없음
admin    admins=1 (hmbadmin)
스모크   18080 무토큰 401 / 토큰 200 JSON · 18790 200 · CORS https://hmb-online.pages.dev
워치독   active · 전파 대상 = hmb-online-lab (라이브 아님, selftest 12/12)
```

## 내부 포트를 tailscale 로 뚫는 법 — `serve`, netsh 아님

WSL2 스택은 **VM 안**(172.27.x)에서 듣는다. 윈도우는 WSL 의 localhost 포워딩으로 `127.0.0.1:18080` 에
닿지만 그건 **루프백뿐**이고 tailscale 인터페이스(`100.65.56.104`)에는 아무도 바인드하지 않는다 →
tailnet 피어는 윈도우까지 와서 리스너를 못 찾는다.

```bash
# 랩탑에서 1회. tailnet 안에서만 열린다(funnel 아님).
tailscale serve --bg --yes --tcp 18080 tcp://127.0.0.1:18080
tailscale serve --bg --yes --tcp 18790 tcp://127.0.0.1:18790
tailscale serve status          # "(tailnet only)" 확인
```

- **`netsh interface portproxy` 를 쓰지 마라** — 포트를 상시 열고 방화벽 규칙이 따라붙는다.
  `serve` 는 tailscale 이 tailnet 안에서만 종단하고 방화벽·라우팅에 손대지 않는다.
- **WSL mirrored 모드도 아니다** — `.wslconfig` 변경 + **WSL 재시작**(= 스택 중단)이 필요하다.
- 루프백으로 넘기므로 **WSL IP 가 바뀌어도 안 깨진다**(WSL IP 를 박는 방식의 고질병).

## ⚠️ 링크 속도 — 정지 창을 여기에 걸지 마라

| 측정 | 값 |
|---|---|
| 맥 ↔ 랩탑 실효 처리량 | **0.9 ~ 2.2 MB/s** (측정 시점마다 변동) |
| 라이브 DB | **737 MB** |
| 단순 전송 시간 | **6 ~ 13분** — 정지 창 예산을 통째로 먹는다 |

병목은 경로가 아니라 **맥 Wi-Fi** 였다(측정 당시 2.4GHz 채널8/20MHz). tailscale ⓑ 와 역방향 ssh 가
**0.93 vs 1.25 MB/s** 로 사실상 같았다.

⚠️ **"역방향이 10배 빠르다(12MB/s)"는 측정 아티팩트였다** — 원격 명령을 PowerShell 이 파싱하면서
`>` 를 리다이렉션으로 먹어 **데이터가 실제로 건너가지 않았고** `dd` 가 일찍 끝난 것이다.
원격 측정은 **받은 바이트 수를 확인**하지 않으면 믿지 마라.

**처방 = 정지 창 밖에서 warm 복사 + 컷오버엔 delta 만.**

```bash
# 평소(서비스 살아있는 채로): 전체를 미리 보낸다
rsync --rsync-path="wsl -e rsync" -a --inplace --partial ~/hmb-move-db/ hmb-laptop-ts:/root/hmb-move-db/
# 컷오버: 같은 명령 = 바뀐 블록만 간다
```

`--rsync-path="wsl -e rsync"` 가 열쇠다 — 랩탑의 ssh 기본 셸은 **PowerShell** 이라 `rsync` 가 없다.

## AI 실행기 인증 — `setup-token` 은 **자격 파일을 만들지 않는다** (2026-08-19, #489)

랩탑은 모드 A(호스트 구독 CLI)로 간다. `~/.claude` **이송은 안 한다** — 3.9GB 인데다 "옮겨도 새
머신에서 세션이 산다"는 보장이 런북 §④ 미해결이었다. 대신 랩탑에서 새로 로그인한다.

```bash
# 랩탑 WSL(root)에서
claude setup-token          # 브라우저 URL → 승인 → 코드 붙여넣기
```

⚠️ **`/login` 과 다르다.** `setup-token` 은 `~/.claude/.credentials.json` 을 **만들지 않고**
토큰을 화면에 **한 번만** 뿌리고 끝난다. 그래서 성공 직후에도 `claude -p` 는 여전히
`Not logged in` 이라고 답한다 — 실패로 오해하기 쉽다. 토큰을 직접 갈무리해야 한다.

```bash
umask 077
printf 'export CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$TOK" > /root/.config/hmb/claude.env
chmod 600 /root/.config/hmb/claude.env
```

- 유효기간 **1년**. 검정 = `. /root/.config/hmb/claude.env && claude -p "reply with exactly: PONG"`.
- ⚠️ **토큰이 찍힌 터미널 로그를 지워라**(`shred -u`). 그 파일 한 줄이 구독 접근권 전체다.
- ⚠️ **`infra/.env` 에 넣지 마라** — `check-env-contract.sh` 가 "계약 밖 키"로 잡아 **오류 0 이
  깨진다**. 별도 파일로 두고 실행기 기동선에서 `source` 한다(런북 P3-20 을 이렇게 읽는다):

```bash
cd "$(git rev-parse --show-toplevel)"
source infra/.env
source /root/.config/hmb/claude.env          # ← 추가되는 한 줄
JAVA_URL=http://localhost:18080 SERVANT_TOKEN="$SERVANT_TOKEN" \
  AI_EXECUTOR=claude-code AI_MODEL=sonnet AI_CONCURRENCY=1 AI_JOB_TIMEOUT_MS=240000 \
  nohup npm run executor -w @hmb/server > /tmp/hmb-executor.log 2>&1 &
```

⚠️ `ANTHROPIC_API_KEY` 는 넣지 마라 — 구독이 아니라 **종량 과금**이 된다(런북 P3-20 경고).

### 원격에서 대화형 로그인을 돌리는 법 (tmux 가 조용히 죽는다)

`ssh … wsl -e bash -lc "tmux new-session -d …"` 로 띄운 tmux 는 **그 ssh 세션이 끝나면 같이
죽는다**(WSL 이 프로세스 그룹을 정리한다). 실제로 URL 을 받아 hero 가 브라우저를 다녀오는 사이
세션이 사라져 **코드를 넣을 대상이 없어졌다**. `setsid` + 전용 소켓이면 살아남는다:

```bash
setsid tmux -S /tmp/hmb.sock new-session -d -s cl -x 400 -y 50 \
  'claude setup-token 2>&1 | tee /root/claude-login.log' </dev/null >/dev/null 2>&1
# 반드시 **다른 ssh 세션에서** 생존을 확인한 뒤 URL 을 사람에게 준다
ssh hmb-laptop-ts wsl -e tmux -S /tmp/hmb.sock ls
```

⚠️ **URL 은 폭 넓은 pane 에서 뽑아라**(`-x 400`). 기본 폭이면 마지막 글자가 줄바꿈에 잘려
`state` 가 한 글자 모자란 URL 이 나간다(실제로 겪었다 — 붙여 복원해야 했다).

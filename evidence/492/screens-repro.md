# #492 화면 증빙 재현 레시피 — 제3자용

패널 5R 재현성 렌즈의 지적을 메운다: *"clone → checkout 하면 스크린샷이 없다."*

## 왜 PNG 를 커밋하지 않는가

`apps/web/.gitignore:47-48` 이 `.p492/` 를 **의도적으로** 제외한다(이 리포의 e2e 캡처 관례).
바이너리 대신 **그것을 만드는 스펙을 커밋**한다 — PNG 는 코드에서 되만들 수 있지만
코드는 PNG 에서 되만들 수 없다. 재현의 단위는 산출물이 아니라 **생성기**다.

생성기(트래킹됨): `apps/web/e2e/p492-event-board-mock.spec.ts`

## 재생성 명령

```bash
cd apps/web
npx playwright test e2e/p492-event-board-mock.spec.ts
# 산출물 → apps/web/.p492/
```

백엔드가 필요 없다 — 스펙이 `/api/**` 를 전부 목킹한다(오리진 앵커 글롭).
`mock-contract.json` 이 그 목 응답의 덤프라, 화면이 무엇을 받아 무엇을 그렸는지가 자기완결적이다.

## 이 커밋 시점 산출물의 지문 (sha256)

```
ecac7f6d214505e64a2659fe75217ef61b4015f6eda843bf77600e12c8dad742  mock-contract.json
08479fd25fc45012a02eebc072c0ce0f3eb17304bc9594cf05d97553639010a2  p492-desktop.png
723871a48b106e4a5cb9a6c1b57117bff3adba027d4d9bc36f1afec02c84e896  p492-forbidden.png
2d78fa1d274bba2223352e420e5b84766e111aa61d9faec2ef31260bc4221c45  p492-mobile-390.png
```

⚠️ PNG 해시는 **렌더 환경(폰트·브라우저 빌드)에 따라 달라진다** — 일치 여부가 판정 기준이 아니다.
판정 기준은 `mock-contract.json` 쪽이다(순수 데이터라 같은 스펙이면 같은 값이어야 한다).

| 파일 | 무엇을 보는가 |
|---|---|
| `p492-desktop.png` | `/event-board` 데스크탑 — 퍼널·타입별 건수·최근 스트림 |
| `p492-mobile-390.png` | 390px 폭(실제 폰 뷰포트) — 가로 스크롤 0 |
| `p492-forbidden.png` | **비-admin 계정의 접근 차단 화면** (라우트 가드) |

## AC7 라이브 트레이스는 왜 명령이 아니라 트레이스인가

`ac7-live-playthrough.txt` 는 일회용 계정(`ac7live6376891`)으로 **한 번 일어난 사건**의 기록이다.
같은 요청을 다시 쏘면 같은 결과가 나오지 않는다(가입은 1회 · 뽑기는 소모 · 리그 시즌은 멱등).
그래서 그 파일은 재실행 스크립트가 아니라 **경로 · HTTP 코드 · 응답 핵심 필드**를 남긴다.
제3자가 같은 성질을 재현하려면 **결정론 경로**를 쓴다 — 그게 `server-java` 계약 쪽이고
(`BusinessEventFlowTest` 가 실 HTTP 로 7종을 태운다) 그 실행은 `evidence/492/server-java-gate-cold.txt` 에 있다.

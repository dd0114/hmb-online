# 배포 기록 (deploy-log) — append-only

> **정책(P4-D5 / #171)**: 배포할 때마다 이 파일 맨 위(최신순)에 항목을 append 하고 커밋한다.
> "언제 무슨 버전이 배포됐나"의 SoT. AI·사람이 repo에서 바로 조회. `infra/version-manifest.sh` 산출을 여기에 옮겨 적는다.
> 항목 형식: 배포시각(UTC) · git SHA/브랜치 · 모듈별 버전(engine/server-java/web/servants) · 이미지 다이제스트 · tunnel/URL · 배포자 · 결과/비고.

---

## 2026-07-21T17:16Z — web 스킨 재배포 (main 정합)
- **git**: `bfb3b16` (main) — 직후 `8adfaab`(W4 문서)까지 포함 main
- **모듈 버전**: engine `@0.16.0` · server-java `0.1.0` · web `0.0.0`(main 빌드, 스킨 #145·트레이드·matchui 포함) · servants `0.0.1`
- **이미지**: `hmb/server-java:p3` `sha256:bc39c33d…` · `hmb/servants:p3` `sha256:bc249f7e…`
- **tunnel/URL**: web=Cloudflare Pages **https://hmb-online.pages.dev** (고정) · backend=quick tunnel `insured-stakeholders-laid-silicon.trycloudflare.com`
- **배포자**: hero(토큰) + hmb:p3dep(실행)
- **결과**: ✅ GREEN. 스킨 렌더 확인, 로그인→왕복 200, DB 볼륨(hmb-p3-db 16.7MB) 보존.
- **비고**: 초기 배포(2026-07-21T15:53, `8aa1da0` p3dep/base)는 스킨 누락 → main 재빌드로 복구. **미포함**: qa `#147` 엔진 시야(engine/base 미머지, hero sign-off 대기) → 이 배포 엔진은 `@0.16.0`.

---
<!-- 새 배포는 이 줄 위에 최신순으로 추가 -->

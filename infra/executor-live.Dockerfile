# AI 실행기 모드 B 전용 이미지 — 서번트 이미지 + claude CLI.
#
# 빌드 컨텍스트 = 리포 루트 (docker-compose.ai-live.yml 이 context: .. 로 지정).
#
# packages/server/Dockerfile 은 다른 도메인 소유이므로 수정하지 않고 그 위에 얹는다.
# (executor 는 `spawn("claude", ...)` 로 PATH 의 claude 를 부른다 —
#  packages/server/src/executor/executors/claude-code.ts)

# ⚠️ 선행 조건: `hmb/servants:p3` 는 **로컬 빌드 태그**다(레지스트리에 없음).
#    이 이미지를 빌드하기 전에 반드시 먼저:
#        docker compose build runner
#    compose 는 서비스를 **동시에** 빌드하므로 `up --build` 만으로는 경합이 난다
#    (executor 의 FROM 이 runner 의 태그 생성보다 먼저 평가될 수 있다).
#    deploy.md §4 모드 B 절차가 이 순서를 명시한다.
FROM hmb/servants:p3

USER root
# CLI 버전 핀 = 재현성. 갱신 시 이 버전만 올린다. (@latest 는 재현성을 깬다)
RUN npm install -g @anthropic-ai/claude-code@2.1.215 \
 && claude --version

# node 이미지의 기본 비루트 유저. HOME=/home/node 로 ~/.claude 마운트를 받는다.
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node
USER node

CMD ["npm", "run", "executor", "--workspace=@hmb/server"]

# @hmb/server 실행 환경 — 게임외 시스템은 버전 핀 이미지로 재현성 확보.
# 베이스 이미지·lockfile(npm ci) 로 "특정 버전" 고정. (엔진·shared 는 TS 소스로 소비 → tsx 런타임)
FROM node:20.19.6-bookworm-slim
WORKDIR /app

# 1) 매니페스트만 먼저 복사 → 의존성 레이어 캐시.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci --omit=dev

# 2) 소스 복사(엔진·shared·server 는 TS 소스).
COPY packages/shared packages/shared
COPY packages/engine packages/engine
COPY packages/server packages/server

ENV NODE_ENV=production
EXPOSE 8787
CMD ["npm", "start", "--workspace", "@hmb/server"]

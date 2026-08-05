# hmb-server (Spring Boot 3.3 / Java 21) — 멀티스테이지.
#
# ⚠️ 빌드 컨텍스트 = **리포 루트** (server-java/ 아님).
#    server-java 는 부팅 시 `../data/players/*.json` 을 읽으므로 data/ 가 컨텍스트에 있어야 한다.
#    → docker build -f server-java/Dockerfile .
#    (infra/docker-compose.yml 이 context: .. 로 이 규약을 지킨다)
#
# 버전 핀 = 재현성. Boot 3.3.4 / Gradle 8.14(wrapper) / JDK 21 — server-java/build.gradle.kts 와 일치.

# ---------- stage 1: build ----------
FROM eclipse-temurin:21-jdk-jammy AS build
WORKDIR /src

# 1) 래퍼·빌드스크립트만 먼저 → 의존성 해석 레이어 캐시.
#    (소스만 바뀌면 이 레이어는 재사용된다)
COPY server-java/gradlew                server-java/gradlew
COPY server-java/gradle                 server-java/gradle
COPY server-java/build.gradle.kts       server-java/build.gradle.kts
COPY server-java/settings.gradle.kts    server-java/settings.gradle.kts
WORKDIR /src/server-java
# `|| true` 로 실패해도 진행한다(캐시 워밍일 뿐). 다만 출력은 버리지 않는다 —
# 네트워크 문제로 래퍼 다운로드가 깨졌을 때 여기 로그가 없으면 아래 bootJar 실패가 미궁이 된다.
RUN chmod +x gradlew && ./gradlew --no-daemon dependencies || true

# 2) 소스 복사 후 bootJar.
#    -x test: 테스트는 별도 게이트(`./gradlew test`, server-java/CLAUDE.md)에서 돈다.
#    이미지 빌드가 테스트 실패로 막히면 배포 런북이 모듈 게이트를 중복 집행하게 된다.
#    ⚠️ dest 는 절대경로 — WORKDIR 가 /src/server-java 이므로 상대경로면 중첩된다(실제로 겪음).
COPY server-java/src /src/server-java/src
RUN ./gradlew --no-daemon bootJar -x test

# 산출 jar 를 버전 무관하게 고정 이름으로 normalize.
# build.gradle.kts 의 version 이 바뀌어도 이미지 빌드가 깨지지 않게 한다(파일명 하드코딩 금지).
# bootJar 는 `-plain.jar` 를 함께 만들므로 그것만 제외한다.
RUN set -eu; \
    jar="$(find build/libs -name '*.jar' ! -name '*-plain.jar' | head -n1)"; \
    test -n "$jar" || { echo "bootJar output not found" >&2; exit 1; }; \
    cp "$jar" /tmp/app.jar

# ---------- stage 2: runtime ----------
FROM eclipse-temurin:21-jre-jammy AS runtime

# curl = compose healthcheck 용(actuator 미탑재 → /internal/health 를 토큰헤더로 찌른다).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# 비루트 실행. DB 볼륨(/var/lib/hmb) 소유권을 넘겨야 SQLite 가 쓸 수 있다.
RUN useradd --system --uid 10001 --create-home --home-dir /home/hmb hmb

WORKDIR /app

# build 스테이지에서 이름을 고정해 둔 산출물(버전 무관).
COPY --from=build /tmp/app.jar /app/app.jar

# 부팅 시 임포트하는 시드 데이터(읽기전용). application.yml 기본값은 CWD 상대(`../data/...`)라
# 컨테이너에선 HMB_DATA_* 를 절대경로로 주입한다(아래 ENV).
COPY data/players /app/data/players

# SQLite 파일 위치. compose 가 named volume 을 여기에 마운트한다.
RUN mkdir -p /var/lib/hmb && chown -R hmb:hmb /var/lib/hmb /app

# ⚠️ 이 ENV 는 application.yml 의 hmb.data.* 를 **덮어쓴다**. 발행물 버전을 올릴 땐 두 곳을 같이
#    올려야 한다 — 한쪽만 올리면 배포에서 조용히 구파일이 로드된다(server-java/CLAUDE.md #209 경고).
#    2026-07-27 v8 배포 전 실제로 어긋나 있었다: yml=players.v2.3 인데 여기가 v2.1 이라 #207 신규
#    LEGEND 8종(P173~P180)이 프로덕션에 임포트되지 않는 상태였다.
#    🟢 이제 사람 기억이 아니라 계약이 막는다 — `DataVersionParityTest` 가 이 ENV 와 application.yml
#    의 `hmb.data.*-file` 을 파일명 단위로 대조한다(한쪽만 올리면 red).
ENV HMB_DB_PATH=/var/lib/hmb/hmb.db \
    HMB_DATA_PLAYERSFILE=/app/data/players/players.v2.7.json \
    HMB_DATA_ECONOMYFILE=/app/data/players/economy.v4.json \
    HMB_DATA_BOTSFILE=/app/data/players/bots.v4.json \
    HMB_DATA_LEAGUEFILE=/app/data/players/league.v2.json \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75.0"

USER hmb
EXPOSE 8080

# ⚠️ 시크릿(HMB_SERVANT_INTERNALTOKEN 등)은 이미지에 굽지 않는다 — compose env_file(.env)로만 주입.
ENTRYPOINT ["java", "-jar", "/app/app.jar"]

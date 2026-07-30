/**
 * OG Function E2E 용 **스텁 백엔드** (#299).
 *
 * `GET /api/notices/{id}` 만 흉내낸다 — 응답 코드 매핑은 실제 서버(#297)와 동일해야 한다:
 *   LIVE 200 / EXPIRED·OFF 410 / SCHEDULED·DELETED·없는 id 404.
 * ⚠️ 스텁이 서버보다 관대하면 계약이 거짓 green 이 된다(이 프로젝트가 #248 에서 당한 자리).
 *
 *   node infra/pages/e2e/stub-backend.mjs <port> [label]
 *
 * label 은 제목에 붙는다 — `/config.json` 을 갈아끼웠을 때 Function 이 **어느 백엔드를 읽었는지**
 * 응답만 보고 구분하기 위한 것이다(AC3 의 "요청 시각에 읽는다" 증명).
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] || 18991);
const label = process.argv[3] || "A";

/** 라이브 공지 — 본문 첫 이미지가 og:image 가 된다(마크다운 부분집합, 실제 운영 문안 형태). */
const LIVE = {
  id: "01J5LIVE0000000000000000AB",
  revision: 3,
  title: `[${label}] 경니시우스 합류 안내`,
  body: `![경니시우스](/notice/hero-kyeongnicius.webp)

**LEGEND** 등급 공격수. 최전방에서 버티고, 달리고, 동료를 살립니다.

- 등지고 받아 내주는 연계 — 최전방의 기준점
- 슈팅 90 · 태클 90 — 마무리도, 전방 압박도

지금 상점에서 만나보세요.`,
  startsAt: null,
  endsAt: null,
  priority: 10,
};

/** 본문에 이미지가 없는 공지 — og:image 폴백 경로를 태운다. */
const NOIMG = {
  id: "01J5NOIMG000000000000000CD",
  revision: 1,
  title: `[${label}] 정기 점검 안내 <필독> & "주의"`, // 이스케이프 계약용 특수문자
  body: "오늘 03:00~05:00 점검이 있습니다. 이용에 참고해 주세요.",
  startsAt: null,
  endsAt: null,
  priority: 0,
};

/**
 * **업로드 자산(V30, #309)을 본문에 쓴 공지** — #320 계약용.
 *
 * 정적 에셋(`/notice/…`, web 오리진)과 달리 업로드 이미지는 `/api/notices/assets/{id}` =
 * **백엔드 오리진**이다. web 오리진에 그 경로는 없고 SPA 폴백(200 text/html)이 나오므로,
 * og:image 를 web 오리진으로 절대화하면 **깨진 썸네일이 200 으로 위장**된다.
 * 이 픽스처가 그 자리를 잰다 — 두 경로가 **공존**해야 한다.
 */
const ASSET_IMAGE_ID = "01J5ASSET000000000000000GH";
const ASSET = {
  id: "01J5ASSETNOTICE00000000IJ",
  revision: 1,
  title: `[${label}] 오시야스 합류!`,
  body: `![오시야스](/api/notices/assets/${ASSET_IMAGE_ID})

**LEGEND** 등급 골키퍼. 마지막 순간에 골문 앞에 서 있는 선수입니다.

위치선정 **95**. 피지컬 **95**. 태클 **94**.`,
  startsAt: null,
  endsAt: null,
  priority: 10,
};

/** 1×1 webp. 바이트가 중요한 게 아니라 **백엔드가 실제로 이미지를 준다**는 사실이 계약이다. */
const ASSET_BYTES = Buffer.from(
  "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
  "base64",
);

const GONE_ID = "01J5GONE0000000000000000EF";

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  // 브라우저 실검증(AC4)에서 web 은 **다른 오리진**(pages dev)에서 이 스텁을 부른다 —
  // Authorization 헤더가 붙으므로 preflight 가 먼저 온다. 실서버(WEB_ORIGINS CORS)와 같은 자리.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,accept",
      "access-control-max-age": "600",
    });
    return res.end();
  }
  // 업로드 자산 서빙 — 실서버의 `GET /api/notices/assets/{id}`(공개, 무인증) 자리.
  const a = /^\/api\/notices\/assets\/([^/]+)$/.exec(url.pathname);
  if (a) {
    if (decodeURIComponent(a[1]) !== ASSET_IMAGE_ID) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ code: "NOT_FOUND", message: "자산을 찾을 수 없습니다." }));
    }
    res.writeHead(200, {
      "content-type": "image/webp",
      "content-length": ASSET_BYTES.length,
      "access-control-allow-origin": "*",
    });
    return res.end(ASSET_BYTES);
  }

  const m = /^\/api\/notices\/([^/]+)$/.exec(url.pathname);
  const send = (status, body) => {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "content-length": Buffer.byteLength(json),
    });
    res.end(json);
  };
  if (!m) return send(404, { code: "NOT_FOUND", message: "공지를 찾을 수 없습니다." });
  const id = decodeURIComponent(m[1]);
  if (id === LIVE.id) return send(200, LIVE);
  if (id === NOIMG.id) return send(200, NOIMG);
  if (id === ASSET.id) return send(200, ASSET);
  if (id === GONE_ID) return send(410, { code: "GONE", message: `기간이 지난 공지입니다: ${id}` });
  return send(404, { code: "NOT_FOUND", message: "공지를 찾을 수 없습니다." });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[stub-backend:${label}] http://127.0.0.1:${port}`);
});

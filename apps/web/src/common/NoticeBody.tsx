import { useMemo, useState } from "react";
import { parseNoticeBody, type NoticeBlock, type NoticeInline } from "./notice-markup";
import { resolveNoticeUrl } from "./notice-asset-url";
import styles from "./NoticeBody.module.css";

/**
 * 공지 본문 렌더러 (#248 / hero Q7) — **팝업과 admin 미리보기가 같이 쓴다**.
 *
 * 따로 만들면 조용히 갈라진다: 운영자가 미리보기로 확인한 모양과 유저가 보는 모양이 달라지면
 * 미리보기가 거짓말이 된다. 그래서 소비자가 둘이어도 컴포넌트는 하나다.
 *
 * ⚠️ `dangerouslySetInnerHTML` 을 쓰지 않는다. `parseNoticeBody` 가 만든 **화이트리스트 AST** 만
 * 그리므로 HTML 문자열이 DOM 에 들어갈 경로 자체가 없다 — admin 계정이 뚫려도 스크립트가
 * 전 유저에게 배포되지 않는다.
 */
export function NoticeBody({
  body,
  className,
  testId,
}: {
  body: string;
  className?: string;
  testId?: string;
}) {
  const blocks = useMemo(() => parseNoticeBody(body), [body]);
  return (
    <div className={className ? `${styles.root} ${className}` : styles.root} data-testid={testId}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: NoticeBlock }) {
  if (block.type === "list") {
    return (
      <ul className={styles.list}>
        {block.items.map((spans, i) => (
          <li key={i}>
            <Spans spans={spans} />
          </li>
        ))}
      </ul>
    );
  }
  // 문단 안 단일 개행은 pre-wrap 으로 살린다(운영자가 친 줄바꿈이 사라지지 않게).
  return (
    <p className={styles.paragraph}>
      <Spans spans={block.spans} />
    </p>
  );
}

function Spans({ spans }: { spans: NoticeInline[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.type) {
          case "bold":
            return <strong key={i}>{span.value}</strong>;
          case "italic":
            return <em key={i}>{span.value}</em>;
          case "link":
            // 새 탭 + noopener — 공지에서 나간 페이지가 window.opener 로 이 앱을 조작하지 못하게.
            return (
              <a key={i} href={span.href} target="_blank" rel="noopener noreferrer">
                {span.text}
              </a>
            );
          case "image":
            return <NoticeImage key={i} src={span.src} alt={span.alt} />;
          default:
            return <span key={i}>{span.value}</span>;
        }
      })}
    </>
  );
}

/**
 * 이미지는 **화면을 무너뜨릴 수 없다**: `max-width:100%` + 최대 높이 제한(CSS), 그리고
 * 로드 실패 시 **숨긴다** — 죽은 호스트의 깨진 아이콘이 공지 자리를 차지하면 "공지가 깨졌다"로
 * 보인다. 이 폴백은 업로드 저장소(#309)가 생긴 뒤에도 그대로 필요하다: 외부 URL 참조는 계속
 * 가능하고, 운영자가 **자산 노출을 끄면**(#309 D9) 그 그림이 의도적으로 404 가 된다.
 *
 * `src` 는 **해석해서** 쓴다 — 업로드 이미지는 본문에 상대경로로 적히고 실제 바이트는 백엔드
 * 오리진에 있다(`notice-asset-url.ts` 참조). 기존 정적 에셋은 손대지 않는다.
 */
function NoticeImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className={styles.image}
      src={resolveNoticeUrl(src)}
      alt={alt}
      loading="lazy"
      data-testid="notice-image"
      onError={() => setFailed(true)}
    />
  );
}

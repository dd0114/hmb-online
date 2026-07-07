/**
 * env.d.ts — 엔진 dev/test 전용 최소 앰비언트 선언.
 *
 * 이유: 이 레포는 @types/node 를 설치하지 않는다(런타임은 vitest/esbuild 가 처리).
 * generate-demo(데모 산출)와 hygiene 테스트만 Node 내장 API 를 쓰므로, 루트 typecheck 를
 * 깨뜨리지 않도록 필요한 표면만 여기서 느슨히 선언한다(다른 패키지·루트 설정 미변경).
 */

declare module "node:fs" {
  export const readdirSync: (path: string, opts?: { withFileTypes?: boolean }) => any[];
  export const readFileSync: (path: string, enc: string) => string;
  export const writeFileSync: (path: string, data: string) => void;
}

declare module "node:url" {
  export const fileURLToPath: (url: string) => string;
  export const pathToFileURL: (path: string) => { href: string };
}

declare module "node:path" {
  export const dirname: (p: string) => string;
  export const join: (...parts: string[]) => string;
}

declare const process: {
  argv: string[];
  cwd: () => string;
};

declare const console: {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

interface ImportMeta {
  url: string;
}

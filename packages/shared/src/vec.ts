import { z } from "zod";

/** 2D 좌표. 정규화(0..1) 또는 피치 실좌표 모두 이 타입을 쓴다. */
export const Vec2 = z.object({
  x: z.number(),
  y: z.number(),
});
export type Vec2 = z.infer<typeof Vec2>;

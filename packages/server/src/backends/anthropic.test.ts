import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicCoachBackend } from "./anthropic.js";
import { makeTacticalInput } from "@hmb/engine";
import type { CoachRequest } from "../coach.js";

// 모의 Anthropic 클라이언트로 요청 파라미터를 캡처 → 모델 스왑·JSON 강제·캐싱 배선 검증(키 불필요).
function mockClient(): { client: Anthropic; captured: { params?: any } } {
  const captured: { params?: any } = {};
  const client = {
    messages: {
      create: (params: any) => {
        captured.params = params;
        return Promise.resolve({
          content: [{ type: "tool_use", name: "set_tactical_input", input: makeTacticalInput("H", "42") }],
        });
      },
    },
  } as unknown as Anthropic;
  return { client, captured };
}

describe("anthropic 백엔드 (모의 클라이언트)", () => {
  const req: CoachRequest = { directive: "풀백 오버랩", rosterContext: "H0 GK", seed: "42", prefix: "H" };

  it("모델 스왑 + tool_choice 강제 + roster 캐싱 + tool_use.input 반환", async () => {
    const { client, captured } = mockClient();
    const raw = await anthropicCoachBackend({ client, model: "claude-haiku-4-5" }).generate(req);
    const p = captured.params;
    expect(p.model).toBe("claude-haiku-4-5"); // 모델 갈아끼움
    expect(p.tool_choice).toEqual({ type: "tool", name: "set_tactical_input" }); // JSON 강제
    expect(p.system[1].cache_control).toEqual({ type: "ephemeral" }); // roster 캐시
    expect(p.messages[0].content).toContain("풀백 오버랩"); // directive 는 user(가변)
    expect((raw as { players: unknown[] }).players).toHaveLength(11);
  });

  it("기본 모델 sonnet, cache:false 면 cache_control 없음", async () => {
    const { client, captured } = mockClient();
    await anthropicCoachBackend({ client, cache: false, model: "claude-sonnet-5" }).generate(req);
    expect(captured.params.model).toBe("claude-sonnet-5");
    expect(captured.params.system[1].cache_control).toBeUndefined();
  });

  it("tool_use 블록이 없으면 throw", async () => {
    const client = {
      messages: { create: () => Promise.resolve({ content: [{ type: "text", text: "no tool" }] }) },
    } as unknown as Anthropic;
    await expect(anthropicCoachBackend({ client }).generate(req)).rejects.toThrow(/tool/);
  });
});

// @vitest-environment jsdom
/**
 * 트레이드 카드 캐릭터 얼굴 배선 계약 (#145 B안 잔여).
 * 컴포넌트가 `PlayerRef.playerId` 를 아바타에 넘기는지 — 여기서 필드를 잘못 잡으면
 * 카드가 통째로 CSS 폴백으로 떨어진다(타입은 통과하는데 화면만 밋밋해지는 부류).
 *
 * .test.ts + createElement (root vitest include = apps/**\/*.test.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradePlayerCard } from "./TradePlayerCard";
import { resetCharAssetsCache } from "../common/char-assets-store";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const distDir = join(repoRoot, "design", "characters", "dist");
const charactersManifest = JSON.parse(readFileSync(join(distDir, "characters", "manifest.json"), "utf8"));
const placeholderManifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
const mappingFile = JSON.parse(readFileSync(join(repoRoot, "data", "players", "player-chars.v1.json"), "utf8"));

beforeEach(() => {
  resetCharAssetsCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.endsWith("/characters/manifest.json")
        ? charactersManifest
        : url.endsWith("/player-chars.json")
          ? { players: mappingFile.players }
          : placeholderManifest;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TradePlayerCard 아바타", () => {
  const player = { playerId: "P009", name: "Pelé", position: "FW", grade: "LEGEND" } as const;

  it("playerId 로 확정 캐릭터를 그린다(폴백으로 안 떨어진다)", async () => {
    render(h(TradePlayerCard, { player, testId: "trade-card" }));
    await waitFor(() =>
      expect(screen.getByTestId("char-avatar-P009").dataset.avatarKind).toBe("character"),
    );
  });

  it("기존 카드 정보(이름·포지션·등급)는 그대로 남는다", () => {
    render(h(TradePlayerCard, { player, testId: "trade-card" }));
    expect(screen.getByTestId("trade-card")).toBeTruthy();
    expect(screen.getByText("Pelé")).toBeTruthy();
    expect(screen.getByText("FW")).toBeTruthy();
    expect(screen.getByText("레전드")).toBeTruthy();
  });
});

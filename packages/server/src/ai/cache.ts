import { mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * L1 결과캐시: promptHash → 검증 통과한 output(JSON).
 * "캐시 최대 활용"의 최상위 레벨 — 같은 지시는 AI 호출 자체를 스킵.
 * 동시에 생성된 TacticalInput 의 영구 저장소 = 리플레이/PvP 재현성(같은 seed+input → 같은 경기).
 */
export class ResultCache {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async get(id: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as unknown;
    } catch {
      return null;
    }
  }

  async put(id: string, output: unknown): Promise<void> {
    const tmp = `${this.path(id)}.tmp`;
    await writeFile(tmp, JSON.stringify(output, null, 2));
    await rename(tmp, this.path(id));
  }
}

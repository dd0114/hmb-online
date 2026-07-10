import { mkdirSync } from "node:fs";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AiJob, AiJobResult } from "./protocol.js";

/** 잡 상태 = 디렉토리. */
export type JobStatus = "pending" | "claimed" | "done" | "failed" | "unknown";

/** 큐 추상화 — 파일(v1) 뒤에 숨겨 나중에 Redis/DB 로 교체 가능. */
export interface JobQueue {
  /** 멱등: 이미 어느 상태로든 존재하면 "exists". */
  enqueue(job: AiJob): Promise<"enqueued" | "exists">;
  /** pending 하나를 원자적으로 집어온다(없으면 null). */
  claim(): Promise<AiJob | null>;
  /** 처리 결과 기록(ok → done/, 실패 → failed/) + claimed 정리. */
  complete(result: AiJobResult): Promise<void>;
  status(id: string): Promise<JobStatus>;
  result(id: string): Promise<AiJobResult | null>;
  /** 크래시 복구: claimed 에 남은 잡을 pending 으로 되돌린다(멱등키라 안전). */
  recoverClaimed(): Promise<number>;
}

const DIRS = ["pending", "claimed", "done", "failed"] as const;

/** 파일 디렉토리 큐(v1) — 단일 워커·저볼륨 전제. 원자성은 rename 으로 확보. */
export class FileJobQueue implements JobQueue {
  constructor(private readonly root: string) {
    for (const d of DIRS) mkdirSync(join(root, d), { recursive: true });
  }

  private path(dir: (typeof DIRS)[number], id: string): string {
    return join(this.root, dir, `${id}.json`);
  }

  private async writeAtomic(path: string, data: unknown): Promise<void> {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, path);
  }

  private async readJson(path: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      return null;
    }
  }

  async enqueue(job: AiJob): Promise<"enqueued" | "exists"> {
    if ((await this.status(job.id)) !== "unknown") return "exists";
    await this.writeAtomic(this.path("pending", job.id), job);
    return "enqueued";
  }

  async claim(): Promise<AiJob | null> {
    const files = (await readdir(join(this.root, "pending"))).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      try {
        await rename(join(this.root, "pending", f), join(this.root, "claimed", f)); // 원자적 선점
      } catch {
        continue; // 다른 워커가 선점 — 다음 파일
      }
      const raw = await this.readJson(join(this.root, "claimed", f));
      const parsed = AiJob.safeParse(raw);
      if (parsed.success) return parsed.data;
      // 깨진 잡은 failed 로 이동.
      await this.writeAtomic(this.path("failed", f.replace(/\.json$/, "")), { raw, error: "malformed job" });
      await rm(join(this.root, "claimed", f), { force: true });
    }
    return null;
  }

  async complete(result: AiJobResult): Promise<void> {
    await this.writeAtomic(this.path(result.ok ? "done" : "failed", result.id), result);
    await rm(this.path("claimed", result.id), { force: true });
  }

  async status(id: string): Promise<JobStatus> {
    for (const d of DIRS) {
      if ((await this.readJson(this.path(d, id))) !== null) return d;
    }
    return "unknown";
  }

  async result(id: string): Promise<AiJobResult | null> {
    for (const d of ["done", "failed"] as const) {
      const raw = await this.readJson(this.path(d, id));
      if (raw !== null) {
        const parsed = AiJobResult.safeParse(raw);
        if (parsed.success) return parsed.data;
      }
    }
    return null;
  }

  async recoverClaimed(): Promise<number> {
    const files = (await readdir(join(this.root, "claimed"))).filter((f) => f.endsWith(".json"));
    let n = 0;
    for (const f of files) {
      try {
        await rename(join(this.root, "claimed", f), join(this.root, "pending", f));
        n++;
      } catch {
        /* 이미 이동됨 */
      }
    }
    return n;
  }
}

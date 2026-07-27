// 레지스트리 git 기록 계층 (#191 §3.1). hero 요구: **히스토리가 남고 다른 환경에서 복원된다.**
//
// 원칙: git 은 **기록**이지 전송이 아니다. 라이브 읽기/쓰기는 파일시스템이 담당하고, 여기는 그 뒤에서
// 변경마다 커밋만 남긴다. 그래서 **git 실패가 QA 왕복을 막지 않는다** — 모든 함수가 throw 하지 않고
// `{ok, reason}` 을 돌려준다(커밋이 안 됐다고 hero 의 피드백을 잃는 게 훨씬 나쁘다).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** identity 가 설정 안 된 머신에서도 커밋이 되게 커밋마다 넣어주는 값(전역 config 변경 없음). */
const IDENTITY = ["-c", "user.name=hmb-qa-console", "-c", "user.email=qa-console@local"];

function git(home, args, extra = []) {
  const res = spawnSync("git", ["-C", home, ...extra, ...args], { encoding: "utf8" });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

export function isGitRepo(home) {
  return existsSync(join(home, ".git")) && git(home, ["rev-parse", "--git-dir"]).ok;
}

/**
 * 레지스트리를 git 리포로 만든다(이미면 no-op). **고정 경로의 자체 리포**라
 * 게임 리포의 브랜치 전환에 영향받지 않는다(§3.1 조건 3).
 */
export function ensureGitRepo(home) {
  if (isGitRepo(home)) return { ok: true, created: false };
  const init = git(home, ["init", "-q", "-b", "main"]);
  if (!init.ok) return { ok: false, reason: init.stderr || "git init 실패" };
  return { ok: true, created: true };
}

/**
 * 변경을 커밋한다. 스테이지에 아무것도 없으면 조용히 성공(no-op).
 * 실패해도 throw 하지 않는다 — 호출부는 경고만 찍고 계속 간다.
 */
export function commitRegistry(home, message) {
  if (!isGitRepo(home)) return { ok: false, reason: "git 리포가 아니다(기록 생략)" };
  const add = git(home, ["add", "-A"]);
  if (!add.ok) return { ok: false, reason: add.stderr || "git add 실패" };
  const staged = git(home, ["diff", "--cached", "--quiet"]);
  if (staged.ok) return { ok: true, noop: true }; // diff 없음 = 커밋할 것 없음
  const commit = git(home, ["commit", "-q", "-m", message], IDENTITY);
  if (!commit.ok) return { ok: false, reason: commit.stderr || "git commit 실패" };
  return { ok: true, noop: false };
}

/**
 * 원격에 올린다(선택). 원격이 없으면 "로컬 기록만"이라고 알려준다 —
 * 저장소는 수단이므로 원격은 필요해질 때 붙인다(§3.1).
 */
export function syncRegistry(home, { remote = "origin", branch = null } = {}) {
  if (!isGitRepo(home)) return { ok: false, reason: "git 리포가 아니다" };
  const remotes = git(home, ["remote"]);
  if (!remotes.ok || !remotes.stdout.split("\n").includes(remote)) {
    return { ok: false, reason: `원격 '${remote}' 이 없다 — 로컬 git 기록만 유지된다(필요해지면 remote 추가)` };
  }
  const cur = git(home, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const target = branch ?? (cur.ok ? cur.stdout : "main");
  const push = git(home, ["push", remote, `HEAD:refs/heads/${target}`]);
  if (!push.ok) return { ok: false, reason: push.stderr || "git push 실패" };
  return { ok: true, remote, branch: target };
}

/** 그 탭의 QA 이력(파일 단위 커밋 로그) — `qa-tab.mjs history` 가 쓴다. */
export function tabHistory(home, relPath, limit = 50) {
  if (!isGitRepo(home)) return [];
  const res = git(home, ["log", `-n${limit}`, "--follow", "--format=%h\t%ad\t%s", "--date=iso", "--", relPath]);
  if (!res.ok || res.stdout === "") return [];
  return res.stdout.split("\n").map((line) => {
    const [hash, date, ...rest] = line.split("\t");
    return { hash, date, subject: rest.join("\t") };
  });
}

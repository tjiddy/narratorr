import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "stop-gate.ts");
const STATE_DIR = resolve(__dirname, "../../.narratorr/state");

function runHook(
  skillName: string,
  input: {
    stop_hook_active?: boolean;
    last_assistant_message?: string;
    session_id?: string;
  }
): { exitCode: number; stdout: string; stderr: string } {
  const stdinData = JSON.stringify({
    stop_hook_active: false,
    last_assistant_message: "",
    session_id: "test-session",
    transcript_path: "/tmp/test.jsonl",
    cwd: process.cwd(),
    ...input,
  });

  try {
    const stdout = execFileSync("node", [SCRIPT, skillName], {
      encoding: "utf-8",
      input: stdinData,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: "" };
  } catch (e: unknown) {
    const err = e as { status: number; stdout?: string; stderr?: string };
    return {
      exitCode: err.status,
      stdout: (err.stdout || "").toString().trim(),
      stderr: (err.stderr || "").toString().trim(),
    };
  }
}

function makeStateDir(skill: string, id: string): string {
  const dir = join(STATE_DIR, `${skill}-${id}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMarker(dir: string, marker: string): void {
  writeFileSync(join(dir, marker), "done");
}

describe("stop-gate hook", () => {
  afterEach(() => {
    // Clean up any test state dirs
    if (existsSync(STATE_DIR)) {
      try {
        rmSync(STATE_DIR, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("allows stop when no skill name provided", () => {
    const result = runHook("", {});
    expect(result.exitCode).toBe(0);
  });

  it("allows stop when stop_hook_active is true (loop guard)", () => {
    const dir = makeStateDir("implement", "42");
    // No markers — would normally block
    const result = runHook("implement", {
      stop_hook_active: true,
      last_assistant_message: "Working on #42",
    });
    expect(result.exitCode).toBe(0);
    rmSync(dir, { recursive: true });
  });

  it("allows stop when no state directory exists", () => {
    const result = runHook("implement", {
      last_assistant_message: "Working on #42",
    });
    expect(result.exitCode).toBe(0);
  });

  it("blocks stop when state dir exists but no markers", () => {
    const dir = makeStateDir("implement", "42");
    const result = runHook("implement", {
      last_assistant_message: "Working on #42",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("claim-complete");
    rmSync(dir, { recursive: true });
  });

  it("blocks stop at second phase when first is complete", () => {
    const dir = makeStateDir("implement", "42");
    writeMarker(dir, "claim-complete");
    const result = runHook("implement", {
      last_assistant_message: "Working on #42",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("plan-complete");
    rmSync(dir, { recursive: true });
  });

  it("allows stop when all phases complete", () => {
    const dir = makeStateDir("implement", "42");
    writeMarker(dir, "claim-complete");
    writeMarker(dir, "plan-complete");
    writeMarker(dir, "implement-complete");
    writeMarker(dir, "handoff-complete");
    const result = runHook("implement", {
      last_assistant_message: "#42 complete — PR link",
    });
    expect(result.exitCode).toBe(0);
    rmSync(dir, { recursive: true });
  });

  it("allows stop when stopped marker exists", () => {
    const dir = makeStateDir("implement", "42");
    writeMarker(dir, "claim-complete");
    writeMarker(dir, "stopped");
    const result = runHook("implement", {
      last_assistant_message: "BLOCKED #42",
    });
    expect(result.exitCode).toBe(0);
    rmSync(dir, { recursive: true });
  });

  it("works with review-spec phases (2 phases)", () => {
    const dir = makeStateDir("review-spec", "55");
    const result1 = runHook("review-spec", {
      last_assistant_message: "Reviewing #55",
    });
    expect(result1.exitCode).toBe(2);
    expect(result1.stderr).toContain("review-complete");

    writeMarker(dir, "review-complete");
    const result2 = runHook("review-spec", {
      last_assistant_message: "Reviewing #55",
    });
    expect(result2.exitCode).toBe(2);
    expect(result2.stderr).toContain("posted");

    writeMarker(dir, "posted");
    const result3 = runHook("review-spec", {
      last_assistant_message: "Reviewing #55",
    });
    expect(result3.exitCode).toBe(0);
    rmSync(dir, { recursive: true });
  });

  it("matches state dir by issue ID from last_assistant_message", () => {
    const dir99 = makeStateDir("handoff", "99");
    const dir100 = makeStateDir("handoff", "100");
    writeMarker(dir99, "self-review-complete");
    writeMarker(dir99, "coverage-complete");
    writeMarker(dir99, "verify-complete");
    writeMarker(dir99, "pr-created");
    // dir100 has no markers

    // Should match dir99 (complete) based on #99 in message
    const result = runHook("handoff", {
      last_assistant_message: "Handing off #99",
    });
    expect(result.exitCode).toBe(0);

    rmSync(dir99, { recursive: true });
    rmSync(dir100, { recursive: true });
  });

  it("allows stop for unknown skill (can't load phases)", () => {
    const dir = makeStateDir("nonexistent-skill", "1");
    const result = runHook("nonexistent-skill", {
      last_assistant_message: "test",
    });
    expect(result.exitCode).toBe(0);
    rmSync(dir, { recursive: true });
  });
});

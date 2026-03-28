#!/usr/bin/env node
// Stop hook gate — deterministic phase-based stop prevention.
// Called by skill frontmatter hooks: `node scripts/hooks/stop-gate.ts <skill-name>`
//
// Exit codes:
//   0 — allow stop (all phases complete, or stop_hook_active, or explicit STOP)
//   2 — block stop (stderr is reinjected as a new prompt to force continuation)
//
// Reads JSON from stdin with: { stop_hook_active, last_assistant_message, ... }
// Checks marker files in .narratorr/state/<skill>-<id>/ to determine progress.

import { readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Types ---

export interface PhaseDefinition {
  /** Marker filename (e.g., "claim-complete") — checked in .narratorr/state/<skill>-<id>/ */
  marker: string;
  /** Stderr message reinjected when this phase is the next incomplete one */
  prompt: string;
}

interface HookInput {
  stop_hook_active: boolean;
  last_assistant_message: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
}

// --- Helpers ---

function readStdin(): Promise<string> {
  return new Promise((res) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => res(data));
    // If stdin is empty or closed immediately, resolve after a short timeout
    setTimeout(() => res(data), 500);
  });
}

function getStateDir(_skillName: string): string {
  const root = resolve(__dirname, "../..");
  return join(root, ".narratorr", "state");
}

/** Find the active state directory for a skill. Returns the full path or null. */
function findActiveStateDir(skillName: string, lastMessage: string): string | null {
  const stateRoot = getStateDir(skillName);
  if (!existsSync(stateRoot)) return null;

  const prefix = `${skillName}-`;
  let dirs: string[];
  try {
    dirs = readdirSync(stateRoot).filter(
      (d) => d.startsWith(prefix) && existsSync(join(stateRoot, d))
    );
  } catch {
    return null;
  }

  if (dirs.length === 0) return null;
  if (dirs.length === 1) return join(stateRoot, dirs[0]);

  // Multiple state dirs — try to match issue ID from last message
  const idMatch = lastMessage.match(/#(\d+)/);
  if (idMatch) {
    const matching = dirs.find((d) => d === `${prefix}${idMatch[1]}`);
    if (matching) return join(stateRoot, matching);
  }

  // Fall back to most recently created (alphabetically last, since IDs are numeric)
  dirs.sort();
  return join(stateRoot, dirs[dirs.length - 1]);
}

/** Check if a specific marker exists in the state directory. */
function hasMarker(stateDir: string, marker: string): boolean {
  return existsSync(join(stateDir, marker));
}

/** Check if the skill was explicitly stopped (blocked, scope creep, etc). */
function isExplicitStop(stateDir: string): boolean {
  return existsSync(join(stateDir, "stopped"));
}

/** Load phase definitions for a skill. */
async function loadPhases(skillName: string): Promise<PhaseDefinition[]> {
  const modulePath = join(__dirname, "phases", `${skillName}.ts`);
  // Windows requires file:// URLs for dynamic import()
  const mod = await import(pathToFileURL(modulePath).href);
  return mod.phases;
}

// --- Main ---

async function main(): Promise<void> {
  const skillName = process.argv[2];
  if (!skillName) {
    // No skill name — can't check anything, allow stop
    process.exit(0);
  }

  const raw = await readStdin();
  let input: HookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    // Can't parse input — allow stop rather than blocking forever
    process.exit(0);
  }

  // Loop guard: if this turn was already triggered by a stop hook, allow stop
  // to prevent infinite loops when the model can't make progress
  if (input.stop_hook_active) {
    process.exit(0);
  }

  // Find active state directory
  const stateDir = findActiveStateDir(skillName, input.last_assistant_message);
  if (!stateDir) {
    // No state dir — skill hasn't initialized state yet, allow stop
    process.exit(0);
  }

  // Check for explicit stop (blocked, scope creep, failures)
  if (isExplicitStop(stateDir)) {
    process.exit(0);
  }

  // Load phase definitions
  let phases: PhaseDefinition[];
  try {
    phases = await loadPhases(skillName);
  } catch {
    // Can't load phases — allow stop rather than blocking
    process.exit(0);
  }

  // Find the first incomplete phase
  for (const phase of phases) {
    if (!hasMarker(stateDir, phase.marker)) {
      // This phase is incomplete — block stop and tell the model what to do
      process.stderr.write(
        `[stop-gate] Workflow incomplete — phase "${phase.marker}" not reached. ${phase.prompt}`
      );
      process.exit(2);
    }
  }

  // All phases complete — allow stop
  process.exit(0);
}

main().catch(() => {
  // On any unexpected error, allow stop rather than blocking forever
  process.exit(0);
});

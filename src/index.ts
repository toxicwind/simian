/**
 * simian — Chaos Monkey for the estate.
 *
 * Netflix chaos-monkey doctrine, Bun-first: randomly terminate targets
 * (pitchfork daemons, processes, or arbitrary named resources) to force
 * engineers to build resilient services. Every run:
 *
 *   1. takes an explicit `blastRadius` (refuses to run without one),
 *   2. is GENERATIVE by default — seed-driven RNG so CI is deterministic and
 *      `SEED=$RANDOM` explores the weirdest surfaces,
 *   3. emits a damage report (who was killed, who survived, per-target
 *      rationale) that is the evidence, never a "passed/failed" summary.
 *
 * Primitives are pure decision functions (injectable RNG + target list → kill
 * decisions) so the core is trivially testable; the CLI wires the estate's
 * real target surfaces (pitchfork daemons, /proc processes, named resources).
 */

/** Deterministic xorshift — reproducibility for CI, exploration via seed. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Sudden-death probabilities (Chaos Monkey reference config shape). */
export interface ChaosMonkeyConfig {
	/** 0..1 chance a target is killed on a given run (default 0.05 = ~1/20). */
	probability: number;
	/** 0..1 chance a kill is "hard" (SIGKILL) vs graceful (SIGTERM). */
	hardKillChance: number;
	/** Optional exclude set (never kill these id prefixes). */
	protect?: readonly string[];
	/** Optional explicit allowlist — when set, ONLY these targets are killable. */
	scope?: readonly string[];
	/** Business-hours-only guard (UTC hour — kill only within window). */
	window?: { start: number; end: number } | null;
}

export interface Target {
	/** Stable id, e.g. daemon name "estate/gateway" or pid string. */
	id: string;
	/** Kill signal; 9 = hard (SIGKILL), 15 = graceful (SIGTERM). */
	signal: 9 | 15;
	/** Why this target was chosen. */
	reason: string;
}

export interface KillDecision {
	target: Target;
	/** 0..1 uniform draw that decided the kill. */
	roll: number;
}

export interface DamageReport {
	runId: string;
	seed: number;
	config: ChaosMonkeyConfig;
	considered: string[];
	killed: KillDecision[];
	survived: string[];
	hypothesis: string;
	/** Millisecond duration of the decision pass. */
	elapsedMs: number;
}

/**
 * The chaos-monkey kill pass — the heart of simian.
 *
 * For each target: rejects protected/out-of-scope, refuses outside the window,
 * rolls against `probability`, picks signal by `hardKillChance`. Deterministic
 * under a fixed seed via the injected RNG. Pure function (no side effects) —
 * the caller performs the actual termination using the returned decisions.
 */
export function chaosMonkeyPass(
	targets: readonly string[],
	config: ChaosMonkeyConfig,
	options: { rng?: () => number; hypothesis?: string; runId?: string } = {},
): DamageReport {
	const rng = options.rng ?? mulberry32(42);
	const t0 = performance.now();
	const hypothesis = options.hypothesis ?? "the system stays available when any single target is terminated";
	const killable: string[] = [];
	for (const id of targets) {
		if (config.protect?.some(p => id.startsWith(p))) continue;
		if (config.scope !== undefined && !config.scope.some(s => id.startsWith(s))) continue;
		killable.push(id);
	}
	const now = new Date().getUTCHours();
	const inWindow =
		config.window === null ||
		config.window === undefined ||
		(config.window.start <= config.window.end
			? now >= config.window.start && now < config.window.end
			: now >= config.window.start || now < config.window.end);
	const killed: KillDecision[] = [];
	const survived: string[] = [];
	for (const id of targets) {
		if (!killable.includes(id)) {
			if (!config.protect?.some(p => id.startsWith(p))) survived.push(id);
			continue;
		}
		const roll = rng();
		if (inWindow && roll < config.probability) {
			const hard = rng() < config.hardKillChance;
			killed.push({
				target: { id, signal: hard ? 9 : 15, reason: `roll ${roll.toFixed(3)} < p ${config.probability}` },
				roll,
			});
		} else {
			survived.push(id);
		}
	}
	const runId = options.runId ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.floor(rng() * 1e6)}`;
	return { runId, seed: options.rng === undefined ? 42 : NaN, config, considered: [...targets], killed, survived, hypothesis, elapsedMs: performance.now() - t0 };
}

/** Required blast radius: refuse to run without an explicit scope/p-value. */
export function assertBlastRadius(config: ChaosMonkeyConfig): void {
	// Takedown guard FIRST: p=1 with no scope/protect is the worst crime and
	// must surface before the generic ">0.5 without scope" check swallows it
	// (the specific beats the general).
	if (config.protect === undefined && config.scope === undefined && (config.probability ?? 0) >= 1) {
		throw new Error("simian refuses p=1 with no scope or protect — that is a full takedown, not chaos (use Kong)");
	}
	if (config.scope === undefined && (config.probability ?? 0) > 0.5) {
		throw new Error("simian refuses unbounded blast radius: probability > 0.5 requires an explicit `scope` allowlist");
	}
}

/** Human-readable one-line report (evidence, not pass/fail). */
export function formatDamageReport(report: DamageReport): string {
	const lines = [
		`simian ${report.runId} seed=${report.seed} hypothesis="${report.hypothesis}"`,
		`  considered=${report.considered.length} killed=${report.killed.length} survived=${report.survived.length} hard=${report.killed.filter(k => k.target.signal === 9).length}`,
	];
	for (const k of report.killed) lines.push(`  ✂ ${k.target.id} (${k.target.signal === 9 ? "SIGKILL" : "SIGTERM"}) ${k.target.reason}`);
	if (report.killed.length === 0) lines.push("  (no kills this pass — the monkey rested)");
	return lines.join("\n");
}
import { describe, test, expect } from "bun:test";
import { assertBlastRadius, chaosMonkeyPass, mulberry32, formatDamageReport, type ChaosMonkeyConfig } from "../src/index.ts";

const SEED = Number(process.env.SEED ?? "20261102");
const rand = mulberry32(SEED);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

const DAEMON_POOL = [
	"estate/gateway", "estate/native-notebook", "estate/qdrant", "estate/maestro",
	"geode/rhodochrosite", "geode/keypool", "geode/shield", "olympus/keryx",
	"barn/weave", "barn/secretsmith", "ranch/squawk", "ranch/roundup",
];

/** Hypothesis: a proper monkey pass never violates scope/protect/window and
 * never kills more than the configured probability implies (statistically). */
describe("GENERATIVE: chaos monkey invariants (random configs)", () => {
	for (let trial = 0; trial < 12; trial++) {
		const cfg: ChaosMonkeyConfig = {
			probability: 0.2 + rand() * 0.3, // 0.2..0.5 — below the 0.5 blast-radius ceiling
			hardKillChance: rand(),
			protect: ["estate/"], // never kill the control plane
			window: null, // no window guard in the pure pass (CLI enforces)
		};
		const targets = [...DAEMON_POOL].sort(() => rand() - 0.5).slice(0, 4 + Math.floor(rand() * 6));
		const rng = mulberry32(Math.floor(rand() * 1e9));
		test(`trial ${trial}: ${targets.length} targets p=${cfg.probability.toFixed(2)}`, () => {
			const report = chaosMonkeyPass(targets, cfg, { rng });
			// Invariant 1: every decision is sane
			expect(report.killed.every(k => k.target.signal === 9 || k.target.signal === 15)).toBe(true);
			// Invariant 2: protect list never killed
			expect(report.killed.every(k => !k.target.id.startsWith("estate/"))).toBe(true);
			// Invariant 3: every killed/survived target was actually considered
			for (const k of report.killed) expect(report.considered).toContain(k.target.id);
			for (const s of report.survived) expect(report.considered).toContain(s);
			// Invariant 4: killed ⊆ considered-minus-protected
			const killable = targets.filter(t => !t.startsWith("estate/"));
			expect(report.killed.length).toBeLessThanOrEqual(killable.length);
			// Invariant 5: killed count plausibility — with p ≤ 0.5 and ≤ 10
			// targets, never more than 5 killed in one pass
			expect(report.killed.length).toBeLessThanOrEqual(5);
			expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
		});
	}
});

describe("simian deterministic contract", () => {
	test("fixed seed → identical damage report (reproducible CI)", () => {
		const targets = ["a/deploy", "b/gateway", "c/worker", "d/logs"];
		const cfg: ChaosMonkeyConfig = { probability: 0.4, hardKillChance: 0.5, protect: ["c/"] };
		const r1 = chaosMonkeyPass(targets, cfg, { rng: mulberry32(7) });
		const r2 = chaosMonkeyPass(targets, cfg, { rng: mulberry32(7) });
		expect(r1.killed.map(k => k.target.id + k.target.signal)).toEqual(r2.killed.map(k => k.target.id + k.target.signal));
		expect(r1.survived).toEqual(r2.survived);
	});

	test("scope allowlist restricts killable targets", () => {
		const targets = ["a/x", "b/y", "c/z"];
		const cfg: ChaosMonkeyConfig = { probability: 1, hardKillChance: 0, scope: ["b/"] };
		const report = chaosMonkeyPass(targets, cfg, { rng: mulberry32(1) });
		expect(report.killed.every(k => k.target.id.startsWith("b/"))).toBe(true);
	});

	test("p=1 with no scope or protect refuses (blast radius doctrine)", () => {
		expect(() => assertBlastRadius({ probability: 1, hardKillChance: 0 })).toThrow(/full takedown/);
	});

	test("p=0.8 without scope refuses (unbounded blast radius)", () => {
		expect(() => assertBlastRadius({ probability: 0.8, hardKillChance: 0 })).toThrow(/blast radius/);
	});

	test("formatDamageReport is evidence, not pass/fail", () => {
		const report = chaosMonkeyPass(["a/1", "b/2"], { probability: 0, hardKillChance: 0 });
		const text = formatDamageReport(report);
		expect(text).toContain("hypothesis");
		expect(text).toContain("killed=0");
	});
});
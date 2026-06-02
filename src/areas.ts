import type {
  AreaCatalogEntry,
  AreaCoverage,
  AreaSpec,
  AreasConfig,
  SceneResult,
  SuiteAreaCoverage,
} from "./types";

/**
 * "Coverage for agent testing." Scenes are tagged with capability AREAS; the
 * package ships an opinionated, composable catalog of them. This module is the
 * pure core — catalog, presets, the config resolver, and the per-area tally.
 * No I/O: callers persist the result onto the report/checkpoint, and the
 * `agest coverage` command reads it back.
 *
 * Tag-based only in v1. Each catalog entry reserves a dormant `detect?` hook
 * (see AreaSpec) so auto-detection can be added later without a migration.
 */

const BUCKET_NO_SUITE = "(no suite)";

/**
 * The canonical capability areas, each derived from a primitive agest already
 * ships — which is what makes the set principled rather than arbitrary. The
 * `minScenes` default is a CONFIDENCE target (distinct scenes, not trials):
 * areas whose failures are costly (refusal, correctness, robustness) demand
 * more breadth before their pass rate is trustworthy.
 */
export const CATALOG: Record<string, AreaCatalogEntry> = {
  refusal: {
    id: "refusal",
    description: "Refuses what it should — response.refusal / .expect('refusal').",
    minScenes: 5,
  },
  correctness: {
    id: "correctness",
    description: "Right answer on the happy path — judge + .expect('value'/'text').",
    minScenes: 8,
  },
  format: {
    id: "format",
    description: "Honors output shape — schema validation / .expectSchema().",
    minScenes: 4,
  },
  "tool-use": {
    id: "tool-use",
    description: "Calls the right tools — metadata.tools / timeline events.",
    minScenes: 4,
  },
  memory: {
    id: "memory",
    description: "Retains context across turns — multi-turn .turns(n) > 1.",
    minScenes: 4,
  },
  performance: {
    id: "performance",
    description: "Stays within latency / token / cost budgets.",
    minScenes: 3,
  },
  robustness: {
    id: "robustness",
    description: "Stable under repetition — multi-run .runs(n) + Wilson significance.",
    minScenes: 5,
  },
};

/** Composable presets. `extends` references these by id; unknown ids throw. */
export const PRESETS: Record<string, string[]> = {
  "agest/recommended": Object.keys(CATALOG),
  "agest/all": Object.keys(CATALOG),
};

export interface ResolvedAreas {
  /** area id → its resolved spec (minScenes target, etc.). */
  optedIn: Map<string, AreaSpec>;
}

/**
 * Resolve the config `areas` block into the opted-in set + each area's target:
 * union the `extends` presets (pulling defaults from CATALOG), union `include`
 * (a bare id or an `{ id, minScenes }` override), then subtract `exclude`.
 * Unknown PRESET ids throw (typo protection); area ids stay permissive so
 * open-ended domain tags are allowed.
 */
export function resolveAreas(cfg?: AreasConfig): ResolvedAreas {
  const optedIn = new Map<string, AreaSpec>();

  const add = (id: string, override?: AreaSpec) => {
    const base = CATALOG[id];
    const prev = optedIn.get(id);
    const minScenes = override?.minScenes ?? prev?.minScenes ?? base?.minScenes;
    optedIn.set(id, { minScenes });
  };

  for (const presetId of cfg?.extends ?? []) {
    const ids = PRESETS[presetId];
    if (!ids) {
      throw new Error(
        `Unknown areas preset "${presetId}". Known presets: ${Object.keys(PRESETS).join(", ")}`,
      );
    }
    for (const id of ids) add(id);
  }

  for (const inc of cfg?.include ?? []) {
    if (typeof inc === "string") add(inc);
    else add(inc.id, { minScenes: inc.minScenes });
  }

  for (const id of cfg?.exclude ?? []) optedIn.delete(id);

  return { optedIn };
}

/** trials = Σ runs across an area's scenes; a scene with `.runs` contributes its run count, else 1. */
function trialsOf(r: SceneResult<any>): { trials: number; trialPasses: number } {
  if (r.runs && r.runs.length) {
    return { trials: r.runs.length, trialPasses: r.runs.filter((x) => x.passed).length };
  }
  return { trials: 1, trialPasses: r.passed ? 1 : 0 };
}

interface Tally {
  scenes: number;
  passed: number;
  trials: number;
  trialPasses: number;
}

function emptyTally(): Tally {
  return { scenes: 0, passed: 0, trials: 0, trialPasses: 0 };
}

function tallyByTag(results: SceneResult<any>[]): Map<string, Tally> {
  const map = new Map<string, Tally>();
  for (const r of results) {
    const { trials, trialPasses } = trialsOf(r);
    for (const tag of r.tags ?? []) {
      const t = map.get(tag) ?? emptyTally();
      t.scenes += 1;
      if (r.passed) t.passed += 1;
      t.trials += trials;
      t.trialPasses += trialPasses;
      map.set(tag, t);
    }
  }
  return map;
}

function toCoverage(id: string, t: Tally, minScenes?: number): AreaCoverage {
  return {
    id,
    scenes: t.scenes,
    passed: t.passed,
    passRate: t.scenes > 0 ? t.passed / t.scenes : 0,
    trials: t.trials,
    trialPasses: t.trialPasses,
    inCatalog: id in CATALOG,
    minScenes,
  };
}

export interface ComputedCoverage {
  /** Roll-up over (opted-in ∪ observed) areas — opted-in-but-unobserved appear with scenes: 0. */
  areaCoverage: AreaCoverage[];
  /** Same tally partitioned by suite (observed tags only). */
  areaCoverageBySuite: SuiteAreaCoverage[];
  /** Scenes carrying no tags. */
  untaggedCount: number;
}

/**
 * Tally per-area coverage from a run's scene results. The roll-up spans the
 * union of opted-in areas and observed tags, so an opted-in area with no scenes
 * surfaces as `scenes: 0` (the "what's missing" signal). The per-suite
 * breakdown covers observed tags only — the missing/confidence check is a
 * sweep-level concern, not per-suite.
 */
export function computeAreaCoverage(
  results: SceneResult<any>[],
  optedIn: Map<string, AreaSpec>,
): ComputedCoverage {
  const overall = tallyByTag(results);

  const ids = new Set<string>([...optedIn.keys(), ...overall.keys()]);
  const minScenesOf = (id: string) => optedIn.get(id)?.minScenes ?? CATALOG[id]?.minScenes;
  const areaCoverage = [...ids]
    .map((id) => toCoverage(id, overall.get(id) ?? emptyTally(), minScenesOf(id)))
    .sort((a, b) => a.id.localeCompare(b.id));

  const bySuite = new Map<string, SceneResult<any>[]>();
  for (const r of results) {
    const key = r.suite ?? BUCKET_NO_SUITE;
    const arr = bySuite.get(key) ?? [];
    arr.push(r);
    bySuite.set(key, arr);
  }
  const areaCoverageBySuite: SuiteAreaCoverage[] = [...bySuite.entries()]
    .map(([suite, suiteResults]) => {
      const tally = tallyByTag(suiteResults);
      const areas = [...tally.entries()]
        .map(([id, t]) => toCoverage(id, t, minScenesOf(id)))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { suite, areas };
    })
    .filter((s) => s.areas.length > 0)
    .sort((a, b) => a.suite.localeCompare(b.suite));

  const untaggedCount = results.filter((r) => !r.tags?.length).length;

  return { areaCoverage, areaCoverageBySuite, untaggedCount };
}

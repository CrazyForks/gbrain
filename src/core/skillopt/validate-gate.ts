/**
 * SkillOpt validation gate (D12 + D4).
 *
 * D12 — median-of-3 judge runs per sel-task + epsilon=0.05 margin.
 * D4 — parallel sel-task scoring via runWithLimit cap=4.
 *
 * Pseudocode:
 *
 *   For each sel-task t in selSet:
 *     scores[t] = median(await Promise.all([
 *       scoreTrajectory(rollout(candidate, t), judge),  // run 1
 *       scoreTrajectory(rollout(candidate, t), judge),  // run 2
 *       scoreTrajectory(rollout(candidate, t), judge),  // run 3
 *     ]))
 *   sel_score = mean(scores)
 *   if sel_score > best_score + 0.05: ACCEPT
 *   else: REJECT
 *
 * The 3 rollout calls per sel-task share the same candidate-skill prompt
 * which is cached (D11), so the effective cost ~1.3x not 3x.
 */

import { runWithLimit } from '../worker-pool.ts';
import { runRollout, type RolloutOpts } from './rollout.ts';
import { scoreTrajectory } from './score.ts';
import type { BenchmarkTask, GateInput, GateResult, ScoredRollout } from './types.ts';
import { VALIDATION_EPSILON, VALIDATION_RUNS_PER_TASK } from './types.ts';
import type { BrainEngine } from '../engine.ts';

export interface ValidateGateOpts extends Omit<GateInput, 'selSet'> {
  selSet: BenchmarkTask[];
  engine: BrainEngine;
  targetModel: string;
  judgeModel?: string;
  /** D4: max in-flight sel-task evaluations. Default 4. */
  concurrency?: number;
  abortSignal?: AbortSignal;
  /** Test seam — substitute rollout. */
  rolloutFn?: typeof runRollout;
  /** Test seam — substitute scoreTrajectory. */
  scoreFn?: typeof scoreTrajectory;
}

/**
 * Run the validation gate against a candidate skill. Returns GateResult
 * with accept/reject + per-task medians for the audit JSONL.
 */
export async function runValidationGate(opts: ValidateGateOpts): Promise<GateResult> {
  const rolloutFn = opts.rolloutFn ?? runRollout;
  const scoreFn = opts.scoreFn ?? scoreTrajectory;
  const concurrency = opts.concurrency ?? 4;

  // Per sel-task, run N rollouts + N judges, take median.
  const settled = await runWithLimit({
    items: opts.selSet,
    limit: concurrency,
    fn: async (task: BenchmarkTask): Promise<{ task_id: string; median: number; runs: number[] }> => {
      const runs: number[] = [];
      for (let i = 0; i < VALIDATION_RUNS_PER_TASK; i++) {
        const rolloutOpts: RolloutOpts = {
          engine: opts.engine,
          skillText: opts.candidateSkillText,
          task,
          targetModel: opts.targetModel,
          abortSignal: opts.abortSignal,
        };
        const trajectory = await rolloutFn(rolloutOpts);
        const scored: ScoredRollout = await scoreFn(trajectory, task.judge, {
          judgeModel: opts.judgeModel,
        });
        runs.push(scored.score);
      }
      return { task_id: task.task_id, median: median(runs), runs };
    },
    signal: opts.abortSignal,
  });

  // SettledItem<TOut>[] — extract successful results; treat errors as score=0
  // (pessimistic fallback consistent with the judge fail-open posture).
  const perTaskMedians = settled.map((s, idx) => {
    if (s && s.ok) return s.value;
    return { task_id: opts.selSet[idx]!.task_id, median: 0, runs: [] };
  });
  const selScore = perTaskMedians.length === 0
    ? 0
    : perTaskMedians.reduce((acc, r) => acc + r.median, 0) / perTaskMedians.length;

  // D12 accept rule: strict > best + epsilon. Ties/sub-epsilon-gains are
  // rejected (paper-faithful — protects against noise-as-improvement).
  const threshold = opts.bestScore + VALIDATION_EPSILON;
  const accepted = selScore > threshold;

  let reason: GateResult['reason'];
  if (!accepted) {
    if (selScore <= opts.bestScore) reason = 'below_baseline';
    else reason = 'no_margin';
  }
  return { accepted, perTaskMedians, selScore, ...(reason ? { reason } : {}) };
}

/** Pure median for an array of numbers. Returns 0 for empty array. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

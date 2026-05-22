/**
 * v0.40.2.0 — gbrain think trajectory injection contract.
 *
 * Confirms runThink:
 *   - Splices the <trajectory> block into the user prompt for temporal /
 *     knowledge_update intents.
 *   - Skips the block for 'other' intent (no SQL fires).
 *   - Honors `withTrajectory: false` opt + `think.trajectory_enabled`
 *     config flag as the kill switch.
 *   - Plays nicely with BOTH calibration mode AND default mode prompt
 *     placement (Codex Problem 6 — no third ordering invented).
 *   - Empty trajectory result → no "Known trajectory:" label cued.
 *
 * Hermetic, no DATABASE_URL, no API keys. Uses a stub ThinkLLMClient
 * that captures the user message so we can inspect what reached the model.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runThink, type ThinkLLMClient } from '../src/core/think/index.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();

  // Seed a people page so resolveEntitySlug returns 'exact_page' for marco.
  await engine.putPage('people/marco-example', {
    title: 'Marco Example',
    type: 'person',
    compiled_truth: 'Marco is a founder.',
  });

  // Seed metric + event facts on the same entity.
  await engine.executeRaw(`
    INSERT INTO facts (
      source_id, entity_slug, fact, kind, visibility,
      valid_from, source, source_session,
      claim_metric, claim_value, claim_unit, claim_period, event_type
    ) VALUES
      ('default', 'people/marco-example', 'role: engineer', 'fact', 'private',
       '2026-01-01T00:00:00Z', 'test', 'sess-1',
       'role', 1, NULL, NULL, NULL),
      ('default', 'people/marco-example', 'role: VP eng', 'fact', 'private',
       '2026-04-01T00:00:00Z', 'test', 'sess-2',
       'role', 2, NULL, NULL, NULL),
      ('default', 'people/marco-example', 'coffee meeting', 'event', 'private',
       '2026-05-15T00:00:00Z', 'test', 'sess-3',
       NULL, NULL, NULL, NULL, 'meeting')
  `);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

function captureClient(): { client: ThinkLLMClient; captured: { system: string; user: string }[] } {
  const captured: { system: string; user: string }[] = [];
  const client: ThinkLLMClient = {
    create: async (params) => {
      const userMsg = params.messages[0]?.content;
      captured.push({
        system: typeof params.system === 'string' ? params.system : '',
        user: typeof userMsg === 'string' ? userMsg : JSON.stringify(userMsg),
      });
      return {
        id: 'stub',
        type: 'message',
        role: 'assistant',
        model: 'stub',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        content: [{
          type: 'text',
          text: JSON.stringify({ answer: 'stubbed answer', citations: [], gaps: [] }),
        }],
      } as never;
    },
  };
  return { client, captured };
}

describe('runThink — trajectory injection happy path', () => {
  test('temporal intent → trajectory block appears in user message', async () => {
    const { client, captured } = captureClient();
    await runThink(engine, {
      question: 'When did Marco last switch jobs?',
      client,
    });
    expect(captured.length).toBe(1);
    expect(captured[0].user).toContain('Known trajectory:');
    expect(captured[0].user).toContain('<trajectory entity="people/marco-example"');
    expect(captured[0].user).toContain('superseded prior');  // knowledge_update annotation
  });

  test('"other" intent → no trajectory block', async () => {
    const { client, captured } = captureClient();
    await runThink(engine, {
      question: 'Summarize the deal pipeline',
      client,
    });
    expect(captured.length).toBe(1);
    expect(captured[0].user).not.toContain('Known trajectory:');
    expect(captured[0].user).not.toContain('<trajectory');
  });
});

describe('runThink — kill switches', () => {
  test('withTrajectory: false bypasses injection even for temporal intent', async () => {
    const { client, captured } = captureClient();
    await runThink(engine, {
      question: 'When did Marco last switch jobs?',
      client,
      withTrajectory: false,
    });
    expect(captured[0].user).not.toContain('Known trajectory:');
  });

  test('think.trajectory_enabled=false config bypasses injection', async () => {
    await engine.executeRaw(
      `INSERT INTO config (key, value) VALUES ('think.trajectory_enabled', 'false')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const { client, captured } = captureClient();
    await runThink(engine, {
      question: 'When did Marco last switch jobs?',
      client,
    });
    expect(captured[0].user).not.toContain('Known trajectory:');
    // Restore for subsequent tests
    await engine.executeRaw(`DELETE FROM config WHERE key = 'think.trajectory_enabled'`);
  });
});

describe('runThink — empty trajectory short-circuits', () => {
  test('entity that resolves but has no trajectory rows → no block', async () => {
    // Seed an entity page with NO facts. Question references it.
    await engine.putPage('people/empty-example', {
      title: 'Empty Example',
      type: 'person',
      compiled_truth: 'No facts here.',
    });
    const { client, captured } = captureClient();
    await runThink(engine, {
      question: 'When did empty last visit?',
      client,
    });
    // No facts → empty trajectory → no block emitted (no cue).
    // We can't strictly assert the block is absent because retrieval
    // might pull in Marco's page if "empty" matches anything in the
    // brain, but we can assert that IF a block exists it's not for Empty.
    if (captured[0].user.includes('Known trajectory:')) {
      expect(captured[0].user).not.toContain('entity="people/empty-example"');
    }
  });
});

describe('runThink — graceful degradation', () => {
  test('engine.findTrajectory throw is caught; think still returns', async () => {
    // Patch the engine to make findTrajectory throw briefly.
    const originalFn = engine.findTrajectory.bind(engine);
    (engine as { findTrajectory: typeof engine.findTrajectory }).findTrajectory = async () => {
      throw new Error('synthetic engine failure');
    };
    try {
      const { client, captured } = captureClient();
      const result = await runThink(engine, {
        question: 'When did Marco last switch jobs?',
        client,
      });
      // Think doesn't crash; trajectory block is empty.
      expect(captured.length).toBe(1);
      expect(captured[0].user).not.toContain('Known trajectory:');
      // Note: per-candidate findTrajectory call is wrapped in
      // Promise.allSettled, so the throw is swallowed silently. The
      // outer try/catch in runThink only fires on errors in the
      // orchestration code itself (e.g. import failures).
      expect(result.answer).toBe('stubbed answer');
    } finally {
      (engine as { findTrajectory: typeof engine.findTrajectory }).findTrajectory = originalFn;
    }
  });
});

describe('runThink — trajectory points count exposed via warnings', () => {
  test('successful injection records TRAJECTORY_INJECTED_*_POINTS warning', async () => {
    const { client } = captureClient();
    const result = await runThink(engine, {
      question: 'When did Marco last switch jobs?',
      client,
    });
    const trajectoryWarning = result.warnings.find(w => w.startsWith('TRAJECTORY_INJECTED_'));
    expect(trajectoryWarning).toBeDefined();
    // Marco has 3 facts (2 metric + 1 event); kind='all' returns all 3.
    expect(trajectoryWarning).toContain('3');
  });
});

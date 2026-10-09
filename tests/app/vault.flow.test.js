import { describe, expect, it } from 'vitest';
import { runPublish } from '../../src/components/vault/publishFlow.js';

const identity = { keyId: 'ab'.repeat(32), sign: async () => 'sig' };

function fakeResult() {
  return { docId: '1'.repeat(32), password: 'AAAA-BBBB-CCCC-DDDD-EEEE', version: 1 };
}

describe('runPublish', () => {
  it('walks the steps in order and returns the result', async () => {
    const seen = [];
    const out = await runPublish({
      file: { name: 'a.txt' },
      label: 'A',
      listed: true,
      identity,
      publish: async (args) => {
        expect(args.listed).toBe(true);
        expect(args.label).toBe('A');
        for (const id of ['read', 'derive', 'lock', 'upload', 'sign', 'publish']) args.onStep(id, `step ${id}`);
        return fakeResult();
      },
      onUpdate: (steps, text) => seen.push([steps.map((s) => s.status).join(','), text])
    });
    expect(out.ok).toBe(true);
    expect(out.result.version).toBe(1);
    expect(out.steps.every((s) => s.status === 'done')).toBe(true);
    expect(seen[0][0]).toBe('pending,pending,pending,pending,pending,pending');
    const derive = seen.find(([, text]) => text === 'step derive');
    expect(derive[0]).toBe('done,active,pending,pending,pending,pending');
    expect(seen[seen.length - 1][1]).toBe('Published');
  });

  it('passes listed as a strict boolean', async () => {
    let got = null;
    await runPublish({
      file: {},
      label: '',
      listed: 'yes',
      identity,
      publish: async (args) => {
        got = args.listed;
        return fakeResult();
      }
    });
    expect(got).toBe(false);
  });

  it('reports the failing step with plain advice and never throws', async () => {
    const err = Object.assign(new Error('boom'), { code: 'network' });
    const out = await runPublish({
      file: {},
      label: '',
      listed: false,
      identity,
      publish: async (args) => {
        args.onStep('read', 'Reading');
        args.onStep('derive', 'Deriving');
        args.onStep('lock', 'Locked');
        args.onStep('upload', 'Uploading');
        throw err;
      }
    });
    expect(out.ok).toBe(false);
    expect(out.failedStep).toBe('upload');
    expect(out.message).toMatch(/Could not reach the server/);
    expect(out.hint).toMatch(/no record was published/);
    expect(out.error).toBe(err);
    expect(out.steps.find((s) => s.id === 'upload').status).toBe('error');
    expect(out.steps.find((s) => s.id === 'publish').status).toBe('pending');
  });

  it('survives a broken screen update callback', async () => {
    const out = await runPublish({
      file: {},
      label: '',
      listed: false,
      identity,
      publish: async (args) => {
        args.onStep('read', 'x');
        return fakeResult();
      },
      onUpdate: () => {
        throw new Error('render failed');
      }
    });
    expect(out.ok).toBe(true);
  });

  it('fails cleanly when the publish function throws before any step', async () => {
    const out = await runPublish({
      file: null,
      identity,
      publish: async () => {
        throw new Error('choose a file first');
      }
    });
    expect(out.ok).toBe(false);
    expect(out.failedStep).toBe('read');
    expect(out.message).toBe('choose a file first');
  });

  it('ignores a step text that is not a string', async () => {
    const texts = [];
    await runPublish({
      file: {},
      identity,
      publish: async (args) => {
        args.onStep('read', 42);
        return fakeResult();
      },
      onUpdate: (_s, t) => texts.push(t)
    });
    expect(texts.every((t) => typeof t === 'string')).toBe(true);
  });
});

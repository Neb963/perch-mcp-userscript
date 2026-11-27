import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createCapacityHarness } from '../tests/integration/gateway-capacity-harness.js';
import { activateSyntheticNative, fixtureSnapshot, issueSyntheticToken, metricDelta, syntheticMcp } from '../tests/fixtures/optimization-client.js';
// Same 10240 decoded bytes and per-file outcomes. This measures gateway cost, not native-editor latency.
const h = await createCapacityHarness(1, { CANONICAL_STORAGE_MODE: 'native' }, { entryPoint: 'tests/fixtures/optimization-runtime.ts' });
try {
    const f = h.fixtures[0]!;
    const activated = await activateSyntheticNative(h, f);
    const token = await issueSyntheticToken(h, f);
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `scratch/file-${i}.txt`, encoding: 'utf8', content: String(i).repeat(1024) }));
    async function cycle(name: string, args: Record<string, unknown>, outcomes: {
        path: string;
        bytes: number;
    }[]) {
        const admitted = await syntheticMcp(h, f, token, name, args), operationId = String(admitted.operationId);
        const fetched = await h.browser(f, 'poll', { waitMs: 0 });
        assert.equal((fetched.operations as {
            operationId: string;
        }[])[0]?.operationId, operationId);
        await h.browser(f, 'reply', { operationId, phase: 'RUNNING' });
        await h.browser(f, 'reply', { operationId, phase: 'SUCCEEDED', result: { operationId, status: 'SUCCEEDED', effectState: 'VERIFIED', data: { outcomes, revision: 'synthetic-next-revision' } } });
        await syntheticMcp(h, f, token, 'operation_status', { operationId });
    }
    await cycle('write', { path: 'scratch/warm.txt', content: 'warm', expectedRevision: 'synthetic-base-revision' }, [{ path: 'scratch/warm.txt', bytes: 4 }]);
    async function measure(fn: () => Promise<void>) {
        const before = await fixtureSnapshot(h, f), at = performance.now();
        await fn();
        return { wallMs: performance.now() - at, usage: metricDelta(before, await fixtureSnapshot(h, f)) };
    }
    const individual = await measure(async () => {
        for (const file of files)
            await cycle('write', { path: file.path, content: file.content, expectedRevision: 'synthetic-base-revision' }, [{ path: file.path, bytes: 1024 }]);
    });
    const batch = await measure(() => cycle('put_files', { files, expectedRevision: 'synthetic-base-revision' }, files.map(file => ({ path: file.path, bytes: 1024 }))));
    const total = (sample: typeof batch, dimension: 'reads' | 'writes') => {
        const key = dimension === 'reads' ? 'sqlReads' : 'sqlWrites';
        const registry = sample.usage.registry?.[key], workspace = sample.usage.workspace?.[key];
        assert.ok(typeof registry === 'number' && Number.isFinite(registry), 'Registry SQL metric is unavailable');
        assert.ok(typeof workspace === 'number' && Number.isFinite(workspace), 'Workspace SQL metric is unavailable');
        return registry + workspace;
    };
    assert.ok(total(batch, 'reads') < total(individual, 'reads'));
    assert.ok(total(batch, 'writes') < total(individual, 'writes'));
    const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0, runtime: 'Miniflare4.20260730.0/workerd1.20260730.1', activated, fixture: { files: 10, decodedBytes: 10240, tool: 'put_files', bounds: '64 files / 256 KiB; mandatory expectedRevision; WRITE_SOURCE; existing per-item outcomes; no new RPC' }, measurement: 'actual local OAuth/MCP HTTP + Registry/Workspace lifecycle, RUNNING, terminal receipt, one status retrieval each; synthetic browser results, all external traffic denied; startup/migration/OAuth excluded', individual, batch, totals: { individual: { reads: total(individual, 'reads'), writes: total(individual, 'writes') }, batch: { reads: total(batch, 'reads'), writes: total(batch, 'writes') } } };
    const output = process.argv[2] ?? '/tmp/perch-batch-benchmark.json';
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output, totals: report.totals }));
}
finally {
    await h.close();
}

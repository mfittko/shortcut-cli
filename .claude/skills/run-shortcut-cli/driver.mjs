#!/usr/bin/env node
/**
 * Driver for shortcut-cli: boots the same Prism mock the test suite uses
 * (spec-driven, deterministic responses) and runs the built CLI against it.
 *
 * Run from the repo root, after `pnpm install` and `pnpm build`:
 *
 *   node .claude/skills/run-shortcut-cli/driver.mjs smoke        # sweep + assertions vs mock
 *   node .claude/skills/run-shortcut-cli/driver.mjs smoke --live # read-only sweep vs LIVE API
 *   node .claude/skills/run-shortcut-cli/driver.mjs mock         # foreground mock server
 *   node .claude/skills/run-shortcut-cli/driver.mjs run -- search -t foo -q
 *                                                                # one CLI command vs mock
 *
 * Live mode uses your real credentials (SHORTCUT_API_TOKEN env or
 * ~/.config/shortcut-cli/config.json) and only ever READS — no create/update.
 * Mock port defaults to 4013 (vitest owns 4010); override with PRISM_PORT.
 */
import { execFile } from 'child_process';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SPEC_PATH = path.join(REPO_ROOT, 'test/fixtures/shortcut.swagger.json');
const CLI = path.join(REPO_ROOT, 'build/bin/short.js');
const PORT = Number(process.env.PRISM_PORT || 4013);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function startMock() {
    const { getHttpOperationsFromSpec } = await import('@stoplight/prism-http');
    const { createServer } = await import('@stoplight/prism-http-server');
    const pino = (await import('pino')).default;
    const operations = await getHttpOperationsFromSpec(SPEC_PATH);
    const server = createServer(operations, {
        cors: true,
        config: {
            checkSecurity: false,
            validateRequest: false,
            validateResponse: false,
            mock: { dynamic: false },
            errors: false,
            upstreamProxy: undefined,
            isProxy: false,
        },
        components: { logger: pino({ level: 'silent', customLevels: { success: 32 } }) },
    });
    await server.listen(PORT, '127.0.0.1');
    return server;
}

function runCli(args, envOverrides = {}, { live = false } = {}) {
    // live: real credentials, real API. mock: fake credentials, Prism, isolated config dir.
    const env = live
        ? { ...process.env, ...envOverrides }
        : {
              ...process.env,
              SHORTCUT_API_TOKEN: 'driver-token',
              SHORTCUT_URL_SLUG: 'driver-workspace',
              SHORTCUT_MENTION_NAME: 'driver-user',
              SHORTCUT_API_BASE_URL: BASE_URL,
              // isolate from any real ~/.config/shortcut-cli
              XDG_CONFIG_HOME: mkdtempSync(path.join(os.tmpdir(), 'short-driver-')),
              ...envOverrides,
          };
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [CLI, ...args],
            {
                cwd: REPO_ROOT,
                timeout: 30_000,
                env,
            },
            (error, stdout, stderr) => {
                resolve({
                    // error.code can be a string (e.g. ENOENT on spawn failure) — only trust numbers
                    exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
                    stdout: String(stdout ?? ''),
                    stderr: String(stderr ?? ''),
                });
            }
        );
    });
}

const CHECKS = [
    {
        name: 'workflows list',
        args: ['workflows'],
        expect: (r) => r.exitCode === 0 && r.stdout.trim().length > 0,
    },
    { name: 'epics list', args: ['epics'], expect: (r) => r.exitCode === 0 },
    // -d: the Prism mock's canned member is disabled:true, and the CLI hides disabled members by default
    {
        name: 'members list',
        args: ['members', '-d'],
        expect: (r) => r.exitCode === 0 && r.stdout.trim().length > 0,
    },
    {
        name: 'story view',
        args: ['story', '123'],
        expect: (r) => r.exitCode === 0 && /#\d+/.test(r.stdout),
    },
    {
        name: 'story view as JSON (%j)',
        args: ['story', '123', '-f', '%j'],
        expect: (r) => r.exitCode === 0 && Boolean(JSON.parse(r.stdout)),
    },
    { name: 'search', args: ['search', '-t', 'foo', '-q'], expect: (r) => r.exitCode === 0 },
    // NOTE: operator search (`search 'state:started'`) is deliberately absent: the mock's
    // canned /search/stories response has next:"string", which makes pagination loop forever.
    { name: 'iterations list', args: ['iterations'], expect: (r) => r.exitCode === 0 },
    // -a: the mock's canned team is archived:true, and the CLI hides archived teams by default
    {
        name: 'teams list',
        args: ['teams', '-a'],
        expect: (r) => r.exitCode === 0 && r.stdout.trim().length > 0,
    },
    { name: 'labels list', args: ['labels'], expect: (r) => r.exitCode === 0 },
    // -s 1: the mock's canned workflow state id; create resolves the state before POSTing
    {
        name: 'create story',
        args: ['create', '-t', 'Driver test', '-s', '1'],
        expect: (r) => r.exitCode === 0 && r.stdout.includes('#1'),
    },
    {
        name: 'story update (comment)',
        args: ['story', '123', '-c', 'driver comment', '-f', '%id'],
        expect: (r) => r.exitCode === 0 && r.stdout.trim().length > 0,
    },
    {
        name: 'raw api GET → JSON',
        args: ['api', '/member'],
        expect: (r) => r.exitCode === 0 && Boolean(JSON.parse(r.stdout)),
    },
    {
        name: 'raw api POST → JSON',
        args: [
            'api',
            '/stories',
            '-X',
            'POST',
            '-f',
            'name=Driver story',
            '-f',
            'workflow_state_id=1',
        ],
        expect: (r) => r.exitCode === 0 && Boolean(JSON.parse(r.stdout)),
    },
    {
        name: 'missing token → exit 11',
        args: ['members'],
        env: { SHORTCUT_API_TOKEN: '' },
        expect: (r) => r.exitCode === 11,
    },
];

// READ-ONLY live sweep: proves auth + reads + server-side search against the real API.
// Deliberately no create/update — this runs against a real workspace.
const LIVE_CHECKS = [
    {
        name: 'identity (api /member)',
        args: ['api', '/member'],
        expect: (r) => r.exitCode === 0 && Boolean(JSON.parse(r.stdout).mention_name),
    },
    {
        name: 'workflows list',
        args: ['workflows'],
        expect: (r) => r.exitCode === 0 && r.stdout.trim().length > 0,
    },
    { name: 'epics list', args: ['epics'], expect: (r) => r.exitCode === 0 },
    {
        name: 'members list',
        args: ['members', '-d'],
        expect: (r) => r.exitCode === 0 && r.stdout.trim().length > 0,
    },
    {
        name: 'server-side operator search (bounded)',
        args: ['api', '/search/stories', '-f', 'query=is:story', '-f', 'page_size=1'],
        expect: (r) => r.exitCode === 0 && Array.isArray(JSON.parse(r.stdout).data),
    },
];

async function smoke(live) {
    let server = null;
    let checks = CHECKS;
    if (live) {
        checks = LIVE_CHECKS;
        console.log('[driver] LIVE mode: read-only sweep against the real Shortcut API');
    } else {
        server = await startMock();
        console.log(`[driver] Prism mock listening on ${BASE_URL}`);
    }
    let failed = 0;
    try {
        for (const check of checks) {
            const r = await runCli(check.args, check.env ?? {}, { live });
            let ok = false;
            try {
                ok = check.expect(r);
            } catch {
                ok = false;
            }
            console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.name}  (exit ${r.exitCode})`);
            if (!ok) {
                failed++;
                console.log(`      stdout: ${r.stdout.slice(0, 300)}`);
                console.log(`      stderr: ${r.stderr.slice(0, 300)}`);
            }
        }
    } finally {
        if (server) await server.close();
    }
    console.log(
        failed === 0
            ? '[driver] smoke: all checks passed'
            : `[driver] smoke: ${failed} check(s) FAILED`
    );
    process.exit(failed === 0 ? 0 : 1);
}

async function main() {
    const [mode, ...rest] = process.argv.slice(2);
    if (mode === 'smoke') return smoke(rest.includes('--live'));
    if (mode === 'mock') {
        await startMock();
        console.log(`[driver] Prism mock listening on ${BASE_URL} (Ctrl-C to stop)`);
        return; // server keeps the event loop alive
    }
    if (mode === 'run') {
        const args = rest[0] === '--' ? rest.slice(1) : rest;
        const server = await startMock();
        const r = await runCli(args);
        await server.close();
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
        process.exit(r.exitCode);
    }
    console.error('Usage: driver.mjs <smoke|mock|run -- <cli args...>>');
    process.exit(2);
}

main();

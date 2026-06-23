// Deploy-layer spawner for the web UI installer.
//
// Runs ONE deploy layer by invoking the existing deploy-all.sh in single-layer
// mode (`--only <key>`), with WAUI=1 so it emits @@WAUI@@ progress markers. We
// never reimplement the CDK deploy - the script remains authoritative. Each
// output line is classified (marker vs plain log) and forwarded to onEvent.
//
// A mock mode (no AWS, no child process) emits synthetic markers so the UI can
// be exercised end to end without deploying anything.

import { spawn } from 'node:child_process';
import { classifyLine } from './markers.mjs';

/**
 * Spawn one real deploy layer.
 * @param {string} key  deploy-all.sh component key (e.g. "wa-gateway")
 * @param {object} opts { repoRoot, deployScript, onEvent }
 *   onEvent receives: {kind:'marker', event} | {kind:'log', key, line} | {kind:'exit', key, code}
 * @returns {Promise<number>} resolves with the child exit code
 */
export function spawnLayer(key, { repoRoot, deployScript, onEvent }) {
  return new Promise((resolve) => {
    // Argument array - operator input is never interpolated into a shell string.
    const args = [deployScript, '--only', key, '--yes', '--skip-preflight'];
    const child = spawn('bash', args, {
      cwd: repoRoot,
      env: { ...process.env, WAUI: '1' },
    });

    const pump = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line === '') continue;
        const c = classifyLine(line);
        if (c.kind === 'marker') onEvent({ kind: 'marker', event: c.event });
        else onEvent({ kind: 'log', key, line: c.line });
      }
    };

    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', (err) => {
      onEvent({ kind: 'log', key, line: `installer: failed to spawn deploy: ${err.message}` });
      onEvent({ kind: 'marker', event: { type: 'layer', key, state: 'fail' } });
      resolve(1);
    });
    child.on('close', (code) => {
      onEvent({ kind: 'exit', key, code: code ?? 0 });
      resolve(code ?? 0);
    });
  });
}

/**
 * Emit synthetic events for a layer without touching AWS. Used by --mock so the
 * UI flow can be demoed/tested offline.
 */
export function mockLayer(key, { onEvent, stepMs = 500 }) {
  return new Promise((resolve) => {
    onEvent({ kind: 'marker', event: { type: 'layer', key, state: 'start' } });
    const logs = [
      `[mock] synthesizing ${key} ...`,
      `[mock] deploying ${key} ...`,
      `[mock] ${key} stack UPDATE_COMPLETE`,
    ];
    let i = 0;
    const tick = () => {
      if (i < logs.length) {
        onEvent({ kind: 'log', key, line: logs[i++] });
        setTimeout(tick, stepMs);
      } else {
        onEvent({ kind: 'marker', event: { type: 'layer', key, state: 'done' } });
        onEvent({ kind: 'exit', key, code: 0 });
        resolve(0);
      }
    };
    setTimeout(tick, stepMs);
  });
}

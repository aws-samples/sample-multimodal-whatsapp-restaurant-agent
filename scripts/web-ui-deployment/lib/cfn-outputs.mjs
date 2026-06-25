// Transform a CloudFormation describe-stacks Outputs array into the exact shape
// `cdk deploy --outputs-file` writes: { "<StackName>": { "<OutputKey>": "<OutputValue>" } }.
// Used by deploy-all.sh's drift self-heal (ensure_layer_outputs) to re-hydrate a
// missing cdk-outputs/*.json from the live stack. Pure + dependency-free.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function outputsToObject(stack, outputs) {
  const obj = { [stack]: {} };
  for (const o of (outputs || [])) {
    if (o && o.OutputKey != null) obj[stack][o.OutputKey] = o.OutputValue;
  }
  return obj;
}

// CLI: node cfn-outputs.mjs <stack> <outFile>
// Reads the Outputs JSON array on stdin, writes the cdk-shaped file, and exits
// non-zero if the resulting stack object is empty (no outputs to hydrate).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [stack, outFile] = process.argv.slice(2);
  let buf = '';
  process.stdin.on('data', (c) => (buf += c));
  process.stdin.on('end', () => {
    let outs; try { outs = JSON.parse(buf || 'null'); } catch { outs = null; }
    const obj = outputsToObject(stack, outs);
    try { writeFileSync(outFile, JSON.stringify(obj, null, 2)); } catch (e) {
      process.stderr.write(`cfn-outputs: ${e.message}\n`); process.exit(2);
    }
    process.exit(Object.keys(obj[stack]).length ? 0 : 1);
  });
}

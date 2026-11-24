import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenarios = [
  ['benchmark-run.mjs'],
  ['authority-facts.mjs'],
  ['failure-diagnostics.mjs'],
];

for (const [file, ...arguments_] of scenarios) {
  await run(fileURLToPath(new URL(file, import.meta.url)), arguments_);
}

function run(file, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...arguments_], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} failed${signal === null ? ` with exit code ${code}` : ` from ${signal}`}`));
    });
  });
}

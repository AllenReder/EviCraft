import { runCli } from "./harness-cli.js";

void runCli().then((code) => {
  process.exitCode = code;
}).catch(() => {
  process.stderr.write("Harness bootstrap failed unexpectedly\n");
  process.exitCode = 1;
});

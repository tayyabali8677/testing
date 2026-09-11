// Test entry point: node tests/run.js
//
// Set VERBOSE=1 for stack traces on failure.

import { run } from "./harness.js";

import "./mathx.test.js";
import "./city.test.js";
import "./vehicle.test.js";

const ok = await run();
process.exit(ok ? 0 : 1);

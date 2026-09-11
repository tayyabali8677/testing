// Minimal assertion + suite runner. No dependencies, no watch mode, no config.

let current = null;
const suites = [];

export function suite(name, fn) {
  suites.push({ name, fn });
}

export function test(name, fn) {
  if (!current) throw new Error("test() called outside a suite");
  current.tests.push({ name, fn });
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

export function equal(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      `${msg || "not equal"}: got ${JSON.stringify(actual)}, ` +
      `expected ${JSON.stringify(expected)}`
    );
  }
}

export function close(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(
      `${msg || "not close"}: got ${actual}, expected ${expected} +/- ${tol}`
    );
  }
}

export function finite(value, msg) {
  if (!Number.isFinite(value)) {
    throw new Error(`${msg || "value"} is not finite: ${value}`);
  }
}

export function throws(fn, msg) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg || "expected a throw");
}

export async function run() {
  let passed = 0, failed = 0;
  const failures = [];

  for (const s of suites) {
    current = { tests: [] };
    s.fn();
    const tests = current.tests;
    current = null;

    console.log(`\n${s.name}`);
    for (const t of tests) {
      const started = Date.now();
      try {
        await t.fn();
        const ms = Date.now() - started;
        console.log(`  ok    ${t.name}${ms > 40 ? `  (${ms}ms)` : ""}`);
        passed++;
      } catch (err) {
        console.log(`  FAIL  ${t.name}`);
        console.log(`        ${err.message}`);
        failures.push({ suite: s.name, test: t.name, err });
        failed++;
      }
    }
  }

  console.log(`\n${"-".repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);

  if (failed) {
    console.log("\nfailures:");
    for (const f of failures) {
      console.log(`  ${f.suite} > ${f.test}`);
      if (process.env.VERBOSE) console.log(f.err.stack);
    }
  }
  return failed === 0;
}

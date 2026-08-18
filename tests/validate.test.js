'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runElfBinary, runSuite } = require('../tools/validate.js');

const ROOT = path.join(__dirname, '..');
const THIRD_PARTY = path.join(ROOT, 'third_party');
const hasThirdParty = fs.existsSync(THIRD_PARTY);
const skip = hasThirdParty ? false : 'third_party test binaries not present (skipping validation)';

const RISCV_TESTS = path.join(THIRD_PARTY, 'riscv-tests-bin');
const SAIL_ROOT = path.join(THIRD_PARTY, 'sail-riscv-tests', 'sail-rv32-max', 'elfs', 'rv32i');

function assertClean(result) {
  assert.equal(result.fail, 0, result.results.filter((r) => r.status !== 'pass')
    .map((r) => `${r.file}: ${r.status}${r.tohost !== null ? ' tohost=' + r.tohost : ''}${r.error ? ' ' + r.error : ''}`).join('; '));
  assert.equal(result.timeout, 0);
  assert.equal(result.crash, 0);
  assert.ok(result.pass > 0, 'expected at least one passing test');
}

function runRiscvTests(prefix) {
  const dir = RISCV_TESTS;
  if (!fs.existsSync(dir)) return { missing: true };
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .sort();
  const results = files.map((f) => ({ file: f, ...runElfBinary(path.join(dir, f)) }));
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const timeout = results.filter((r) => r.status === 'timeout').length;
  const crash = results.filter((r) => r.status === 'crash').length;
  return { files, results, pass, fail, timeout, crash };
}

test('riscv-tests: rv32ui-p (42 binaries)', { timeout: 300000, skip }, () => {
  const r = runRiscvTests('rv32ui-p-');
  assertClean(r);
});

test('riscv-tests: rv32um-p (8 binaries)', { timeout: 300000, skip }, () => {
  const r = runRiscvTests('rv32um-p-');
  assertClean(r);
});

test('arch-test: rv32i/I (39 binaries)', { timeout: 600000, skip }, () => {
  assertClean(runSuite(path.join(SAIL_ROOT, 'I')));
});

test('arch-test: rv32i/M (8 binaries)', { timeout: 300000, skip }, () => {
  assertClean(runSuite(path.join(SAIL_ROOT, 'M')));
});

test('arch-test: rv32i/Zicsr (6 binaries)', { timeout: 300000, skip }, () => {
  assertClean(runSuite(path.join(SAIL_ROOT, 'Zicsr')));
});

test('arch-test: rv32i/Zifencei (1 binary)', { timeout: 300000, skip }, () => {
  assertClean(runSuite(path.join(SAIL_ROOT, 'Zifencei')));
});
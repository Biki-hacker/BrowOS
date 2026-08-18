'use strict';

const fs = require('fs');
const path = require('path');
const { Bus } = require('./mem.js');
const { Cpu } = require('./cpu.js');
const { readElf, loadSegments } = require('./elf.js');

const DEFAULT_BUS_SIZE = 0x10000000; // 256 MiB
const DEFAULT_MAX_STEPS = 20000000;

const TEST_SKIPS = {
  'rv32si-p-dirty': 'requires Sv32 MMU + PTE A/D tracking (Phase 5)',
};

function findSymbol(elf, name) {
  const s = elf.symbols[name];
  return s ? s.value : undefined;
}

function installDeviceWindow(bus, elf) {
  let lo = 0xFFFFFFFF, hi = 0;
  for (const s of elf.segments) {
    const a = s.vaddr >>> 0;
    const e = (a + Math.max(s.filesz, s.memsz)) >>> 0;
    if (a < lo) lo = a;
    if (e > hi) hi = e;
  }
  const inRam = (a) => {
    const u = a >>> 0;
    return u >= lo && u < hi;
  };
  const wrapRead = (method) => {
    const orig = bus[method].bind(bus);
    bus[method] = (addr, ...rest) => {
      if (!inRam(addr)) return 0;
      return orig(addr, ...rest);
    };
  };
  const wrapWrite = (method) => {
    const orig = bus[method].bind(bus);
    bus[method] = (addr, ...rest) => {
      if (!inRam(addr)) return;
      return orig(addr, ...rest);
    };
  };
  wrapRead('read8');
  wrapRead('read16');
  wrapRead('read32');
  wrapWrite('write8');
  wrapWrite('write16');
  wrapWrite('write32');
}

function runElfBinary(filePath, opts = {}) {
  const bytes = fs.readFileSync(filePath);
  const elf = readElf(bytes);
  const offset = Math.min(...elf.segments.map((s) => s.vaddr));
  const bus = new Bus(opts.busSize || DEFAULT_BUS_SIZE, offset);
  loadSegments(bus, bytes, elf);
  installDeviceWindow(bus, elf);

  const tohost = findSymbol(elf, 'tohost');
  const fromhost = findSymbol(elf, 'fromhost');

  let tohostValue = null;
  let pending = null;
  let cpuTrace = opts.trace || null;
  const tohostAddr = tohost !== undefined ? (tohost >>> 0) : undefined;
  const fromhostAddr = tohostAddr !== undefined ? (tohostAddr + 4) >>> 0 : undefined;
  if (tohostAddr !== undefined) {
    const origWrite32 = bus.write32.bind(bus);
    cpuTrace = (c, inst) => {
      if (opts.trace) opts.trace(c, inst);
      if (pending && c.instCount >= pending.resolveStep) {
        const p = pending;
        pending = null;
        if (p.value === 1 || (p.value & 1)) {
          tohostValue = p.value;
          c.stop();
        }
      }
    };
    bus.write32 = (addr, v) => {
      const a = addr >>> 0;
      if (a === tohostAddr) {
        pending = { value: v | 0, resolveStep: cpu.instCount + 8 };
        return;
      }
      if (a === fromhostAddr) {
        const p = pending;
        pending = null;
        if (p && (v >>> 0) !== 0x1010000) {
          tohostValue = p.value;
          cpu.stop();
        }
        return;
      }
      origWrite32(addr, v);
    };
  }
  const cpu = new Cpu(bus, { pc: elf.entry, trace: cpuTrace });

  let result;
  try {
    result = cpu.run(opts.maxSteps || DEFAULT_MAX_STEPS);
  } catch (err) {
    return {
      status: 'crash',
      error: String(err && err.message || err),
      tohost: tohostValue,
      instCount: cpu.instCount,
      pc: cpu.pc,
    };
  }

  if (tohostValue !== null) {
    return {
      status: tohostValue === 1 ? 'pass' : 'fail',
      tohost: tohostValue,
      instCount: cpu.instCount,
      steps: result.instCount,
      pc: cpu.pc,
      priv: cpu.priv,
      halted: result.halted,
      haltReason: result.reason,
    };
  }
  return {
    status: 'timeout',
    tohost: null,
    instCount: cpu.instCount,
    steps: result.instCount,
    pc: cpu.pc,
    halted: result.halted,
    haltReason: result.reason,
  };
}

function runSuite(dir, opts = {}) {
  if (!fs.existsSync(dir)) {
    return { missing: true, dir };
  }
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.elf'))
    .sort();
  const results = [];
  for (const f of files) {
    const r = runElfBinary(path.join(dir, f), opts);
    results.push({ file: f, ...r });
  }
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const timeout = results.filter((r) => r.status === 'timeout').length;
  const crash = results.filter((r) => r.status === 'crash').length;
  return { dir, files, results, pass, fail, timeout, crash };
}

function reportSuite(suite) {
  console.log('\n=== ' + suite.dir + ' ===');
  if (suite.missing) {
    console.log('  (missing directory)');
    return;
  }
  console.log('  pass: ' + suite.pass + '  fail: ' + suite.fail +
    '  timeout: ' + suite.timeout + '  crash: ' + suite.crash +
    '  (of ' + suite.files.length + ')');
  for (const r of suite.results) {
    if (r.status !== 'pass') {
      console.log('  [' + r.status + '] ' + r.file +
        (r.tohost !== null ? ' tohost=' + r.tohost : '') +
        (r.pc !== undefined ? ' pc=0x' + (r.pc >>> 0).toString(16) : '') +
        (r.error ? ' error=' + r.error : ''));
    }
  }
}

module.exports = { runElfBinary, runSuite, reportSuite, TEST_SKIPS };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('usage: node tools/validate.js <dir-or-glob> [--all]');
    process.exit(1);
  }
  for (const arg of args) {
    const isGlob = arg.includes('*');
    if (isGlob) {
      const dir = path.dirname(arg);
      const pattern = path.basename(arg)
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      const re = new RegExp('^' + pattern + '$');
      const files = fs.readdirSync(dir).filter((f) => re.test(f)).sort();
      const results = [];
      for (const f of files) {
        if (TEST_SKIPS[f]) {
          results.push({ file: f, status: 'skip', reason: TEST_SKIPS[f] });
          console.log('[skip] ' + f + ' (' + TEST_SKIPS[f] + ')');
          continue;
        }
        const r = runElfBinary(path.join(dir, f),
          { priv: f.startsWith('rv32si') ? 1 : 3 });
        results.push({ file: f, ...r });
        console.log('[' + r.status + '] ' + f +
          (r.tohost !== null ? ' tohost=' + r.tohost : '') +
          (r.error ? ' error=' + r.error : ''));
      }
      const pass = results.filter((r) => r.status === 'pass').length;
      const skip = results.filter((r) => r.status === 'skip').length;
      console.log('  -> pass ' + pass + ' / ' + results.length +
        (skip ? ' (skip ' + skip + ')' : ''));
    } else if (arg.endsWith('.elf') || fs.statSync(arg).isFile()) {
      const r = runElfBinary(arg);
      console.log(JSON.stringify(r, null, 2));
    } else {
      reportSuite(runSuite(arg));
    }
  }
}
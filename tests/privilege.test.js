'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Cpu } = require('../tools/cpu.js');
const { Bus } = require('../tools/mem.js');
const { assemble } = require('../tools/asm.js');

const MSTATUS_SIE = 1 << 1;
const MSTATUS_MIE = 1 << 3;
const MSTATUS_SPIE = 1 << 5;
const MSTATUS_MPIE = 1 << 7;
const MSTATUS_SPP = 1 << 8;
const MSTATUS_MPP = 3 << 11;
const MSTATUS_SUM = 1 << 18;
const MSTATUS_MXR = 1 << 19;
const SSTATUS_VISIBLE = MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP | MSTATUS_SUM | MSTATUS_MXR;

const INT_SSI = 1, INT_MSI = 3, INT_STI = 5, INT_MTI = 7, INT_SEI = 9, INT_MEI = 11;
const MIP_SSIP = 1 << INT_SSI, MIP_MSIP = 1 << INT_MSI, MIP_STIP = 1 << INT_STI,
      MIP_MTIP = 1 << INT_MTI, MIP_SEIP = 1 << INT_SEI, MIP_MEIP = 1 << INT_MEI;
const S_IRQ_MASK = MIP_SSIP | MIP_STIP | MIP_SEIP;

const CLINT_MSIP = 0x02000000;
const CLINT_MTIMECMP = 0x02004000;
const CLINT_MTIME = 0x0200BFF8;

const PRIV_U = 0, PRIV_S = 1, PRIV_M = 3;

function setMtimecmp(bus, lo) {
  bus.write32(CLINT_MTIMECMP + 4, 0);
  bus.write32(CLINT_MTIMECMP, lo);
}

function loadElf(bus, bytes) {
  const e_phoff = bytes.readUInt32LE(28);
  const e_phentsize = bytes.readUInt16LE(42);
  const e_phnum = bytes.readUInt16LE(44);
  for (let i = 0; i < e_phnum; i++) {
    const ph = e_phoff + i * e_phentsize;
    if (bytes.readUInt32LE(ph) !== 1) continue;
    const off = bytes.readUInt32LE(ph + 4);
    const vaddr = bytes.readUInt32LE(ph + 8);
    const filesz = bytes.readUInt32LE(ph + 16);
    const memsz = bytes.readUInt32LE(ph + 20);
    bus.load(vaddr, bytes.subarray(off, off + filesz));
    if (memsz > filesz) bus.data.fill(0, vaddr + filesz, vaddr + memsz);
  }
}

function make(asm, opts = {}) {
  const r = assemble(asm);
  const bus = new Bus(1 << 20);
  loadElf(bus, r.bytes);
  const cpu = new Cpu(bus, { pc: opts.pc !== undefined ? opts.pc : r.entry || 0x10000, ...opts });
  return { cpu, bus, r };
}

function execAsm(asm, n, opts = {}) {
  const m = make(asm, opts);
  const summary = m.cpu.run(n);
  return { ...m, summary };
}

function handlerAsm(handlerBody = 'nop\n') {
  return `
la x5, handler
csrrw x0, mtvec, x5
${handlerBody}
handler:
csrrs x7, mepc, x0
csrrs x8, mcause, x0
nop
`;
}

test('ecall cause depends on privilege mode', () => {
  for (const [priv, cause] of [[PRIV_M, 11], [PRIV_S, 9], [PRIV_U, 8]]) {
    const { cpu } = make(handlerAsm('ecall\n'));
    cpu.run(3);
    cpu.priv = priv;
    cpu.run(2);
    assert.strictEqual(cpu.csr('mcause'), cause, `priv=${priv}`);
    assert.strictEqual(cpu.csr('mepc'), 0x1000C);
    assert.strictEqual(cpu.priv, PRIV_M);
  }
});

test('sret restores pc from sepc and priv from SPP', () => {
  const { cpu } = execAsm(`
li x5, 0x10018
csrrw x0, sepc, x5
li x5, 256
csrrw x0, sstatus, x5
sret
nop
`, 6);
  assert.strictEqual(cpu.pc, 0x10018);
  assert.strictEqual(cpu.priv, PRIV_S);
});

test('mret restores pc from mepc and priv from MPP', () => {
  const { cpu } = execAsm(`
li x5, 0x10018
csrrw x0, mepc, x5
li x6, 0x800
csrrw x0, mstatus, x6
mret
nop
`, 7);
  assert.strictEqual(cpu.pc, 0x10018);
  assert.strictEqual(cpu.priv, PRIV_S);
});

test('trap entry from U saves CSRs and switches to M', () => {
  const { cpu } = make(`
la x5, handler
csrrw x0, mtvec, x5
.word 0x00000000
addi x6, x0, 99
handler:
csrrs x7, mepc, x0
csrrs x8, mcause, x0
nop
`);
  cpu.run(3);
  cpu.priv = PRIV_U;
  cpu.run(3);
  assert.strictEqual(cpu.x[7], 0x1000C);
  assert.strictEqual(cpu.x[8], 2);
  assert.strictEqual(cpu.priv, PRIV_M);
});

test('trap with no mtvec halts regardless of source privilege', () => {
  const { cpu } = make('ecall\n');
  cpu.priv = PRIV_U;
  const s = cpu.run(1);
  assert.strictEqual(s.halted, true);
  assert.strictEqual(s.reason, 'trap');
  assert.strictEqual(s.info.cause, 8);
});

test('misa write never traps: WARL clears unsupported bits', () => {
  const { cpu } = execAsm(`
addi x6, x0, 1
csrrw x0, misa, x6
csrrs x7, misa, x0
addi x6, x0, 0
csrrw x0, misa, x6
csrrs x8, misa, x0
nop
`, 7);
  assert.strictEqual(cpu.x[7], 0x40001100);
  assert.strictEqual(cpu.x[8], 0x40001100);
});

test('wfi is a no-op for now', () => {
  const { cpu } = execAsm('wfi\naddi x5, x0, 1\nnop\n', 3);
  assert.strictEqual(cpu.x[5], 1);
  assert.strictEqual(cpu.pc, 0x1000C);
});

test('mstatus/mie/mip are writable M-mode CSRs', () => {
  const { cpu } = execAsm(`
li x5, 0x80
csrrw x0, mie, x5
csrrs x6, mie, x0
li x5, 0xA02
csrrw x0, mip, x5
csrrs x7, mip, x0
nop
`, 7);
  assert.strictEqual(cpu.x[6], 0x80);
  assert.strictEqual(cpu.x[7], 0xA02);
});

test('interrupt bit set in mcause when trap is an interrupt', () => {
  const { cpu, bus } = make(handlerAsm('nop\n'));
  cpu.csrWrite(0x300, MSTATUS_MIE);
  cpu.csrWrite(0x304, MIP_MSIP);
  cpu.run(3);
  bus.write32(CLINT_MSIP, 1);
  cpu.run(2);
  assert.strictEqual(cpu.csr('mcause'), 0x80000000 | INT_MSI);
});

test('pending interrupt is not taken while global MIE is clear', () => {
  const { cpu, bus } = make(handlerAsm('nop\n'));
  bus.write32(CLINT_MSIP, 1);
  cpu.run(3);
  assert.strictEqual(cpu.csr('mcause'), 0);
  assert.strictEqual(cpu.pc, 0x1000C);
});

test('pending interrupt is taken when MIE is set', () => {
  const { cpu, bus } = make(handlerAsm('nop\n'));
  cpu.csrWrite(0x300, MSTATUS_MIE);
  cpu.csrWrite(0x304, MIP_MSIP);
  cpu.run(3);
  bus.write32(CLINT_MSIP, 1);
  cpu.run(2);
  assert.strictEqual(cpu.csr('mcause'), 0x80000000 | INT_MSI);
  assert.strictEqual(cpu.csr('mepc'), 0x1000C);
});

test('interrupt from S or U traps to M even with MIE clear', () => {
  const { cpu, bus } = make(handlerAsm('nop\n'));
  cpu.csrWrite(0x304, MIP_MSIP);
  cpu.run(3);
  cpu.priv = PRIV_U;
  bus.write32(CLINT_MSIP, 1);
  cpu.run(2);
  assert.strictEqual(cpu.csr('mcause'), 0x80000000 | INT_MSI);
  assert.strictEqual(cpu.priv, PRIV_M);
});

test('trap entry saves MIE into MPIE and clears MIE', () => {
  const { cpu } = execAsm(`
la x5, handler
csrrw x0, mtvec, x5
csrrsi x0, mstatus, 8
ecall
nop
handler:
csrrs x7, mstatus, x0
nop
`, 7);
  assert.strictEqual(cpu.x[7] & MSTATUS_MIE, 0);
  assert.strictEqual(cpu.x[7] & MSTATUS_MPIE, MSTATUS_MPIE);
  assert.strictEqual((cpu.x[7] & MSTATUS_MPP) >>> 11, PRIV_M);
});

test('trap entry records previous privilege in MPP', () => {
  const { cpu } = make(handlerAsm('ecall\n'));
  cpu.run(3);
  cpu.priv = PRIV_U;
  cpu.run(2);
  assert.strictEqual((cpu.csr('mstatus') & MSTATUS_MPP) >>> 11, PRIV_U);
});

test('mret restores MIE from MPIE and sets MPP to U', () => {
  const { cpu } = execAsm(`
li x5, 0x1888
csrrw x0, mstatus, x5
li x5, 0x10018
csrrw x0, mepc, x5
mret
nop
`, 7);
  assert.strictEqual(cpu.pc, 0x10018);
  assert.strictEqual(cpu.csr('mstatus') & MSTATUS_MIE, MSTATUS_MIE);
  assert.strictEqual(cpu.csr('mstatus') & MSTATUS_MPIE, MSTATUS_MPIE);
  assert.strictEqual((cpu.csr('mstatus') & MSTATUS_MPP) >>> 11, PRIV_U);
});

test('sret restores SIE from SPIE and sets SPP to U', () => {
  const { cpu } = execAsm(`
li x5, 0x122
csrrw x0, sstatus, x5
li x5, 0x10018
csrrw x0, sepc, x5
sret
nop
`, 6);
  assert.strictEqual(cpu.pc, 0x10018);
  assert.strictEqual(cpu.csr('sstatus') & MSTATUS_SIE, MSTATUS_SIE);
  assert.strictEqual(cpu.csr('sstatus') & MSTATUS_SPIE, MSTATUS_SPIE);
  assert.strictEqual(cpu.csr('sstatus') & MSTATUS_SPP, 0);
});

test('mret from S or U is illegal', () => {
  for (const priv of [PRIV_S, PRIV_U]) {
    const { cpu } = make(handlerAsm('mret\n'));
    cpu.run(3);
    cpu.priv = priv;
    cpu.run(2);
    assert.strictEqual(cpu.csr('mcause'), 2, `priv=${priv}`);
  }
});

test('sret from U is illegal', () => {
  const { cpu } = make(handlerAsm('sret\n'));
  cpu.run(3);
  cpu.priv = PRIV_U;
  cpu.run(2);
  assert.strictEqual(cpu.csr('mcause'), 2);
});

test('sret from M is legal', () => {
  const { cpu } = execAsm(`
li x5, 0x10018
csrrw x0, sepc, x5
sret
nop
`, 4);
  assert.strictEqual(cpu.pc, 0x10018);
});

test('timer: mtime is free-running and mtimecmp is writable', () => {
  const { cpu, bus } = make('nop\nnop\nnop\n');
  setMtimecmp(bus, 1000);
  cpu.run(3);
  assert.strictEqual(bus.read32(CLINT_MTIMECMP), 1000);
  assert.ok(bus.read32(CLINT_MTIME) >= 3);
});

test('timer: MTIP reflects mtime >= mtimecmp in mip', () => {
  const { cpu, bus } = make('nop\nnop\nnop\n');
  setMtimecmp(bus, 1);
  cpu.run(2);
  assert.strictEqual(cpu.csr('mip') & MIP_MTIP, MIP_MTIP);
});

test('timer interrupt traps with cause MTI when enabled', () => {
  const { cpu, bus } = make(handlerAsm('nop\n'));
  cpu.csrWrite(0x300, MSTATUS_MIE);
  cpu.csrWrite(0x304, MIP_MTIP);
  cpu.run(3);
  setMtimecmp(bus, 1);
  cpu.run(1);
  assert.strictEqual(cpu.csr('mcause'), 0x80000000 | INT_MTI);
  assert.strictEqual(cpu.pc, 0x10010);
});

test('timer interrupt is masked by clearing mie.MTIP', () => {
  const { cpu, bus } = make(handlerAsm('nop\n'));
  cpu.csrWrite(0x300, MSTATUS_MIE);
  cpu.run(3);
  setMtimecmp(bus, 1);
  cpu.run(3);
  assert.strictEqual(cpu.csr('mcause'), 0);
  assert.strictEqual(cpu.pc, 0x10018);
});

test('interrupt priority: MSI beats MTI', () => {
  const { cpu, bus } = make(handlerAsm('nop\n'));
  cpu.csrWrite(0x300, MSTATUS_MIE);
  cpu.csrWrite(0x304, MIP_MTIP | MIP_MSIP);
  cpu.run(3);
  bus.write32(CLINT_MSIP, 1);
  setMtimecmp(bus, 1);
  cpu.run(1);
  assert.strictEqual(cpu.csr('mcause'), 0x80000000 | INT_MSI);
});

test('delegated ecall from U traps to S via stvec', () => {
  const { cpu } = make(`
la x5, shandler
csrrw x0, stvec, x5
addi x5, x0, 256
csrrw x0, medeleg, x5
ecall
nop
shandler:
csrrs x7, sepc, x0
csrrs x8, scause, x0
nop
`);
  cpu.run(5);
  cpu.priv = PRIV_U;
  cpu.run(3);
  assert.strictEqual(cpu.x[7], 0x10014);
  assert.strictEqual(cpu.x[8], 8);
  assert.strictEqual(cpu.priv, PRIV_S);
  assert.strictEqual(cpu.csr('mcause'), 0);
});

test('trap from M is never delegated', () => {
  const { cpu } = make(handlerAsm('ecall\n'));
  cpu.csrWrite(0x302, 0xFFFFFFFF);
  cpu.run(4);
  assert.strictEqual(cpu.csr('mcause'), 11);
  assert.strictEqual(cpu.priv, PRIV_M);
});

test('delegated S-mode trap sets SPP and SPIE on entry', () => {
  const { cpu } = make(`
la x5, shandler
csrrw x0, stvec, x5
addi x5, x0, 256
csrrw x0, medeleg, x5
csrrsi x0, sstatus, 2
ecall
nop
shandler:
csrrs x7, sstatus, x0
nop
`);
  cpu.run(6);
  cpu.priv = PRIV_U;
  cpu.run(2);
  assert.strictEqual(cpu.x[7] & MSTATUS_SIE, 0);
  assert.strictEqual(cpu.x[7] & MSTATUS_SPIE, MSTATUS_SPIE);
  assert.strictEqual(cpu.x[7] & MSTATUS_SPP, 0);
});

test('S-mode timer interrupt delivered via sip.STIP forwarding', () => {
  const { cpu } = make(`
la x5, shandler
csrrw x0, stvec, x5
li x5, 0x20
csrrw x0, sie, x5
li x5, 0x20
csrrw x0, mideleg, x5
csrrsi x0, sstatus, 2
li x5, 0x20
csrrs x0, sip, x5
li x5, 0x800
csrrs x0, mstatus, x5
li x5, 0x10030
csrrw x0, mepc, x5
mret
.word 0x00000000
shandler:
csrrs x7, sepc, x0
csrrs x8, scause, x0
nop
`);
  cpu.run(20);
  assert.strictEqual(cpu.x[8], 0x80000000 | INT_STI);
  assert.strictEqual(cpu.priv, PRIV_S);
});

test('mideleg MTI bit delegates MTIP to S where it can never be enabled', () => {
  const { cpu, bus } = make(`
la x5, mhandler
csrrw x0, mtvec, x5
li x5, 0x80
csrrw x0, mideleg, x5
csrrw x0, mie, x5
nop
mhandler:
nop
`);
  cpu.run(6);
  cpu.priv = PRIV_U;
  setMtimecmp(bus, 1);
  cpu.run(2);
  assert.strictEqual(cpu.csr('mcause'), 0);
  assert.strictEqual(cpu.priv, PRIV_U);
  assert.strictEqual(cpu.pc, 0x10020);
});

test('M-mode CSR access from S traps illegal', () => {
  for (const csr of ['mstatus', 'mie', 'mepc', 'mtvec']) {
    const { cpu } = make(handlerAsm(`csrrw x0, ${csr}, x6\n`));
    cpu.run(3);
    cpu.x[6] = 1;
    cpu.priv = PRIV_S;
    cpu.run(2);
    assert.strictEqual(cpu.csr('mcause'), 2, `csr=${csr}`);
  }
});

test('S-mode CSR access from U traps illegal', () => {
  for (const csr of ['sstatus', 'sie', 'sepc', 'stvec']) {
    const { cpu } = make(handlerAsm(`csrrw x0, ${csr}, x6\n`));
    cpu.run(3);
    cpu.x[6] = 1;
    cpu.priv = PRIV_U;
    cpu.run(2);
    assert.strictEqual(cpu.csr('mcause'), 2, `csr=${csr}`);
  }
});

test('sstatus shadows mstatus S bits', () => {
  const { cpu } = execAsm(`
li x5, 0x42202
csrrw x0, sstatus, x5
csrrs x6, sstatus, x0
csrrs x7, mstatus, x0
nop
`, 5);
  assert.strictEqual(cpu.x[6] & SSTATUS_VISIBLE, 0x40002);
  assert.strictEqual(cpu.x[6] & ~SSTATUS_VISIBLE, 0);
  assert.strictEqual(cpu.x[7] & SSTATUS_VISIBLE, 0x40002);
  assert.strictEqual(cpu.x[7] & ~SSTATUS_VISIBLE, 0);
});

test('sstatus read zeroes M-only bits', () => {
  const { cpu } = execAsm(`
addi x5, x0, 0x308
csrrw x0, mstatus, x5
csrrs x6, sstatus, x0
nop
`, 3);
  assert.strictEqual(cpu.x[6], MSTATUS_SPP);
});

test('sie and sip expose only S interrupt bits', () => {
  const { cpu } = execAsm(`
li x5, 0xAAA
csrrw x0, mie, x5
csrrs x6, sie, x0
li x5, 0x555
csrrw x0, mip, x5
csrrs x7, sip, x0
nop
`, 6);
  assert.strictEqual(cpu.x[6], 0xAAA & S_IRQ_MASK);
  assert.strictEqual(cpu.x[7], 0x555 & S_IRQ_MASK);
});

test('sie write propagates to mie', () => {
  const { cpu } = execAsm(`
addi x5, x0, 0x22
csrrw x0, sie, x5
csrrs x6, mie, x0
nop
`, 3);
  assert.strictEqual(cpu.x[6], 0x22);
});

test('mtvec vectored mode: interrupt jumps to base + 4 * cause', () => {
  const { cpu, bus } = make(`
la x5, base
addi x5, x5, 1
csrrw x0, mtvec, x5
csrrsi x0, mstatus, 8
li x5, 128
csrrw x0, mie, x5
nop
base:
.word 0x00000000
.word 0x00000000
.word 0x00000000
.word 0x00000000
.word 0x00000000
.word 0x00000000
.word 0x00000000
.word 0x00000000
nop
`);
  setMtimecmp(bus, 1);
  cpu.run(8);
  assert.strictEqual(cpu.pc, 0x10020 + 4 * INT_MTI);
  assert.strictEqual(cpu.csr('mcause'), 0x80000000 | INT_MTI);
});

test('mtvec vectored mode: exception still jumps to base', () => {
  const { cpu } = execAsm(`
la x5, base
addi x5, x5, 1
csrrw x0, mtvec, x5
.word 0x00000000
nop
base:
nop
`, 5);
  assert.strictEqual(cpu.csr('mcause'), 2);
  assert.strictEqual(cpu.pc, 0x10018);
});

test('mip reflects pending timer and software interrupts', () => {
  const { cpu, bus } = make('nop\nnop\n');
  bus.write32(CLINT_MSIP, 1);
  setMtimecmp(bus, 1);
  cpu.run(2);
  assert.strictEqual(cpu.csr('mip') & (MIP_MSIP | MIP_MTIP), MIP_MSIP | MIP_MTIP);
});
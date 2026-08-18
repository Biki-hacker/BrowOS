'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Cpu } = require('../tools/cpu.js');
const { Bus } = require('../tools/mem.js');
const { assemble } = require('../tools/asm.js');

function loadElf(bus, bytes) {
  const e_phoff = bytes.readUInt32LE(28);
  const e_phentsize = bytes.readUInt16LE(42);
  const e_phnum = bytes.readUInt16LE(44);
  for (let i = 0; i < e_phnum; i++) {
    const ph = e_phoff + i * e_phentsize;
    if (bytes.readUInt32LE(ph) !== 1) continue; // PT_LOAD
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

function alu(op, a, b) {
  const { cpu } = make(`${op} x12, x10, x11\nnop\n`);
  cpu.x[10] = a | 0;
  cpu.x[11] = b | 0;
  cpu.run(1);
  return cpu.x[12];
}

function iop(op, a, imm) {
  const { cpu } = make(`${op} x12, x10, ${imm}\nnop\n`);
  cpu.x[10] = a | 0;
  cpu.run(1);
  return cpu.x[12];
}

test('basic program: addi and mul', () => {
  const { cpu } = execAsm(`
addi x2, x0, 5
addi x3, x0, 7
mul x4, x2, x3
add x5, x4, x0
nop
`, 5);
  assert.strictEqual(cpu.x[4], 35);
  assert.strictEqual(cpu.x[5], 35);
  assert.strictEqual(cpu.x[0], 0);
  assert.strictEqual(cpu.instCount, 5);
  assert.strictEqual(cpu.pc, 0x10014);
});

const ALU_CASES = [
  ['add', 2, 3, 5],
  ['add', -1, 1, 0],
  ['sub', 5, 3, 2],
  ['sub', -2, -3, 1],
  ['sll', 1, 5, 32],
  ['sll', 0x80000000, 1, 0],
  ['slt', 3, 5, 1],
  ['slt', -3, 3, 1],
  ['slt', 3, -3, 0],
  ['sltu', -3, 3, 0],
  ['sltu', 3, -3, 1],
  ['xor', 0xF0F0F0F0, 0x0F0F0F0F, 0xFFFFFFFF],
  ['or', 0xF0F0F0F0, 0x0F0F0F0F, 0xFFFFFFFF],
  ['and', 0xF0F0F0F0, 0x0F0F0F0F, 0],
  ['srl', 0x80000000, 1, 0x40000000],
  ['sra', 0x80000000, 1, 0xC0000000],
  ['sra', 0x7FFFFFFF, 1, 0x3FFFFFFF],
];

for (const [op, a, b, exp] of ALU_CASES) {
  test(`R-type ALU: ${op}`, () => {
    assert.strictEqual(alu(op, a, b), exp | 0);
  });
}

const M_CASES = [
  ['mul', 7, 6, 42],
  ['mul', -1, -1, 1],
  ['mul', 0x80000000, 2, 0],
  ['mulh', 0x80000000, 0x80000000, 0x40000000],
  ['mulh', 0x7FFFFFFF, 0x7FFFFFFF, 0x3FFFFFFF],
  ['mulh', -2, -2, 0],
  ['mulhsu', -2, 0xFFFFFFFF, 0xFFFFFFFE],
  ['mulhsu', 2, 0xFFFFFFFF, 1],
  ['mulhu', 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFE],
  ['div', 7, 2, 3],
  ['div', 7, -2, -3],
  ['div', -7, 2, -3],
  ['div', 0x80000000, -1, 0x80000000],
  ['div', 1, 0, -1],
  ['divu', 7, 2, 3],
  ['divu', 0x80000000, 2, 0x40000000],
  ['divu', 5, 0, 0xFFFFFFFF],
  ['rem', 7, 2, 1],
  ['rem', -7, 2, -1],
  ['rem', 7, -2, 1],
  ['rem', 0x80000000, -1, 0],
  ['rem', 5, 0, 5],
  ['remu', 0x80000000, 3, 2],
  ['remu', 7, 0, 7],
];

for (const [op, a, b, exp] of M_CASES) {
  test(`M extension: ${op}`, () => {
    assert.strictEqual(alu(op, a, b), exp | 0);
  });
}

const I_CASES = [
  ['addi', 5, 3, 8],
  ['addi', -1, -1, -2],
  ['addi', 0x7FFFFFFF, 1, 0x80000000],
  ['slti', 3, 5, 1],
  ['slti', -3, -5, 0],
  ['sltiu', 3, 5, 1],
  ['sltiu', -3, 5, 0],
  ['xori', 0xFF, 0x0F, 0xF0],
  ['ori', 0xF0, 0x0F, 0xFF],
  ['andi', 0xFF, 0x0F, 0x0F],
  ['slli', 1, 31, 0x80000000],
  ['srli', 0x80000000, 4, 0x08000000],
  ['srai', 0x80000000, 4, 0xF8000000],
];

for (const [op, a, imm, exp] of I_CASES) {
  test(`I-type ALU: ${op}`, () => {
    assert.strictEqual(iop(op, a, imm), exp | 0);
  });
}

test('loads and stores', () => {
  const { cpu, bus } = execAsm(`
addi x2, x0, -2
sw x2, 200(x0)
lw x3, 200(x0)
lhu x4, 200(x0)
lbu x5, 200(x0)
lh x6, 202(x0)
sh x2, 204(x0)
lhu x7, 204(x0)
sb x2, 206(x0)
lbu x8, 206(x0)
nop
`, 11);
  assert.strictEqual(cpu.x[3], -2);
  assert.strictEqual(cpu.x[4], 0xFFFE);
  assert.strictEqual(cpu.x[5], 0xFE);
  assert.strictEqual(cpu.x[6], -1);
  assert.strictEqual(cpu.x[7], 0xFFFE);
  assert.strictEqual(cpu.x[8], 0xFE);
  assert.deepStrictEqual(bus.dump(200, 8), [0xFE, 0xFF, 0xFF, 0xFF, 0xFE, 0xFF, 0xFE, 0x00]);
});

test('branch: countdown loop sums 1..10', () => {
  const { cpu } = execAsm(`
addi x2, x0, 10
addi x3, x0, 0
loop:
add x3, x3, x2
addi x2, x2, -1
bne x2, x0, loop
nop
`, 50);
  assert.strictEqual(cpu.x[3], 55);
  assert.strictEqual(cpu.x[2], 0);
});

test('branch: beq always taken', () => {
  const { cpu } = execAsm(`
addi x2, x0, 1
beq x0, x0, skip
addi x2, x0, 99
skip:
addi x2, x2, 1
nop
`, 4);
  assert.strictEqual(cpu.x[2], 2);
});

test('branch: signed and unsigned comparisons', () => {
  const t = (asm) => execAsm(asm, 4).cpu.x[12];
  assert.strictEqual(t(`
addi x10, x0, 3
addi x11, x0, -2
bltu x10, x11, t
addi x12, x0, 99
t:
addi x12, x0, 7
nop
`), 7);
  assert.strictEqual(t(`
addi x10, x0, -2
addi x11, x0, 3
bgeu x10, x11, t
addi x12, x0, 99
t:
addi x12, x0, 7
nop
`), 7);
  assert.strictEqual(t(`
addi x10, x0, -5
addi x11, x0, 3
blt x10, x11, t
addi x12, x0, 99
t:
addi x12, x0, 7
nop
`), 7);
  assert.strictEqual(t(`
addi x10, x0, 3
addi x11, x0, -5
bge x10, x11, t
addi x12, x0, 99
t:
addi x12, x0, 7
nop
`), 7);
  assert.strictEqual(t(`
addi x10, x0, 5
addi x11, x0, 3
bltu x10, x11, t
addi x12, x0, 99
nop
t:
nop
`), 99);
});

test('jal/jalr: recursive factorial', () => {
  const { cpu } = execAsm(`
addi x2, x0, 1024
addi x10, x0, 5
jal x1, fact
sw x10, 0(x0)
done: j done

fact:
addi x5, x0, 1
blt x10, x5, return1
beq x10, x5, return1
addi x2, x2, -8
sw x1, 0(x2)
sw x10, 4(x2)
addi x10, x10, -1
jal x1, fact
lw x6, 4(x2)
mul x10, x6, x10
lw x1, 0(x2)
addi x2, x2, 8
ret
return1:
addi x10, x0, 1
ret
`, 100);
  assert.strictEqual(cpu.x[10], 120);
  assert.strictEqual(cpu.x[2], 1024);
  assert.strictEqual(cpu.x[1], 0x1000C);
});

test('lui and auipc', () => {
  const { cpu } = execAsm(`
lui x10, 0x12345
auipc x11, 0
addi x12, x11, 0
nop
`, 4);
  assert.strictEqual(cpu.x[10], 0x12345000);
  assert.strictEqual(cpu.x[11], 0x10004);
  assert.strictEqual(cpu.x[12], 0x10004);
});

test('auipc + jalr absolute jump skips code', () => {
  const { cpu } = execAsm(`
auipc x6, 0
addi x6, x6, 16
jalr x0, 0(x6)
addi x7, x0, 99
addi x8, x0, 7
nop
`, 5);
  assert.strictEqual(cpu.x[8], 7);
  assert.strictEqual(cpu.x[7], 0);
});

test('CSR read/write instructions', () => {
  const { cpu } = execAsm(`
addi x5, x0, 42
csrrw x10, mscratch, x5
csrrs x11, mscratch, x5
addi x6, x0, 1
csrrci x12, mscratch, 2
csrrsi x13, mscratch, 1
csrrwi x14, mscratch, 7
csrrw x15, mscratch, x0
csrrs x16, mhartid, x0
nop
`, 11);
  assert.strictEqual(cpu.x[10], 0);
  assert.strictEqual(cpu.x[11], 42);
  assert.strictEqual(cpu.x[12], 42);
  assert.strictEqual(cpu.x[13], 40);
  assert.strictEqual(cpu.x[14], 41);
  assert.strictEqual(cpu.x[15], 7);
  assert.strictEqual(cpu.x[16], 0);
  assert.strictEqual(cpu.csr('mscratch'), 0);
  assert.strictEqual(cpu.csr('mhartid'), 0);
});

test('trap: illegal instruction goes to mtvec', () => {
  const { cpu } = execAsm(`
la x5, handler
csrrw x0, mtvec, x5
.word 0x00000000
addi x6, x0, 99
handler:
csrrs x7, mepc, x0
csrrs x8, mcause, x0
csrrs x9, mtval, x0
nop
`, 8);
  assert.strictEqual(cpu.x[7], 0x1000C);
  assert.strictEqual(cpu.x[8], 2);
  assert.strictEqual(cpu.x[9], 0);
});

test('trap: ecall and mret', () => {
  const { cpu } = execAsm(`
addi x6, x0, 0
la x5, handler
csrrw x0, mtvec, x5
ecall
addi x6, x0, 99
nop
handler:
csrrs x7, mepc, x0
csrrs x8, mcause, x0
addi x9, x7, 4
csrrw x0, mepc, x9
addi x6, x0, 1
mret
nop
`, 13);
  assert.strictEqual(cpu.x[6], 99);
  assert.strictEqual(cpu.x[7], 0x10010);
  assert.strictEqual(cpu.x[8], 11);
  assert.strictEqual(cpu.x[9], 0x10014);
});

test('trap: ebreak', () => {
  const { cpu } = execAsm(`
la x5, handler
csrrw x0, mtvec, x5
ebreak
nop
handler:
csrrs x7, mepc, x0
csrrs x8, mcause, x0
nop
`, 6);
  assert.strictEqual(cpu.x[7], 0x1000C);
  assert.strictEqual(cpu.x[8], 3);
});

test('trap: misaligned fetch', () => {
  const { cpu } = make(`
la x5, handler
csrrw x0, mtvec, x5
nop
handler:
csrrs x7, mepc, x0
csrrs x8, mcause, x0
csrrs x9, mtval, x0
nop
`);
  cpu.run(3);
  cpu.pc = 0x10009;
  cpu.run(6);
  assert.strictEqual(cpu.x[7], 0x10009);
  assert.strictEqual(cpu.x[8], 0);
  assert.strictEqual(cpu.x[9], 0x10009);
});

test('trap with no mtvec halts the cpu', () => {
  const { cpu } = make('ecall\n');
  const s = cpu.run(1);
  assert.strictEqual(s.halted, true);
  assert.strictEqual(s.reason, 'trap');
  assert.strictEqual(s.info.cause, 11);
  assert.strictEqual(cpu.csr('mcause'), 11);
  assert.strictEqual(cpu.csr('mepc'), 0x10000);
});

test('write to read-only CSR with nonzero value traps', () => {
  const { cpu } = execAsm(`
la x5, handler
csrrw x0, mtvec, x5
addi x6, x0, 1
csrrw x0, misa, x6
nop
handler:
csrrs x7, mepc, x0
csrrs x8, mcause, x0
nop
`, 8);
  assert.strictEqual(cpu.x[7], 0x10010);
  assert.strictEqual(cpu.x[8], 2);
});

test('ELF program reads data section', () => {
  const { cpu, r } = execAsm(`
.data
data: .word 0xDEADBEEF
.text
la x5, data
lw x6, 0(x5)
nop
`, 4);
  assert.strictEqual(cpu.x[5], r.sections.data.base);
  assert.strictEqual(cpu.x[6], 0xDEADBEEF | 0);
});

test('trace callback fires per instruction', () => {
  const seen = [];
  const { cpu } = make(
    'addi x2, x0, 1\naddi x3, x0, 2\nnop\n',
    { trace: (c, inst) => seen.push([c.pc, inst]) }
  );
  cpu.run(3);
  assert.deepStrictEqual(seen.map((s) => s[0]), [0x10000, 0x10004, 0x10008]);
});

test('run() is bounded and reports instruction count', () => {
  const { cpu } = make('addi x2, x0, 1\naddi x2, x2, 1\nnop\n');
  const s = cpu.run(2);
  assert.strictEqual(s.instCount, 2);
  assert.strictEqual(s.halted, false);
  assert.strictEqual(cpu.x[2], 2);
});

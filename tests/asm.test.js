'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { assemble, AsmError } = require('../tools/asm.js');

// assemble a source with elf:false → raw bytes = .text followed by .data
function raw(src, opts) {
  return assemble(src, Object.assign({ elf: false }, opts || {}));
}
const w = (r, i) => r.bytes.readUInt32LE(i * 4);

test('basic R-type encodings', () => {
  const r = raw('add x1, x2, x3\nsub x4, x5, x6\n');
  assert.strictEqual(w(r, 0), 0x003100B3);
  assert.strictEqual(w(r, 1), 0x40628233);
});

test('R-type ALU variants', () => {
  const r = raw('sll x1,x2,x3\nslt x1,x2,x3\nsltu x1,x2,x3\nxor x1,x2,x3\nsrl x1,x2,x3\nsra x1,x2,x3\nor x1,x2,x3\nand x1,x2,x3\n');
  assert.strictEqual(w(r, 0), 0x003110B3);
  assert.strictEqual(w(r, 1), 0x003120B3);
  assert.strictEqual(w(r, 2), 0x003130B3);
  assert.strictEqual(w(r, 3), 0x003140B3);
  assert.strictEqual(w(r, 4), 0x003150B3);
  assert.strictEqual(w(r, 5), 0x403150B3);
  assert.strictEqual(w(r, 6), 0x003160B3);
  assert.strictEqual(w(r, 7), 0x003170B3);
});

test('M extension encodings', () => {
  const r = raw('mul x1,x2,x3\nmulh x1,x2,x3\nmulhsu x1,x2,x3\nmulhu x1,x2,x3\ndiv x1,x2,x3\ndivu x1,x2,x3\nrem x1,x2,x3\nremu x1,x2,x3\n');
  assert.strictEqual(w(r, 0), 0x023100B3);
  assert.strictEqual(w(r, 1), 0x023110B3);
  assert.strictEqual(w(r, 2), 0x023120B3);
  assert.strictEqual(w(r, 3), 0x023130B3);
  assert.strictEqual(w(r, 4), 0x023140B3);
  assert.strictEqual(w(r, 5), 0x023150B3);
  assert.strictEqual(w(r, 6), 0x023160B3);
  assert.strictEqual(w(r, 7), 0x023170B3);
});

test('I-type encodings', () => {
  const r = raw('addi x1, x2, -1\nslti x1,x2,7\nsltiu x1,x2,7\nxori x1,x2,0xFF\nori x1,x2,1\nandi x1,x2,0x7FF\n');
  assert.strictEqual(w(r, 0), 0xFFF10093);
  assert.strictEqual(w(r, 1), 0x00712093);
  assert.strictEqual(w(r, 2), 0x00713093);
  assert.strictEqual(w(r, 3), 0x0FF14093);
  assert.strictEqual(w(r, 4), 0x00116093);
  assert.strictEqual(w(r, 5), 0x7FF17093);
});

test('loads and stores', () => {
  const r = raw('lw x4, 8(x5)\nlb x4, -1(x5)\nlh x4, 0(x5)\nlbu x4, 16(x5)\nlhu x4, 2(x5)\nsw x6, -4(x7)\nsb x6, 0(x7)\nsh x6, 2(x7)\n');
  assert.strictEqual(w(r, 0), 0x0082A203);
  assert.strictEqual(w(r, 1), 0xFFF28203);
  assert.strictEqual(w(r, 2), 0x00029203); // lh x4, 0(x5)
  assert.strictEqual(w(r, 3), 0x0102C203); // lbu x4, 16(x5)
  assert.strictEqual(w(r, 4), 0x0022D203); // lhu x4, 2(x5)
  assert.strictEqual(w(r, 5), 0xFE63AE23);
  assert.strictEqual(w(r, 6), 0x00638023); // sb x6, 0(x7)
  assert.strictEqual(w(r, 7), 0x00639123); // sh x6, 2(x7)
});

test('shifts', () => {
  const r = raw('slli x1, x2, 3\nsrli x1, x2, 3\nsrai x1, x2, 3\n');
  assert.strictEqual(w(r, 0), 0x00311093);
  assert.strictEqual(w(r, 1), 0x00315093);
  assert.strictEqual(w(r, 2), 0x40315093);
});

test('U-type: lui/auipc', () => {
  const r = raw('lui x1, 0x12345\nauipc x2, 0x80000\n');
  assert.strictEqual(w(r, 0), 0x123450B7);
  assert.strictEqual(w(r, 1), 0x80000117);
});

test('branch to label', () => {
  const r = raw('start:\n  beq x1, x2, done\n  bne x1, x2, done\n  blt x1, x2, done\n  bge x1, x2, done\n  bltu x1, x2, done\n  bgeu x1, x2, done\ndone:\n  nop\n');
  // done is at offset 24; diffs 24,20,16,12,8,4
  assert.strictEqual(w(r, 0), 0x208C63);
  assert.strictEqual(w(r, 1), 0x209A63);
  assert.strictEqual(w(r, 2), 0x20C863);
  assert.strictEqual(w(r, 3), 0x20D663);
  assert.strictEqual(w(r, 4), 0x20E463);
  assert.strictEqual(w(r, 5), 0x20F263);
  assert.strictEqual(w(r, 6), 0x00000013);
});

test('jal / jalr / ret', () => {
  const r = raw('_start:\n  jal x3, sub\n  jal sub2\nsub:\n  nop\nsub2:\n  ret\n');
  // jal x3,sub: sub at 8 → diff 8
  assert.strictEqual(w(r, 0), 0x8001EF);
  // jal sub2 (rd=ra): sub2 at 12 → diff 8
  assert.strictEqual(w(r, 1), 0x8000EF);
  assert.strictEqual(w(r, 2), 0x00000013);
  assert.strictEqual(w(r, 3), 0x00008067);
});

test('jalr with offset', () => {
  const r = raw('jalr x1, 4(x2)\n');
  assert.strictEqual(w(r, 0), 0x004100E7);
});

test('li immediate edge cases', () => {
  const r = raw('li x1, 1000\nli x2, -1\nli x3, -2048\nli x4, 4096\nli x5, -4096\nli x6, 0x80000000\nli x7, 0x7FFFFFFF\n');
  assert.strictEqual(w(r, 0), 0x3E800093);
  assert.strictEqual(w(r, 1), 0xFFF00113);
  assert.strictEqual(w(r, 2), 0x80000193);
  assert.strictEqual(w(r, 3), 0x00001237); // lui x4, 1
  assert.strictEqual(w(r, 4), 0x00020213); // addi x4, x4, 0
  assert.strictEqual(w(r, 5), 0xFFFFF2B7); // lui x5, -1
  assert.strictEqual(w(r, 6), 0x00028293); // addi x5, x5, 0
  assert.strictEqual(w(r, 7), 0x80000337); // lui x6, 0x80000
  assert.strictEqual(w(r, 8), 0x00030313); // addi x6, x6, 0
  assert.strictEqual(w(r, 9), 0x800003B7); // lui x7, 0x80000
  assert.strictEqual(w(r, 10), 0xFFF38393); // addi x7, x7, -1
});

test('la loads label address', () => {
  const r = raw('_start:\n  la x1, msg\n  la x2, end\nend:\n  nop\n.data\nmsg: .word 0xDEADBEEF\n');
  // text: la@0 (auipc@0, addi@4), la@8 (auipc@8, addi@12), nop@16 → size 20
  // data base = 0x10000 + align4(20) = 0x10014; msg = 0x10014; end = 0x10010
  // la x1, msg: auipc x1, hi=0 → 0x00000097; addi lo = 0x10014-0x10000 = 20 → 0x01408093
  assert.strictEqual(w(r, 0), 0x00000097);
  assert.strictEqual(w(r, 1), 0x01408093);
  // la x2, end: auipc@8: hi=0 → 0x00000117; addi lo = 0x10010-0x10008 = 8 → 0x00810113
  assert.strictEqual(w(r, 2), 0x00000117);
  assert.strictEqual(w(r, 3), 0x00810113);
  assert.strictEqual(r.sections.data.base, 0x10014);
});

test('pseudo instructions', () => {
  const r = raw('nop\nmv x1, x2\nnot x3, x4\nneg x5, x6\nj done\nbeqz x7, done\nbnez x8, done\ndone:\ncall sub\nsub:\n');
  assert.strictEqual(w(r, 0), 0x00000013);
  assert.strictEqual(w(r, 1), 0x00010093);
  assert.strictEqual(w(r, 2), 0xFFF24193);
  assert.strictEqual(w(r, 3), 0x406002B3);
  // items: nop@0, mv@4, not@8, neg@12, j@16, beqz@20, bnez@24, done@28, call@28, sub@32
  // j done: diff 12 → encJ(12,0): (12>>1)=6<<21=0xC00000 → 0x00C000EF
  assert.strictEqual(w(r, 4), 0x00C0006F);
  // beqz x7, done: @20 → 28, diff 8 → encB(8,0,7,0): imm[4:1]=4<<8=0x400 | rs1=7<<15=0x38000 → 0x00038463
  assert.strictEqual(w(r, 5), 0x00038463);
  // bnez x8, done: @24 → 28, diff 4 → encB(4,0,8,1): 0x200 | 0x40000 | 0x1000 | 0x63 → 0x00041263
  assert.strictEqual(w(r, 6), 0x00041263);
  // call sub: @28 → 32, diff 4 → encJ(4,1): 2<<21=0x400000 | 0x80 → 0x004000EF
  assert.strictEqual(w(r, 7), 0x004000EF);
});

test('data directives', () => {
  const r = raw('.data\n.byte 1, 2, 255\n.word 0x11223344\n.asciz "hi"\n.zero 3\n.text\nnop\n', { elf: false });
  // elf:false: text first (nop), then data at offset 4
  assert.strictEqual(w(r, 0), 0x00000013);
  const d = r.bytes.subarray(4);
  assert.deepStrictEqual([...d.subarray(0, 3)], [1, 2, 255]);
  assert.strictEqual(d.readUInt32LE(3), 0x11223344);
  assert.deepStrictEqual([...d.subarray(7, 9)], [0x68, 0x69]);
  assert.strictEqual(d[9], 0); // asciz NUL
  assert.deepStrictEqual([...d.subarray(10, 13)], [0, 0, 0]);
});

test('.align and .equ', () => {
  const r = raw('.equ MAGIC, 0x600d\n.text\n.align 2\n.word MAGIC\n.align 2\nli x1, MAGIC\n', { elf: false });
  // .word MAGIC at 0; .align 2 (→4) is a no-op after 4 bytes; li x1, 0x600D at 4 (lui x1,6 + addi x1,x1,13)
  assert.strictEqual(r.bytes.readUInt32LE(0), 0x600D);
  assert.strictEqual(w(r, 1), 0x000060B7); // lui x1, 6
  assert.strictEqual(w(r, 2), 0x00D08093); // addi x1, x1, 13
});

test('expression arithmetic in immediates', () => {
  const r = raw('li x1, (2+3)*4\nli x2, 0x10 | 0x1\nli x3, ~0\nli x4, (10 - 4)\nli x5, 1 << 5\nli x6, 0x40 >> 2\nli x7, 7 % 3\nli x8, 2 * 3 + 1\n', { elf: false });
  assert.strictEqual(w(r, 0), 0x01400093); // 20
  assert.strictEqual(w(r, 1), 0x01100113); // 17
  assert.strictEqual(w(r, 2), 0xFFF00193); // -1
  assert.strictEqual(w(r, 3), 0x00600213); // 6
  assert.strictEqual(w(r, 4), 0x02000293); // 32
  assert.strictEqual(w(r, 5), 0x01000313); // 16
  assert.strictEqual(w(r, 6), 0x00100393); // 1
  assert.strictEqual(w(r, 7), 0x00700413); // 7
});

test('char literals', () => {
  const r = raw('li x1, \'A\'\n.data\n.byte \'x\', \'\\n\'\n', { elf: false });
  assert.strictEqual(w(r, 0), 0x04100093);
  assert.deepStrictEqual([...r.bytes.subarray(4, 6)], [0x78, 0x0A]);
});

test('system instructions', () => {
  const r = raw('ecall\nebreak\nmret\nsret\nwfi\nsfence.vma\nsfence.vma x1, x2\nfence\nfence.i\ncsrrw x1, mstatus, x2\ncsrrs x1, mtvec, x2\ncsrrc x1, mie, x2\ncsrrwi x1, mscratch, 5\ncsrrsi x1, mcounteren, 1\ncsrrci x1, mstatus, 3\n');
  assert.strictEqual(w(r, 0), 0x00000073);
  assert.strictEqual(w(r, 1), 0x00100073);
  assert.strictEqual(w(r, 2), 0x30200073);
  assert.strictEqual(w(r, 3), 0x10200073);
  assert.strictEqual(w(r, 4), 0x10500073);
  assert.strictEqual(w(r, 5), 0x12000073); // sfence.vma
  assert.strictEqual(w(r, 6), 0x12208073); // sfence.vma x1, x2
  assert.strictEqual(w(r, 7), 0x0000000F);
  assert.strictEqual(w(r, 8), 0x0000100F);
  assert.strictEqual(w(r, 9), 0x300110F3); // csrrw x1, mstatus, x2
  assert.strictEqual(w(r, 10), 0x305120F3); // csrrs x1, mtvec, x2
  assert.strictEqual(w(r, 11), 0x304130F3); // csrrc x1, mie, x2
  assert.strictEqual(w(r, 12), 0x3402D0F3); // csrrwi x1, mscratch, 5
  assert.strictEqual(w(r, 13), 0x3060E0F3); // csrrsi x1, mcounteren, 1
  assert.strictEqual(w(r, 14), 0x3001F0F3); // csrrci x1, mstatus, 3
});

test('ELF output structure', () => {
  const r = assemble('_start:\n  li a0, 1\n  ecall\n.data\nmsg: .asciz "x"\n.bss\nbuf: .zero 16\n');
  assert.strictEqual(r.bytes[0], 0x7F);
  assert.strictEqual(r.bytes[1], 0x45); // E
  assert.strictEqual(r.bytes[2], 0x4C); // L
  assert.strictEqual(r.bytes[3], 0x46); // F
  assert.strictEqual(r.bytes[4], 1); // ELFCLASS32
  assert.strictEqual(r.bytes[5], 1); // little endian
  assert.strictEqual(r.bytes.readUInt16LE(16), 2); // ET_EXEC
  assert.strictEqual(r.bytes.readUInt16LE(18), 243); // EM_RISCV
  assert.strictEqual(r.bytes.readUInt32LE(24), r.entry); // e_entry
  assert.ok(r.entry > 0);
  // phdr
  const ph = 52;
  assert.strictEqual(r.bytes.readUInt32LE(ph), 1); // PT_LOAD
  assert.strictEqual(r.bytes.readUInt32LE(ph + 4), 0x100); // p_offset
  assert.strictEqual(r.bytes.readUInt32LE(ph + 8), 0x10000); // p_vaddr
  // _start: li a0,1 (4B) + ecall (4B) = 8; data: 2 bytes → filesz 10
  assert.strictEqual(r.bytes.readUInt32LE(ph + 16), 10);
  assert.strictEqual(r.bytes.readUInt32LE(ph + 20), 10 + 16); // memsz = filesz + bss
  assert.strictEqual(r.bytes.readUInt32LE(ph + 24), 7); // RWX
  // entry points at li a0,1
  assert.strictEqual(r.entry, 0x10000);
  // text section header (index 1); e_shoff from ELF header
  const sh = r.bytes.readUInt32LE(32);
  assert.strictEqual(r.bytes.readUInt32LE(sh + 1 * 40 + 8), 6); // .text flags ALLOC|EXEC
  assert.strictEqual(r.bytes.readUInt32LE(sh + 1 * 40 + 12), 0x10000); // .text addr
  assert.strictEqual(r.bytes.readUInt32LE(sh + 3 * 40 + 4), 8); // .bss NOBITS type
  assert.strictEqual(r.bytes.readUInt32LE(sh + 3 * 40 + 20), 16); // .bss size
});

test('error: unknown instruction', () => {
  assert.throws(() => assemble('foo x1, x2\n'), AsmError);
});

test('error: undefined symbol', () => {
  assert.throws(() => assemble('li x1, nope\n'), /undefined symbol/);
});

test('error: immediate out of range', () => {
  assert.throws(() => assemble('addi x1, x2, 5000\n'), /out of range/);
});

test('error: branch out of range', () => {
  assert.throws(() => assemble('beq x1, x2, far\n.zero 10000\nfar: nop\n'), /out of range/);
});

test('error: unknown register', () => {
  assert.throws(() => assemble('add x1, x2, q9\n'), /unknown register/);
});

test('error: duplicate label', () => {
  assert.throws(() => assemble('a:\na:\n'), /duplicate symbol/);
});

test('error: unknown directive', () => {
  assert.throws(() => assemble('.foo 1\n'), /unknown directive/);
});

test('error: report line numbers', () => {
  try {
    assemble('nop\nnop\nnope\n');
    assert.fail('should throw');
  } catch (e) {
    assert.ok(/line 3/.test(e.message), 'expected line 3, got: ' + e.message);
  }
});

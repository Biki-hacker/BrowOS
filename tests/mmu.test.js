'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Bus } = require('../tools/mem.js');
const {
  Cpu,
  CSR_ADDRS,
  CAUSE_ILLEGAL,
  CAUSE_FETCH_PAGE_FAULT,
  CAUSE_LOAD_PAGE_FAULT,
  CAUSE_STORE_PAGE_FAULT,
  PTE_V,
  PTE_R,
  PTE_W,
  PTE_X,
  PTE_U,
  PTE_G,
  PTE_A,
  PTE_D,
} = require('../tools/cpu.js');

// Helper to construct a PTE
function makePte(ppn, flags) {
  return (((ppn >>> 0) << 10) | (flags & 0x3FF)) >>> 0;
}

// Helper to setup a minimal page table structure:
// Root table at rootPa (4 KiB)
// Level 0 table at l0Pa (4 KiB)
function createMmuSetup() {
  const bus = new Bus(0x1000000); // 16 MiB RAM
  const cpu = new Cpu(bus, { priv: 1, pc: 0x1000 }); // S-mode
  const rootPa = 0x10000;
  const l0Pa = 0x11000;

  // Set satp to Sv32 mode with root at rootPa
  const satpVal = ((1 << 31) | (rootPa >>> 12)) >>> 0;
  cpu.csrWrite(0x180, satpVal);

  return { bus, cpu, rootPa, l0Pa };
}

test('mmu: Bare mode (satp.MODE = 0) performs 1:1 physical translation', () => {
  const bus = new Bus(0x100000);
  const cpu = new Cpu(bus, { priv: 1, pc: 0x1000 });
  cpu.csrWrite(0x180, 0); // Bare mode

  bus.write32(0x5000, 0x12345678);
  assert.equal(cpu.translate(0x5000, 1), 0x5000);
  assert.equal(cpu.translate(0x5000, 0), 0x5000);
  assert.equal(cpu.translate(0x5000, 2), 0x5000);
});

test('mmu: M-mode bypasses Sv32 translation unless MPRV is set', () => {
  const bus = new Bus(0x100000);
  const cpu = new Cpu(bus, { priv: 3, pc: 0x1000 }); // M-mode
  const rootPa = 0x10000;
  cpu.csrWrite(0x180, (1 << 31) | (rootPa >>> 12)); // Sv32 enabled

  assert.equal(cpu.translate(0x8000, 1), 0x8000);
  assert.equal(cpu.translate(0x8000, 0), 0x8000);
  assert.equal(cpu.translate(0x8000, 2), 0x8000);
});

test('mmu: 4 KiB two-level page translation maps virtual to physical', () => {
  const { bus, cpu, rootPa, l0Pa } = createMmuSetup();

  const va = 0x40001ABC;
  const targetPa = 0x80000;
  const vpn1 = (va >>> 22) & 0x3FF; // 0x100
  const vpn0 = (va >>> 12) & 0x3FF; // 0x001
  const offset = va & 0xFFF;        // 0xABC

  // Root PTE points to level 0 table
  bus.write32(rootPa + vpn1 * 4, makePte(l0Pa >>> 12, PTE_V));

  // Level 0 PTE points to targetPa with R/W/X/A/D permissions
  bus.write32(l0Pa + vpn0 * 4, makePte(targetPa >>> 12, PTE_V | PTE_R | PTE_W | PTE_X | PTE_A | PTE_D));

  bus.write32(targetPa | offset, 0xCAFEBABE);

  const translated = cpu.translate(va, 1);
  assert.equal(translated, (targetPa | offset) >>> 0);
});

test('mmu: 4 MiB superpage translation at level 1', () => {
  const { bus, cpu, rootPa } = createMmuSetup();

  const va = 0x80234567;
  const superPa = 0x400000; // 4 MiB aligned
  const vpn1 = (va >>> 22) & 0x3FF;

  // Level 1 leaf PTE (PPN[0] must be 0)
  bus.write32(rootPa + vpn1 * 4, makePte(superPa >>> 12, PTE_V | PTE_R | PTE_W | PTE_X | PTE_A | PTE_D));

  const translated = cpu.translate(va, 1);
  const expectedPa = (superPa | (va & 0x3FFFFF)) >>> 0;
  assert.equal(translated, expectedPa);
});

test('mmu: misaligned 4 MiB superpage traps with page fault', () => {
  const { bus, cpu, rootPa } = createMmuSetup();

  const va = 0x80000000;
  const unalignedPpn = (0x400000 >>> 12) | 1; // PPN[0] != 0
  const vpn1 = (va >>> 22) & 0x3FF;

  bus.write32(rootPa + vpn1 * 4, makePte(unalignedPpn, PTE_V | PTE_R | PTE_W | PTE_X | PTE_A | PTE_D));

  assert.equal(cpu.translate(va, 1), null);
  assert.equal(cpu.csr('scause') || cpu.csr('mcause'), CAUSE_LOAD_PAGE_FAULT);
  assert.equal(cpu.csr('stval') >>> 0 || cpu.csr('mtval') >>> 0, va >>> 0);
});

test('mmu: permission checks (R, W, X)', () => {
  const { bus, cpu, rootPa, l0Pa } = createMmuSetup();
  const vpn1 = 0;
  bus.write32(rootPa + vpn1 * 4, makePte(l0Pa >>> 12, PTE_V));

  // Page 1: Read-only
  bus.write32(l0Pa + 1 * 4, makePte(0x20, PTE_V | PTE_R | PTE_A | PTE_D));
  const vaRo = 0x00001000;
  cpu.priv = 1;
  assert.notEqual(cpu.translate(vaRo, 1), null); // Read ok
  cpu.priv = 1;
  assert.equal(cpu.translate(vaRo, 2), null);     // Write faults (cause 15)
  assert.equal(cpu.csr('mcause'), CAUSE_STORE_PAGE_FAULT);
  cpu.priv = 1;
  assert.equal(cpu.translate(vaRo, 0), null);     // Execute faults (cause 12)
  assert.equal(cpu.csr('mcause'), CAUSE_FETCH_PAGE_FAULT);

  // Page 2: Execute-only
  bus.write32(l0Pa + 2 * 4, makePte(0x30, PTE_V | PTE_X | PTE_A | PTE_D));
  const vaXo = 0x00002000;
  cpu.priv = 1;
  assert.notEqual(cpu.translate(vaXo, 0), null); // Fetch ok
  cpu.priv = 1;
  assert.equal(cpu.translate(vaXo, 1), null);     // Read faults when MXR=0
  assert.equal(cpu.csr('mcause'), CAUSE_LOAD_PAGE_FAULT);
});

test('mmu: MXR allows reading from execute-only pages', () => {
  const { bus, cpu, rootPa, l0Pa } = createMmuSetup();
  bus.write32(rootPa, makePte(l0Pa >>> 12, PTE_V));
  bus.write32(l0Pa + 4, makePte(0x20, PTE_V | PTE_X | PTE_A | PTE_D)); // Exec-only
  const va = 0x1000;

  // With MXR = 0: read faults
  cpu.priv = 1;
  cpu.csrWrite(0x300, 0); // mstatus.MXR = 0
  assert.equal(cpu.translate(va, 1), null);

  // With MXR = 1: read succeeds
  cpu.priv = 1;
  cpu.csrWrite(0x300, 1 << 19); // mstatus.MXR = 1
  assert.equal(cpu.translate(va, 1), 0x20000);
});

test('mmu: User / Supervisor privilege isolation and SUM', () => {
  const { bus, cpu, rootPa, l0Pa } = createMmuSetup();
  bus.write32(rootPa, makePte(l0Pa >>> 12, PTE_V));

  // User page (U=1)
  bus.write32(l0Pa + 4, makePte(0x20, PTE_V | PTE_R | PTE_W | PTE_X | PTE_U | PTE_A | PTE_D));
  const userVa = 0x1000;

  // Supervisor page (U=0)
  bus.write32(l0Pa + 8, makePte(0x30, PTE_V | PTE_R | PTE_W | PTE_X | PTE_A | PTE_D));
  const supVa = 0x2000;

  // In U-mode:
  cpu.priv = 0; // PRIV_U
  assert.notEqual(cpu.translate(userVa, 1), null); // U-mode can access user page
  cpu.priv = 0;
  assert.equal(cpu.translate(supVa, 1), null);     // U-mode cannot access supervisor page
  assert.equal(cpu.csr('mcause'), CAUSE_LOAD_PAGE_FAULT);

  // In S-mode without SUM:
  cpu.priv = 1; // PRIV_S
  cpu.csrWrite(0x300, 0); // SUM = 0
  assert.equal(cpu.translate(userVa, 1), null);    // S-mode blocked from user page
  cpu.priv = 1;
  assert.notEqual(cpu.translate(supVa, 1), null);  // S-mode can access supervisor page

  // In S-mode with SUM = 1:
  cpu.priv = 1;
  cpu.csrWrite(0x300, 1 << 18); // SUM = 1
  assert.notEqual(cpu.translate(userVa, 1), null); // S-mode can read user page
  cpu.priv = 1;
  assert.equal(cpu.translate(userVa, 0), null);    // S-mode can NEVER execute from user page
  assert.equal(cpu.csr('mcause'), CAUSE_FETCH_PAGE_FAULT);
});

test('mmu: MPRV in M-mode uses MPP privilege for data translation', () => {
  const { bus, cpu, rootPa, l0Pa } = createMmuSetup();
  bus.write32(rootPa, makePte(l0Pa >>> 12, PTE_V));
  // User page
  bus.write32(l0Pa + 4, makePte(0x20, PTE_V | PTE_R | PTE_W | PTE_U | PTE_A | PTE_D));
  const userVa = 0x1000;

  cpu.priv = 3; // PRIV_M
  // mstatus: MPP = U (0), MPRV = 1 (1 << 17)
  cpu.csrWrite(0x300, 1 << 17);

  // Data load translates with U privilege (succeeds on user page)
  assert.equal(cpu.translate(userVa, 1), 0x20000);
  // Instruction fetch in M-mode is always untranslated Bare
  assert.equal(cpu.translate(userVa, 0), userVa);
});

test('mmu: A and D bit faults', () => {
  const { bus, cpu, rootPa, l0Pa } = createMmuSetup();
  bus.write32(rootPa, makePte(l0Pa >>> 12, PTE_V));

  // A = 0
  bus.write32(l0Pa + 4, makePte(0x20, PTE_V | PTE_R | PTE_W | PTE_D)); // A bit missing
  cpu.priv = 1;
  assert.equal(cpu.translate(0x1000, 1), null);
  assert.equal(cpu.csr('mcause'), CAUSE_LOAD_PAGE_FAULT);

  // A = 1, D = 0
  bus.write32(l0Pa + 8, makePte(0x30, PTE_V | PTE_R | PTE_W | PTE_A)); // D bit missing
  cpu.priv = 1;
  assert.notEqual(cpu.translate(0x2000, 1), null); // Read ok
  cpu.priv = 1;
  assert.equal(cpu.translate(0x2000, 2), null);     // Write faults
  assert.equal(cpu.csr('mcause'), CAUSE_STORE_PAGE_FAULT);
});

test('mmu: page fault delegation via medeleg', () => {
  const { bus, cpu, rootPa, l0Pa } = createMmuSetup();
  // Delegate load page fault (bit 13) to S-mode
  cpu.csrWrite(0x302, 1 << 13); // medeleg
  cpu.csrWrite(0x105, 0x8000);   // stvec

  // Unmapped page (V = 0)
  const va = 0x3000;
  assert.equal(cpu.translate(va, 1), null);

  assert.equal(cpu.priv, 1); // Trapped to S-mode
  assert.equal(cpu.pc, 0x8000);
  assert.equal(cpu.csr('scause'), CAUSE_LOAD_PAGE_FAULT);
  assert.equal(cpu.csr('stval'), va);
});

test('mmu: TLB caching and sfence.vma invalidation', () => {
  const { bus, cpu, rootPa, l0Pa } = createMmuSetup();
  bus.write32(rootPa, makePte(l0Pa >>> 12, PTE_V));
  bus.write32(l0Pa + 4, makePte(0x20, PTE_V | PTE_R | PTE_W | PTE_A | PTE_D));
  const va = 0x1000;

  // First translation populates TLB
  assert.equal(cpu.translate(va, 1), 0x20000);
  assert.equal(cpu.tlb.size, 1);

  // Modify page table in memory behind TLB's back
  bus.write32(l0Pa + 4, makePte(0x50, PTE_V | PTE_R | PTE_W | PTE_A | PTE_D));

  // TLB hit still returns cached translation
  assert.equal(cpu.translate(va, 1), 0x20000);

  // sfence.vma invalidates TLB
  cpu.flushTlb();
  assert.equal(cpu.tlb.size, 0);

  // Translates to new physical address from page table
  assert.equal(cpu.translate(va, 1), 0x50000);
});

test('mmu: TVM blocks satp writes in S-mode with illegal instruction', () => {
  const { cpu } = createMmuSetup();
  cpu.priv = 1; // S-mode
  cpu.csrWrite(0x300, 1 << 20); // mstatus.TVM = 1

  // Attempting to write satp in S-mode with TVM=1 via system opcode:
  // csrw satp, x0 (0x18001073 or 0x18005073)
  const inst = 0x18005073; // csrrwi x0, satp, 0
  cpu.system(inst);

  assert.equal(cpu.csr('mcause'), CAUSE_ILLEGAL);
});

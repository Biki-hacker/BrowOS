'use strict';

const OP_LUI = 0x37, OP_AUIPC = 0x17, OP_JAL = 0x6F, OP_JALR = 0x67;
const OP_B = 0x63, OP_L = 0x03, OP_S = 0x23, OP_I = 0x13, OP_R = 0x33;
const OP_FENCE = 0x0F, OP_SYSTEM = 0x73;

const CAUSE_MISALIGNED_FETCH = 0;
const CAUSE_ILLEGAL = 2;
const CAUSE_BREAKPOINT = 3;
const CAUSE_ECALL_U = 8;
const CAUSE_ECALL_S = 9;
const CAUSE_ECALL_M = 11;

const MISA_RV32IM = 0x40001100;

const CSR_ADDRS = {
  sstatus: 0x100, sie: 0x104, stvec: 0x105, scounteren: 0x106,
  sscratch: 0x140, sepc: 0x141, scause: 0x142, stval: 0x143, sip: 0x144,
  satp: 0x180,
  mstatus: 0x300, misa: 0x301, mie: 0x304, mtvec: 0x305, mcounteren: 0x306,
  mscratch: 0x340, mepc: 0x341, mcause: 0x342, mtval: 0x343, mip: 0x344,
  mcycle: 0xB00, minstret: 0xB02,
  mvendorid: 0xF11, marchid: 0xF12, mimpid: 0xF13, mhartid: 0xF14,
};

const CSR_READONLY = new Set([0x301, 0xF11, 0xF12, 0xF13, 0xF14]);

function jalImm(inst) {
  const v = ((inst & 0x80000000) >>> 11) | ((inst & 0x7FE00000) >>> 20) |
            ((inst & 0x00100000) >>> 9) | (inst & 0x000FF000);
  return (v << 11) >> 11;
}

function bImm(inst) {
  const v = ((inst & 0x80000000) >>> 19) | ((inst & 0x80) << 4) |
            ((inst & 0x7E000000) >>> 20) | ((inst & 0xF00) >>> 7);
  return (v << 19) >> 19;
}

function sImm(inst) {
  const v = ((inst & 0xFE000000) >>> 20) | ((inst & 0xF80) >>> 7);
  return (v << 20) >> 20;
}

function div32(a, b) {
  if (b === 0) return -1;
  if (a === -2147483648 && b === -1) return a;
  return Math.trunc(a / b) | 0;
}

function rem32(a, b) {
  if (b === 0) return a;
  if (a === -2147483648 && b === -1) return 0;
  return a % b;
}

function divu32(a, b) {
  if (b === 0) return 0xFFFFFFFF;
  return Math.trunc(a / b);
}

function remu32(a, b) {
  if (b === 0) return a;
  return a % b;
}

class Cpu {
  constructor(bus, opts = {}) {
    this.bus = bus;
    this.resetPc = (opts.pc !== undefined ? opts.pc : 0) | 0;
    this.trace = opts.trace || null;
    this.reset();
  }

  reset() {
    this.x = new Int32Array(32);
    this.pc = this.resetPc;
    this.priv = 3;
    this.halted = false;
    this.haltReason = null;
    this.haltInfo = null;
    this.instCount = 0;
    this.cycle = 0;
    this.csrs = Object.create(null);
    for (const addr of Object.values(CSR_ADDRS)) this.csrs[addr] = 0;
    this.csrs[0x301] = MISA_RV32IM;
  }

  setX(i, v) {
    if (i !== 0) this.x[i] = v | 0;
  }

  fetch32(addr) {
    if ((addr & 3) !== 0) {
      this.trap(CAUSE_MISALIGNED_FETCH, addr);
      return null;
    }
    return this.bus.read32(addr);
  }

  step() {
    if (this.halted) return false;
    const inst = this.fetch32(this.pc);
    if (inst === null) {
      if (this.halted) return false;
      this.cycle++;
      this.instCount++;
      if (this.trace) this.trace(this, 0);
      return true;
    }
    this.cycle++;
    this.instCount++;
    if (this.trace) this.trace(this, inst);
    this.exec(inst);
    return true;
  }

  run(maxSteps = 10000000) {
    const start = this.instCount;
    const limit = start + maxSteps;
    while (!this.halted && this.instCount < limit) this.step();
    return {
      halted: this.halted,
      reason: this.haltReason,
      instCount: this.instCount - start,
      info: this.haltInfo,
    };
  }

  stop() {
    this.halted = true;
    this.haltReason = 'stop';
  }

  trap(cause, tval) {
    this.csrs[0x341] = this.pc;   // mepc
    this.csrs[0x342] = cause;     // mcause
    this.csrs[0x343] = tval | 0;  // mtval
    this.priv = 3;
    const mtvec = this.csrs[0x305];
    if (!mtvec) {
      this.halted = true;
      this.haltReason = 'trap';
      this.haltInfo = { cause, tval: tval | 0, pc: this.pc };
      return;
    }
    this.pc = mtvec & ~3;
  }

  csrRead(addr) {
    if (addr === 0xB00) return this.cycle;
    if (addr === 0xB02) return this.instCount;
    const v = this.csrs[addr];
    return v === undefined ? 0 : v;
  }

  csrWrite(addr, v) {
    if (addr === 0xB00) { this.cycle = v | 0; return; }
    if (addr === 0xB02) { this.instCount = v | 0; return; }
    if (addr === 0x001) v &= 0x1F;       // fflags: 5 bits
    else if (addr === 0x002) v &= 0x7;   // frm: 3 bits
    else if (addr === 0x003) v &= 0xFF;  // fcsr: 8 bits
    this.csrs[addr] = v | 0;
  }

  csr(nameOrAddr) {
    const addr = typeof nameOrAddr === 'string' ? CSR_ADDRS[nameOrAddr] : nameOrAddr;
    if (addr === undefined) return undefined;
    return this.csrRead(addr);
  }

  regs() {
    return Array.from(this.x);
  }

  exec(inst) {
    const op = inst & 0x7F;
    switch (op) {
      case OP_LUI: {
        this.setX((inst >>> 7) & 31, inst & 0xFFFFF000);
        this.pc += 4;
        break;
      }
      case OP_AUIPC: {
        this.setX((inst >>> 7) & 31, (this.pc + (inst & 0xFFFFF000)) | 0);
        this.pc += 4;
        break;
      }
      case OP_JAL: {
        const rd = (inst >>> 7) & 31;
        this.setX(rd, this.pc + 4);
        this.pc = (this.pc + jalImm(inst)) | 0;
        break;
      }
      case OP_JALR: {
        const rd = (inst >>> 7) & 31;
        const rs1 = (inst >>> 15) & 31;
        const imm = (inst & 0xFFF00000) >> 20;
        const base = this.x[rs1];
        this.setX(rd, this.pc + 4);
        this.pc = (base + imm) & ~1;
        break;
      }
      case OP_B:
        this.branch(inst);
        break;
      case OP_L:
        this.load(inst);
        break;
      case OP_S:
        this.store(inst);
        break;
      case OP_I:
        this.itype(inst);
        break;
      case OP_R:
        this.rtype(inst);
        break;
      case OP_FENCE: {
        const f3 = (inst >>> 12) & 7;
        if (f3 > 1) return this.trap(CAUSE_ILLEGAL, inst);
        this.pc += 4;
        break;
      }
      case OP_SYSTEM:
        this.system(inst);
        break;
      default:
        this.trap(CAUSE_ILLEGAL, inst);
    }
  }

  branch(inst) {
    const f3 = (inst >>> 12) & 7;
    const rs1 = this.x[(inst >>> 15) & 31];
    const rs2 = this.x[(inst >>> 20) & 31];
    let taken;
    switch (f3) {
      case 0: taken = rs1 === rs2; break;
      case 1: taken = rs1 !== rs2; break;
      case 4: taken = rs1 < rs2; break;
      case 5: taken = rs1 >= rs2; break;
      case 6: taken = (rs1 >>> 0) < (rs2 >>> 0); break;
      case 7: taken = (rs1 >>> 0) >= (rs2 >>> 0); break;
      default: return this.trap(CAUSE_ILLEGAL, inst);
    }
    this.pc = taken ? (this.pc + bImm(inst)) | 0 : this.pc + 4;
  }

  load(inst) {
    const f3 = (inst >>> 12) & 7;
    const rd = (inst >>> 7) & 31;
    const imm = (inst & 0xFFF00000) >> 20;
    const addr = (this.x[(inst >>> 15) & 31] + imm) | 0;
    switch (f3) {
      case 0: this.setX(rd, (this.bus.read8(addr) << 24) >> 24); break;   // lb
      case 1: this.setX(rd, (this.bus.read16(addr) << 16) >> 16); break;  // lh
      case 2: this.setX(rd, this.bus.read32(addr)); break;                // lw
      case 4: this.setX(rd, this.bus.read8(addr)); break;                 // lbu
      case 5: this.setX(rd, this.bus.read16(addr)); break;                // lhu
      default: return this.trap(CAUSE_ILLEGAL, inst);
    }
    this.pc += 4;
  }

  store(inst) {
    const f3 = (inst >>> 12) & 7;
    const rs1 = (inst >>> 15) & 31;
    const addr = (this.x[rs1] + sImm(inst)) | 0;
    const v = this.x[(inst >>> 20) & 31];
    switch (f3) {
      case 0: this.bus.write8(addr, v); break;
      case 1: this.bus.write16(addr, v); break;
      case 2: this.bus.write32(addr, v); break;
      default: return this.trap(CAUSE_ILLEGAL, inst);
    }
    this.pc += 4;
  }

  itype(inst) {
    const f3 = (inst >>> 12) & 7;
    const rd = (inst >>> 7) & 31;
    const rs1 = this.x[(inst >>> 15) & 31];
    const imm = (inst & 0xFFF00000) >> 20;
    switch (f3) {
      case 0: this.setX(rd, rs1 + imm); break;  // addi
      case 1: {                                  // slli
        if (inst & 0xFE000000) return this.trap(CAUSE_ILLEGAL, inst);
        this.setX(rd, rs1 << ((inst >>> 20) & 31));
        break;
      }
      case 2: this.setX(rd, rs1 < imm ? 1 : 0); break;  // slti
      case 3: this.setX(rd, (rs1 >>> 0) < (imm >>> 0) ? 1 : 0); break;  // sltiu
      case 4: this.setX(rd, rs1 ^ imm); break;  // xori
      case 5: {                                  // srli/srai
        const f7b = inst & 0xFE000000;
        if (f7b !== 0 && f7b !== 0x40000000) return this.trap(CAUSE_ILLEGAL, inst);
        const sh = (inst >>> 20) & 31;
        this.setX(rd, f7b ? rs1 >> sh : rs1 >>> sh);
        break;
      }
      case 6: this.setX(rd, rs1 | imm); break;  // ori
      case 7: this.setX(rd, rs1 & imm); break;  // andi
      default: return this.trap(CAUSE_ILLEGAL, inst);
    }
    this.pc += 4;
  }

  rtype(inst) {
    const f7 = inst >>> 25;
    if (f7 === 1) return this.mul(inst);
    const f3 = (inst >>> 12) & 7;
    const rd = (inst >>> 7) & 31;
    const rs1 = this.x[(inst >>> 15) & 31];
    const rs2 = this.x[(inst >>> 20) & 31];
    let v;
    switch (f3) {
      case 0: v = f7 ? rs1 - rs2 : rs1 + rs2; break;
      case 1: v = rs1 << (rs2 & 31); break;
      case 2: v = rs1 < rs2 ? 1 : 0; break;
      case 3: v = (rs1 >>> 0) < (rs2 >>> 0) ? 1 : 0; break;
      case 4: v = rs1 ^ rs2; break;
      case 5: v = f7 ? rs1 >> (rs2 & 31) : rs1 >>> (rs2 & 31); break;
      case 6: v = rs1 | rs2; break;
      case 7: v = rs1 & rs2; break;
      default: return this.trap(CAUSE_ILLEGAL, inst);
    }
    this.setX(rd, v);
    this.pc += 4;
  }

  mul(inst) {
    const f3 = (inst >>> 12) & 7;
    const rd = (inst >>> 7) & 31;
    const rs1 = this.x[(inst >>> 15) & 31];
    const rs2 = this.x[(inst >>> 20) & 31];
    let v;
    switch (f3) {
      case 0: v = Math.imul(rs1, rs2); break;                                        // mul
      case 1: v = Number((BigInt(rs1) * BigInt(rs2)) >> 32n); break;                 // mulh
      case 2: v = Number((BigInt(rs1) * BigInt(rs2 >>> 0)) >> 32n); break;           // mulhsu
      case 3: v = Number((BigInt(rs1 >>> 0) * BigInt(rs2 >>> 0)) >> 32n) | 0; break; // mulhu
      case 4: v = div32(rs1, rs2); break;
      case 5: v = divu32(rs1 >>> 0, rs2 >>> 0) | 0; break;
      case 6: v = rem32(rs1, rs2); break;
      case 7: v = remu32(rs1 >>> 0, rs2 >>> 0) | 0; break;
      default: return this.trap(CAUSE_ILLEGAL, inst);
    }
    this.setX(rd, v);
    this.pc += 4;
  }

  system(inst) {
    const f3 = (inst >>> 12) & 7;
    if (f3 === 0) {
      const f12 = inst >>> 20;
      switch (f12) {
        case 0x000: return this.trap(
          this.priv === 3 ? CAUSE_ECALL_M : this.priv === 1 ? CAUSE_ECALL_S : CAUSE_ECALL_U, 0);
        case 0x001: return this.trap(CAUSE_BREAKPOINT, 0);
        case 0x102:  // sret
          this.pc = this.csrRead(0x141);
          this.priv = (this.csrRead(0x100) >>> 8) & 1;
          return;
        case 0x302:  // mret
          this.pc = this.csrRead(0x341);
          this.priv = (this.csrRead(0x300) >>> 11) & 3;
          return;
        case 0x105: this.pc += 4; return;                   // wfi
        default: return this.trap(CAUSE_ILLEGAL, inst);
      }
    }
    if (f3 >= 1 && f3 <= 3 || f3 >= 5 && f3 <= 7) {
      const csr = inst >>> 20;
      const rd = (inst >>> 7) & 31;
      const rs1 = (inst >>> 15) & 31;
      const old = this.csrRead(csr);
      if (f3 & 4) {
        const zimm = rs1;
        if (CSR_READONLY.has(csr) && zimm !== 0) return this.trap(CAUSE_ILLEGAL, inst);
        if (f3 === 5) this.csrWrite(csr, zimm);
        else if (f3 === 6) this.csrWrite(csr, old | zimm);
        else this.csrWrite(csr, old & ~zimm);
      } else {
        const v = this.x[rs1];
        if (CSR_READONLY.has(csr) && v !== 0) return this.trap(CAUSE_ILLEGAL, inst);
        if (f3 === 1) this.csrWrite(csr, v);
        else if (f3 === 2) this.csrWrite(csr, old | v);
        else this.csrWrite(csr, old & ~v);
      }
      this.setX(rd, old);
      this.pc += 4;
      return;
    }
    this.trap(CAUSE_ILLEGAL, inst);
  }
}

module.exports = { Cpu, CSR_ADDRS, CAUSE_MISALIGNED_FETCH, CAUSE_ILLEGAL, CAUSE_BREAKPOINT, CAUSE_ECALL_M };

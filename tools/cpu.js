'use strict';

const OP_LUI = 0x37, OP_AUIPC = 0x17, OP_JAL = 0x6F, OP_JALR = 0x67;
const OP_B = 0x63, OP_L = 0x03, OP_S = 0x23, OP_I = 0x13, OP_R = 0x33;
const OP_FENCE = 0x0F, OP_SYSTEM = 0x73;

const CAUSE_MISALIGNED_FETCH = 0;
const CAUSE_FETCH_ACCESS = 1;
const CAUSE_ILLEGAL = 2;
const CAUSE_BREAKPOINT = 3;
const CAUSE_MISALIGNED_LOAD = 4;
const CAUSE_LOAD_ACCESS = 5;
const CAUSE_MISALIGNED_STORE = 6;
const CAUSE_STORE_ACCESS = 7;
const CAUSE_ECALL_U = 8;
const CAUSE_ECALL_S = 9;
const CAUSE_ECALL_M = 11;
const CAUSE_FETCH_PAGE_FAULT = 12;
const CAUSE_LOAD_PAGE_FAULT = 13;
const CAUSE_STORE_PAGE_FAULT = 15;

const PTE_V = 0x01, PTE_R = 0x02, PTE_W = 0x04, PTE_X = 0x08;
const PTE_U = 0x10, PTE_G = 0x20, PTE_A = 0x40, PTE_D = 0x80;

const INT_SSI = 1, INT_MSI = 3, INT_STI = 5, INT_MTI = 7, INT_SEI = 9, INT_MEI = 11;
const MIP_SSIP = 1 << INT_SSI, MIP_MSIP = 1 << INT_MSI, MIP_STIP = 1 << INT_STI,
      MIP_MTIP = 1 << INT_MTI, MIP_SEIP = 1 << INT_SEI, MIP_MEIP = 1 << INT_MEI;
const S_IRQ_MASK = MIP_SSIP | MIP_STIP | MIP_SEIP;
const IRQ_MASK = MIP_SSIP | MIP_MSIP | MIP_STIP | MIP_MTIP | MIP_SEIP | MIP_MEIP;
const IRQ_PRIORITY = [INT_MEI, INT_MSI, INT_MTI, INT_SEI, INT_SSI, INT_STI];
const DEVICE_IRQ_MASK = MIP_MSIP | MIP_MTIP;

const MSTATUS_SIE = 1 << 1, MSTATUS_MIE = 1 << 3, MSTATUS_SPIE = 1 << 5,
      MSTATUS_MPIE = 1 << 7, MSTATUS_SPP = 1 << 8, MSTATUS_MPP = 3 << 11,
      MSTATUS_MPRV = 1 << 17,
      MSTATUS_SUM = 1 << 18, MSTATUS_MXR = 1 << 19,
      MSTATUS_TVM = 1 << 20, MSTATUS_TW = 1 << 21, MSTATUS_TSR = 1 << 22;
const SSTATUS_VISIBLE = MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP | MSTATUS_SUM | MSTATUS_MXR;
const MSTATUS_WRITABLE = MSTATUS_SIE | MSTATUS_MIE | MSTATUS_SPIE | MSTATUS_MPIE |
                        MSTATUS_SPP | MSTATUS_MPP | MSTATUS_MPRV | MSTATUS_SUM |
                        MSTATUS_MXR | MSTATUS_TVM | MSTATUS_TW | MSTATUS_TSR;

const PRIV_U = 0, PRIV_S = 1, PRIV_M = 3;

const MISA_RV32IM = 0x40001100;

const CSR_ADDRS = {
  sstatus: 0x100, sie: 0x104, stvec: 0x105, scounteren: 0x106,
  sscratch: 0x140, sepc: 0x141, scause: 0x142, stval: 0x143, sip: 0x144,
  satp: 0x180,
  mstatus: 0x300, misa: 0x301, medeleg: 0x302, mideleg: 0x303, mie: 0x304,
  mtvec: 0x305, mcounteren: 0x306,
  mscratch: 0x340, mepc: 0x341, mcause: 0x342, mtval: 0x343, mip: 0x344,
  mcycle: 0xB00, minstret: 0xB02,
  mvendorid: 0xF11, marchid: 0xF12, mimpid: 0xF13, mhartid: 0xF14,
};

const CSR_READONLY = new Set([0xF11, 0xF12, 0xF13, 0xF14]);

function csrLevel(addr) {
  const lv = (addr >>> 8) & 3;
  return lv === 0 ? PRIV_U : lv === 1 ? PRIV_S : PRIV_M;
}

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
    this.initPriv = opts.priv !== undefined ? opts.priv : 3;
    this.trace = opts.trace || null;
    const { Clint } = require('./mem.js');
    this.timer = opts.timer || new Clint();
    this.timer.attach(bus);
    this.reset();
  }

  reset() {
    this.x = new Int32Array(32);
    this.pc = this.resetPc;
    this.priv = this.initPriv;
    this.halted = false;
    this.haltReason = null;
    this.haltInfo = null;
    this.instCount = 0;
    this.instret = 0;
    this.suppressInstret = false;
    this.cycle = 0;
    this.csrs = Object.create(null);
    for (const addr of Object.values(CSR_ADDRS)) this.csrs[addr] = 0;
    this.csrs[0x301] = MISA_RV32IM;
    this.tlb = new Map();
  }

  setX(i, v) {
    if (i !== 0) this.x[i] = v | 0;
  }

  flushTlb(vaddr = null, asid = null) {
    if (vaddr === null && asid === null) {
      this.tlb.clear();
      return;
    }
    if (vaddr !== null) {
      const vpn = (vaddr >>> 12) >>> 0;
      this.tlb.delete(vpn);
      return;
    }
    if (asid !== null) {
      for (const [k, entry] of this.tlb) {
        if (entry.asid === asid && !(entry.flags & PTE_G)) {
          this.tlb.delete(k);
        }
      }
    }
  }

  translate(vaddr, accessType) {
    const va = vaddr >>> 0;
    let effPriv = this.priv;
    const mstatus = this.csrs[0x300];
    if (accessType !== 0 && this.priv === PRIV_M && (mstatus & MSTATUS_MPRV)) {
      effPriv = (mstatus >>> 11) & 3;
    }
    if (effPriv === PRIV_M) return va;

    const satp = this.csrs[0x180] >>> 0;
    const mode = (satp >>> 31) & 1;
    if (mode === 0) return va;

    const asid = (satp >>> 22) & 0x1FF;
    const vpn = (va >>> 12) >>> 0;
    const offset = va & 0xFFF;

    const tlbEntry = this.tlb.get(vpn);
    if (tlbEntry && (tlbEntry.global || tlbEntry.asid === asid)) {
      const flags = tlbEntry.flags;
      const u = (flags & PTE_U) !== 0;
      const r = (flags & PTE_R) !== 0;
      const w = (flags & PTE_W) !== 0;
      const x = (flags & PTE_X) !== 0;
      const a = (flags & PTE_A) !== 0;
      const d = (flags & PTE_D) !== 0;
      const mxr = (mstatus & MSTATUS_MXR) !== 0;
      const sum = (mstatus & MSTATUS_SUM) !== 0;

      let fault = false;
      if (effPriv === PRIV_U) {
        if (!u) fault = true;
      } else if (effPriv === PRIV_S) {
        if (u && (!sum || accessType === 0)) fault = true;
      }
      if (accessType === 0 && !x) fault = true;
      else if (accessType === 1 && !r && !(mxr && x)) fault = true;
      else if (accessType === 2 && !w) fault = true;
      if (!a) fault = true;
      if (accessType === 2 && !d) fault = true;

      if (fault) {
        const cause = accessType === 0 ? CAUSE_FETCH_PAGE_FAULT :
                      accessType === 1 ? CAUSE_LOAD_PAGE_FAULT : CAUSE_STORE_PAGE_FAULT;
        this.trap(cause, va);
        return null;
      }
      return ((tlbEntry.ppn << 12) | offset) >>> 0;
    }

    const rootPa = ((satp & 0x3FFFFF) << 12) >>> 0;
    const vpn1 = (va >>> 22) & 0x3FF;
    const vpn0 = (va >>> 12) & 0x3FF;
    const pte1Addr = (rootPa + vpn1 * 4) >>> 0;
    const pte1 = this.bus.read32(pte1Addr) >>> 0;

    if ((pte1 & PTE_V) === 0 || (!(pte1 & PTE_R) && (pte1 & PTE_W))) {
      const cause = accessType === 0 ? CAUSE_FETCH_PAGE_FAULT :
                    accessType === 1 ? CAUSE_LOAD_PAGE_FAULT : CAUSE_STORE_PAGE_FAULT;
      this.trap(cause, va);
      return null;
    }

    let leafPte, leafPpn, isSuper;
    if ((pte1 & (PTE_R | PTE_X)) === 0) {
      const l0Pa = (((pte1 >>> 10) & 0x3FFFFF) << 12) >>> 0;
      const pte0Addr = (l0Pa + vpn0 * 4) >>> 0;
      const pte0 = this.bus.read32(pte0Addr) >>> 0;

      if ((pte0 & PTE_V) === 0 || (!(pte0 & PTE_R) && (pte0 & PTE_W))) {
        const cause = accessType === 0 ? CAUSE_FETCH_PAGE_FAULT :
                      accessType === 1 ? CAUSE_LOAD_PAGE_FAULT : CAUSE_STORE_PAGE_FAULT;
        this.trap(cause, va);
        return null;
      }
      if ((pte0 & (PTE_R | PTE_X)) === 0) {
        const cause = accessType === 0 ? CAUSE_FETCH_PAGE_FAULT :
                      accessType === 1 ? CAUSE_LOAD_PAGE_FAULT : CAUSE_STORE_PAGE_FAULT;
        this.trap(cause, va);
        return null;
      }
      leafPte = pte0;
      leafPpn = (pte0 >>> 10) & 0x3FFFFF;
      isSuper = false;
    } else {
      if (((pte1 >>> 10) & 0x3FF) !== 0) {
        const cause = accessType === 0 ? CAUSE_FETCH_PAGE_FAULT :
                      accessType === 1 ? CAUSE_LOAD_PAGE_FAULT : CAUSE_STORE_PAGE_FAULT;
        this.trap(cause, va);
        return null;
      }
      leafPte = pte1;
      leafPpn = (pte1 >>> 10) & 0x3FFFFF;
      isSuper = true;
    }

    const u = (leafPte & PTE_U) !== 0;
    const r = (leafPte & PTE_R) !== 0;
    const w = (leafPte & PTE_W) !== 0;
    const x = (leafPte & PTE_X) !== 0;
    const a = (leafPte & PTE_A) !== 0;
    const d = (leafPte & PTE_D) !== 0;
    const g = (leafPte & PTE_G) !== 0;
    const mxr = (mstatus & MSTATUS_MXR) !== 0;
    const sum = (mstatus & MSTATUS_SUM) !== 0;

    let fault = false;
    if (effPriv === PRIV_U) {
      if (!u) fault = true;
    } else if (effPriv === PRIV_S) {
      if (u && (!sum || accessType === 0)) fault = true;
    }
    if (accessType === 0 && !x) fault = true;
    else if (accessType === 1 && !r && !(mxr && x)) fault = true;
    else if (accessType === 2 && !w) fault = true;
    if (!a) fault = true;
    if (accessType === 2 && !d) fault = true;

    if (fault) {
      const cause = accessType === 0 ? CAUSE_FETCH_PAGE_FAULT :
                    accessType === 1 ? CAUSE_LOAD_PAGE_FAULT : CAUSE_STORE_PAGE_FAULT;
      this.trap(cause, va);
      return null;
    }

    if (isSuper) {
      const ppn1 = (leafPpn >>> 10) & 0xFFF;
      const superPpn = (ppn1 << 10) | vpn0;
      this.tlb.set(vpn, { ppn: superPpn, flags: leafPte & 0xFF, asid, global: g });
      return ((ppn1 << 22) | (va & 0x3FFFFF)) >>> 0;
    } else {
      this.tlb.set(vpn, { ppn: leafPpn, flags: leafPte & 0xFF, asid, global: g });
      return ((leafPpn << 12) | offset) >>> 0;
    }
  }

  fetch32(addr) {
    if ((addr & 3) !== 0) {
      this.trap(CAUSE_MISALIGNED_FETCH, addr);
      return null;
    }
    const pa = this.translate(addr, 0);
    if (pa === null) return null;
    return this.bus.read32(pa);
  }

  step() {
    if (this.halted) return false;
    this.timer.tick();
    this.cycle++;
    this.instCount++;
    const intr = this.pendingInterrupt();
    if (intr) {
      this.suppressInstret = false;
      this.trap(intr.cause, 0, true);
      if (this.trace) this.trace(this, 0);
      return true;
    }
    const inst = this.fetch32(this.pc);
    if (inst === null) {
      if (this.halted) return false;
      if (this.trace) this.trace(this, 0);
      return true;
    }
    if (this.trace) this.trace(this, inst);
    this.exec(inst);
    if (this.suppressInstret) this.suppressInstret = false;
    else {
      this.instret += 1;
      if (this.instret >= 0x10000000000000000) this.instret -= 0x10000000000000000;
    }
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

  mipPending() {
    const live = (this.timer.msipSet ? MIP_MSIP : 0) |
                 (this.timer.mtimeFired ? MIP_MTIP : 0);
    return (this.csrs[0x344] & ~DEVICE_IRQ_MASK) | live;
  }

  pendingInterrupt() {
    const mip = this.mipPending();
    if (!(mip & IRQ_MASK)) return null;
    const mie = this.csrs[0x304];
    const sie = mie & S_IRQ_MASK;
    const mstatus = this.csrs[0x300];
    const mideleg = this.csrs[0x303];
    for (const i of IRQ_PRIORITY) {
      const bit = 1 << i;
      if (!(mip & bit)) continue;
      const target = (mideleg & bit) ? PRIV_S : PRIV_M;
      if (target === PRIV_M) {
        if (!(mie & bit)) continue;
        if (this.priv === PRIV_M && !(mstatus & MSTATUS_MIE)) continue;
      } else {
        if (!(sie & bit)) continue;
        if (this.priv === PRIV_S && !(mstatus & MSTATUS_SIE)) continue;
      }
      if (this.priv > target) continue;
      return { cause: i, target };
    }
    return null;
  }

  trap(cause, tval, isInterrupt = false, epc = this.pc) {
    const prevPriv = this.priv;
    const causeBits = isInterrupt ? (0x80000000 | cause) : cause;
    let target = PRIV_M;
    if (prevPriv !== PRIV_M &&
        (isInterrupt ? this.csrs[0x303] : this.csrs[0x302]) & (1 << cause)) {
      target = PRIV_S;
    }
    const mstatus = this.csrs[0x300];
    if (target === PRIV_S) {
      this.csrs[0x141] = epc;             // sepc
      this.csrs[0x142] = causeBits;       // scause
      this.csrs[0x143] = tval | 0;        // stval
      const s = mstatus;
      this.csrs[0x300] =
        (s & ~(MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP)) |
        (s & MSTATUS_SIE ? MSTATUS_SPIE : 0) | (prevPriv << 8);
      this.priv = PRIV_S;
      const stvec = this.csrs[0x105];
      if (!stvec) {
        this.halted = true;
        this.haltReason = 'trap';
        this.haltInfo = { cause: causeBits, tval: tval | 0, pc: epc, priv: 'S' };
        return;
      }
      this.pc = this.vectorTarget(stvec, isInterrupt, cause);
      return;
    }
    this.csrs[0x341] = epc;       // mepc
    this.csrs[0x342] = causeBits; // mcause
    this.csrs[0x343] = tval | 0;  // mtval
    const m = mstatus;
    this.csrs[0x300] =
      (m & ~(MSTATUS_MIE | MSTATUS_MPIE | MSTATUS_MPP)) |
      (m & MSTATUS_MIE ? MSTATUS_MPIE : 0) | (prevPriv << 11);
    this.priv = PRIV_M;
    const mtvec = this.csrs[0x305];
    if (!mtvec) {
      this.halted = true;
      this.haltReason = 'trap';
      this.haltInfo = { cause: causeBits, tval: tval | 0, pc: epc, priv: 'M' };
      return;
    }
    this.pc = this.vectorTarget(mtvec, isInterrupt, cause);
  }

  vectorTarget(tvec, isInterrupt, cause) {
    const mode = tvec & 3;
    if (mode === 1 && isInterrupt) return ((tvec & ~3) + 4 * cause) | 0;
    return tvec & ~3;
  }

  csrRead(addr) {
    if (addr >= 0x7A0 && addr <= 0x7A4) return 0;          // trigger module: unsupported
    if (addr === 0x100) return this.csrs[0x300] & SSTATUS_VISIBLE;     // sstatus
    if (addr === 0x104) return this.csrs[0x304] & S_IRQ_MASK;          // sie
    if (addr === 0x144) return this.mipPending() & S_IRQ_MASK;         // sip
    if (addr === 0x344) return this.mipPending();                      // mip
    if (addr === 0xB00 || addr === 0xB80 || addr === 0xC00 || addr === 0xC80) return this.cycle;      // cycle aliases
    if (addr === 0xB02 || addr === 0xC02) return this.instret | 0;              // instret (low)
    if (addr === 0xB82 || addr === 0xC82) return Math.floor(this.instret / 0x100000000) | 0;  // instreth (high)
    const v = this.csrs[addr];
    return v === undefined ? 0 : v;
  }

  csrWrite(addr, v) {
    if (addr >= 0x7A0 && addr <= 0x7A4) return;             // trigger module: unsupported
    if (addr === 0x301) {                                              // misa: WARL, fixed RV32IM
      this.csrs[0x301] = (v & MISA_RV32IM) | MISA_RV32IM;
      return;
    }
    if (addr === 0x180) {                                              // satp
      const mode = (v >>> 31) & 1;
      const asid = (v >>> 22) & 0x1FF;
      const ppn = v & 0x3FFFFF;
      this.csrs[0x180] = ((mode << 31) | (asid << 22) | ppn) >>> 0;
      this.flushTlb();
      return;
    }
    if (addr === 0x300) {                                              // mstatus
      this.csrs[0x300] = (this.csrs[0x300] & ~MSTATUS_WRITABLE) | (v & MSTATUS_WRITABLE);
      this.flushTlb();
      return;
    }
    if (addr === 0x100) {                                              // sstatus
      this.csrs[0x300] = (this.csrs[0x300] & ~SSTATUS_VISIBLE) | (v & SSTATUS_VISIBLE);
      this.flushTlb();
      return;
    }
    if (addr === 0x104) {                                              // sie
      this.csrs[0x304] = (this.csrs[0x304] & ~S_IRQ_MASK) | (v & S_IRQ_MASK);
      return;
    }
    if (addr === 0x144) {                                              // sip
      this.csrs[0x344] = (this.csrs[0x344] & ~S_IRQ_MASK) | (v & S_IRQ_MASK);
      return;
    }
    if (addr === 0x344) {                                              // mip: device-driven bits stay live
      this.csrs[0x344] = v & ~DEVICE_IRQ_MASK;
      return;
    }
    if (addr === 0xB00 || addr === 0xB80 || addr === 0xC00 || addr === 0xC80) { this.cycle = v | 0; return; }
    if (addr === 0xB02 || addr === 0xC02) {                                  // instret: low half write
      this.instret = Math.floor(this.instret / 0x100000000) * 0x100000000 + (v >>> 0);
      this.suppressInstret = true;
      return;
    }
    if (addr === 0xB82 || addr === 0xC82) {                              // instreth: high half write
      this.instret =
        (this.instret - Math.floor(this.instret / 0x100000000) * 0x100000000) + (v | 0) * 0x100000000;
      this.suppressInstret = true;
      return;
    }
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
        const tgt = (this.pc + jalImm(inst)) | 0;
        if (tgt & 3) {
          this.trap(CAUSE_MISALIGNED_FETCH, tgt);
          return;
        }
        this.setX(rd, this.pc + 4);
        this.pc = tgt;
        break;
      }
      case OP_JALR: {
        const rd = (inst >>> 7) & 31;
        const rs1 = (inst >>> 15) & 31;
        const imm = (inst & 0xFFF00000) >> 20;
        const tgt = (this.x[rs1] + imm) | 0;
        const pct = tgt & ~1;
        if (pct & 3) {
          this.trap(CAUSE_MISALIGNED_FETCH, pct);
          return;
        }
        this.setX(rd, this.pc + 4);
        this.pc = pct;
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
    const tgt = (this.pc + bImm(inst)) | 0;
    if (taken && (tgt & 3)) {
      this.trap(CAUSE_MISALIGNED_FETCH, tgt);
      return;
    }
    this.pc = taken ? tgt : this.pc + 4;
  }

  load(inst) {
    const f3 = (inst >>> 12) & 7;
    const rd = (inst >>> 7) & 31;
    const imm = (inst & 0xFFF00000) >> 20;
    const addr = (this.x[(inst >>> 15) & 31] + imm) | 0;
    let val;
    switch (f3) {
      case 0: { // lb
        const pa = this.translate(addr, 1);
        if (pa === null) return;
        val = (this.bus.read8(pa) << 24) >> 24;
        break;
      }
      case 1: { // lh
        const pa = this.translate(addr, 1);
        if (pa === null) return;
        val = (this.bus.read16(pa) << 16) >> 16;
        break;
      }
      case 2: { // lw
        const pa = this.translate(addr, 1);
        if (pa === null) return;
        val = this.bus.read32(pa);
        break;
      }
      case 4: { // lbu
        const pa = this.translate(addr, 1);
        if (pa === null) return;
        val = this.bus.read8(pa);
        break;
      }
      case 5: { // lhu
        const pa = this.translate(addr, 1);
        if (pa === null) return;
        val = this.bus.read16(pa);
        break;
      }
      default: return this.trap(CAUSE_ILLEGAL, inst);
    }
    this.setX(rd, val);
    this.pc += 4;
  }

  store(inst) {
    const f3 = (inst >>> 12) & 7;
    const rs1 = (inst >>> 15) & 31;
    const addr = (this.x[rs1] + sImm(inst)) | 0;
    const v = this.x[(inst >>> 20) & 31];
    switch (f3) {
      case 0: { // sb
        const pa = this.translate(addr, 2);
        if (pa === null) return;
        this.bus.write8(pa, v);
        break;
      }
      case 1: { // sh
        const pa = this.translate(addr, 2);
        if (pa === null) return;
        this.bus.write16(pa, v);
        break;
      }
      case 2: { // sw
        const pa = this.translate(addr, 2);
        if (pa === null) return;
        this.bus.write32(pa, v);
        break;
      }
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
        case 0x102: {  // sret
          if (this.priv === PRIV_U) return this.trap(CAUSE_ILLEGAL, inst);
          if (this.priv !== PRIV_M && (this.csrs[0x300] & MSTATUS_TSR))
            return this.trap(CAUSE_ILLEGAL, inst);
          const s = this.csrs[0x300];
          this.pc = this.csrs[0x141];
          this.priv = (s >>> 8) & 1;
          this.csrs[0x300] =
            (s & ~(MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP)) |
            (s & MSTATUS_SPIE ? MSTATUS_SIE : 0) | MSTATUS_SPIE;
          return;
        }
        case 0x302: {  // mret
          if (this.priv !== PRIV_M) return this.trap(CAUSE_ILLEGAL, inst);
          const m = this.csrs[0x300];
          this.pc = this.csrs[0x341];
          this.priv = (m >>> 11) & 3;
          this.csrs[0x300] =
            (m & ~(MSTATUS_MIE | MSTATUS_MPIE | MSTATUS_MPP)) |
            (m & MSTATUS_MPIE ? MSTATUS_MIE : 0) | MSTATUS_MPIE;
          return;
        }
        case 0x105: this.pc += 4; return;                   // wfi
        case 0x120: { // sfence.vma: traps in S/U when TVM=1, traps in U always
          if (this.priv === PRIV_U) return this.trap(CAUSE_ILLEGAL, inst);
          if (this.priv !== PRIV_M && (this.csrs[0x300] & MSTATUS_TVM))
            return this.trap(CAUSE_ILLEGAL, inst);
          const rs1 = (inst >>> 15) & 31;
          const rs2 = (inst >>> 20) & 31;
          const vaddr = rs1 === 0 ? null : this.x[rs1];
          const asid = rs2 === 0 ? null : this.x[rs2];
          this.flushTlb(vaddr, asid);
          this.pc += 4;
          return;
        }
        default: return this.trap(CAUSE_ILLEGAL, inst);
      }
    }
    if (f3 >= 1 && f3 <= 3 || f3 >= 5 && f3 <= 7) {
      const csr = inst >>> 20;
      if (csrLevel(csr) > this.priv) return this.trap(CAUSE_ILLEGAL, inst);
      if (csr === 0x180 && this.priv !== PRIV_M && (this.csrs[0x300] & MSTATUS_TVM))
        return this.trap(CAUSE_ILLEGAL, inst);   // satp blocked by TVM
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

module.exports = {
  Cpu,
  CSR_ADDRS,
  CAUSE_MISALIGNED_FETCH,
  CAUSE_ILLEGAL,
  CAUSE_BREAKPOINT,
  CAUSE_MISALIGNED_LOAD,
  CAUSE_MISALIGNED_STORE,
  CAUSE_ECALL_U,
  CAUSE_ECALL_S,
  CAUSE_ECALL_M,
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
};

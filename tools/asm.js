'use strict';

// BrowOS host-side RV32IM assembler.
// Two-pass assembler producing a minimal ELF32 RISC-V executable.
// This is the reference implementation for the future guest `basm` (M8).

const fs = require('fs');
const path = require('path');

class AsmError extends Error {
  constructor(msg, line) {
    super('asm: ' + msg + (line != null ? ' (line ' + line + ')' : ''));
    this.line = line;
  }
}

const REGS = {
  x0: 0, zero: 0, x1: 1, ra: 1, x2: 2, sp: 2, x3: 3, gp: 3, x4: 4, tp: 4,
  x5: 5, t0: 5, x6: 6, t1: 6, x7: 7, t2: 7, x8: 8, s0: 8, fp: 8, x9: 9, s1: 9,
  x10: 10, a0: 10, x11: 11, a1: 11, x12: 12, a2: 12, x13: 13, a3: 13,
  x14: 14, a4: 14, x15: 15, a5: 15, x16: 16, a6: 16, x17: 17, a7: 17,
  x18: 18, s2: 18, x19: 19, s3: 19, x20: 20, s4: 20, x21: 21, s5: 21,
  x22: 22, s6: 22, x23: 23, s7: 23, x24: 24, s8: 24, x25: 25, s9: 25,
  x26: 26, s10: 26, x27: 27, s11: 27, x28: 28, t3: 28, x29: 29, t4: 29,
  x30: 30, t5: 30, x31: 31, t6: 31
};

// CSR name → address map (RV32 privileged spec).
const CSRS = {
  mstatus: 0x300, misa: 0x301, medeleg: 0x302, mideleg: 0x303, mie: 0x304,
  mtvec: 0x305, mcounteren: 0x306, mstatush: 0x310,
  mscratch: 0x340, mepc: 0x341, mcause: 0x342, mtval: 0x343, mip: 0x344,
  satp: 0x180, sstatus: 0x100, sie: 0x104, stvec: 0x105, sscratch: 0x140,
  sepc: 0x141, scause: 0x142, stval: 0x143, sip: 0x144,
  cycle: 0xC00, time: 0xC01, instret: 0xC02,
  cycleh: 0xC80, timeh: 0xC81, instreth: 0xC82,
  mvendorid: 0xF11, marchid: 0xF12, mimpid: 0xF13, mhartid: 0xF14
};

// Instruction table. fmt: r=register, i=immediate, sh=shift, s=store,
// b=branch, u=upper, j=jump, csr, sys.
const OP = {
  add: { fmt: 'r', f3: 0, f7: 0 }, sub: { fmt: 'r', f3: 0, f7: 0x20 },
  sll: { fmt: 'r', f3: 1, f7: 0 }, slt: { fmt: 'r', f3: 2, f7: 0 },
  sltu: { fmt: 'r', f3: 3, f7: 0 }, xor: { fmt: 'r', f3: 4, f7: 0 },
  srl: { fmt: 'r', f3: 5, f7: 0 }, sra: { fmt: 'r', f3: 5, f7: 0x20 },
  or: { fmt: 'r', f3: 6, f7: 0 }, and: { fmt: 'r', f3: 7, f7: 0 },
  mul: { fmt: 'r', f3: 0, f7: 1 }, mulh: { fmt: 'r', f3: 1, f7: 1 },
  mulhsu: { fmt: 'r', f3: 2, f7: 1 }, mulhu: { fmt: 'r', f3: 3, f7: 1 },
  div: { fmt: 'r', f3: 4, f7: 1 }, divu: { fmt: 'r', f3: 5, f7: 1 },
  rem: { fmt: 'r', f3: 6, f7: 1 }, remu: { fmt: 'r', f3: 7, f7: 1 },
  addi: { fmt: 'i', f3: 0 }, slti: { fmt: 'i', f3: 2 }, sltiu: { fmt: 'i', f3: 3 },
  xori: { fmt: 'i', f3: 4 }, ori: { fmt: 'i', f3: 6 }, andi: { fmt: 'i', f3: 7 },
  lb: { fmt: 'i', f3: 0 }, lh: { fmt: 'i', f3: 1 }, lw: { fmt: 'i', f3: 2 },
  lbu: { fmt: 'i', f3: 4 }, lhu: { fmt: 'i', f3: 5 },
  jalr: { fmt: 'i', f3: 0 },
  slli: { fmt: 'sh', f3: 1 }, srli: { fmt: 'sh', f3: 5 }, srai: { fmt: 'sh', f3: 5 },
  sb: { fmt: 's', f3: 0 }, sh: { fmt: 's', f3: 1 }, sw: { fmt: 's', f3: 2 },
  beq: { fmt: 'b', f3: 0 }, bne: { fmt: 'b', f3: 1 }, blt: { fmt: 'b', f3: 4 },
  bge: { fmt: 'b', f3: 5 }, bltu: { fmt: 'b', f3: 6 }, bgeu: { fmt: 'b', f3: 7 },
  lui: { fmt: 'u' }, auipc: { fmt: 'u' },
  jal: { fmt: 'j' },
  ecall: { fmt: 'sys', code: 0 }, ebreak: { fmt: 'sys', code: 1 },
  mret: { fmt: 'sys', code: 0x302 }, sret: { fmt: 'sys', code: 0x102 },
  wfi: { fmt: 'sys', code: 0x105 }, sfence: { fmt: 'sys', code: 0x120 },
  'sfence.vma': { fmt: 'sys', code: 0x120 },
  csrrw: { fmt: 'csr', f3: 1 }, csrrs: { fmt: 'csr', f3: 2 },
  csrrc: { fmt: 'csr', f3: 3 }, csrrwi: { fmt: 'csr', f3: 5 },
  csrrsi: { fmt: 'csr', f3: 6 }, csrrci: { fmt: 'csr', f3: 7 },
  fence: { fmt: 'sys', code: 0x0F }, fencei: { fmt: 'sys', code: 0x0F },
  'fence.i': { fmt: 'sys', code: 0x0F }
};

const PSEUDO = new Set(['nop', 'li', 'la', 'mv', 'not', 'neg', 'ret', 'j', 'call', 'beqz', 'bnez']);

// ---------------- lexer ----------------

function lexLine(line, lineNo) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t' || c === ',') { i++; continue; }
    if (c === '#' || c === ';') break;
    if (c === '"' || c === "'") {
      const quote = c;
      let s = '';
      i++;
      while (i < line.length && line[i] !== quote) {
        if (line[i] === '\\') {
          i++;
          const e = line[i];
          if (e === undefined) throw new AsmError('unterminated escape', lineNo);
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\x0B' };
          if (e === 'x') {
            const hex = line.slice(i + 1, i + 3);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new AsmError('bad \\x escape', lineNo);
            s += String.fromCharCode(parseInt(hex, 16));
            i += 3;
          } else if (e === '\n') { i++; }
          else if (map[e] !== undefined) { s += map[e]; i++; }
          else throw new AsmError('unknown escape \\' + e, lineNo);
        } else { s += line[i]; i++; }
      }
      if (line[i] !== quote) throw new AsmError('unterminated string', lineNo);
      i++;
      out.push({ type: 'str', value: s });
    } else if (c === '(' || c === ')') {
      out.push({ type: 'tok', value: c });
      i++;
    } else if (c === ':') {
      out.push({ type: 'tok', value: ':' });
      i++;
    } else if ('+-*/%&|^~<>='.includes(c)) {
      let v = c;
      if ((c === '<' || c === '>') && line[i + 1] === c) { v = c + c; i++; }
      out.push({ type: 'tok', value: v });
      i++;
    } else {
      let j = i;
      while (j < line.length && !/[\s,;#"'():+\-*/%&|^~<>=]/.test(line[j])) j++;
      if (j === i) throw new AsmError('unexpected character ' + JSON.stringify(line[i]), lineNo);
      out.push({ type: 'tok', value: line.slice(i, j) });
      i = j;
    }
  }
  return out;
}

// ---------------- expression evaluator ----------------

const NUM_RE = /^[-+]?0[xX][0-9a-fA-F]+$/;
const NUM_BIN_RE = /^[-+]?0[bB][01]+$/;
const NUM_DEC_RE = /^[-+]?\d+$/;

function numValue(tok) {
  if (NUM_RE.test(tok)) return parseInt(tok, 16) | 0;
  if (NUM_BIN_RE.test(tok)) return parseInt(tok.slice(2), 2) | 0;
  if (NUM_DEC_RE.test(tok)) return parseInt(tok, 10) | 0;
  return null;
}

function makeEval(tokens, syms, lineNo) {
  let pos = 0;
  function peek() { return pos < tokens.length ? tokens[pos] : null; }
  function next() {
    const t = tokens[pos];
    if (t === undefined) throw new AsmError('unexpected end of expression', lineNo);
    pos++;
    return t;
  }
  function atom() {
    const t = next();
    if (t.type === 'str') {
      if (t.value.length !== 1) throw new AsmError('char literal must be 1 character', lineNo);
      return t.value.charCodeAt(0);
    }
    if (t.value === '(') { const v = orExpr(); expect(')'); return v; }
    const n = numValue(t.value);
    if (n !== null) return n;
    const s = syms.get(t.value);
    if (s !== undefined) return s.value;
    throw new AsmError('undefined symbol "' + t.value + '"', lineNo);
  }
  function unary() {
    const t = peek();
    if (t && t.type === 'tok' && (t.value === '-' || t.value === '+' || t.value === '~')) {
      next();
      const v = unary();
      return t.value === '-' ? (-v) | 0 : t.value === '~' ? ~v : v;
    }
    return atom();
  }
  function mulDiv() {
    let l = unary();
    for (;;) {
      const t = peek();
      if (!t || t.type !== 'tok' || !['*', '/', '%', '<<', '>>', '&'].includes(t.value)) break;
      next();
      const r = unary();
      if (t.value === '*') l = Math.imul(l, r) | 0;
      else if (t.value === '/') l = (l / r) | 0;
      else if (t.value === '%') l = l % r;
      else if (t.value === '<<') l = (l << (r & 31)) | 0;
      else if (t.value === '>>') l = (l >> (r & 31)) | 0;
      else if (t.value === '&') l = l & r;
    }
    return l;
  }
  function addSub() {
    let l = mulDiv();
    for (;;) {
      const t = peek();
      if (!t || t.type !== 'tok' || (t.value !== '+' && t.value !== '-' && t.value !== '|' && t.value !== '^')) break;
      next();
      const r = mulDiv();
      if (t.value === '+') l = (l + r) | 0;
      else if (t.value === '-') l = (l - r) | 0;
      else if (t.value === '|') l = l | r;
      else if (t.value === '^') l = l ^ r;
    }
    return l;
  }
  function orExpr() { return addSub(); }
  function expect(v) {
    const t = next();
    if (t.type !== 'tok' || t.value !== v) throw new AsmError('expected "' + v + '"', lineNo);
  }
  return { value: () => orExpr() };
}

function evalOperand(tokens, syms, lineNo) {
  if (tokens.length === 0) throw new AsmError('empty expression', lineNo);
  return makeEval(tokens, syms, lineNo).value();
}

// ---------------- encoding ----------------

const encR = (f7, rs2, rs1, f3, rd) => (((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | 0x33) | 0) >>> 0;
const encI = (imm, rs1, f3, rd, op) => ((((imm & 0xFFF) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) | 0) >>> 0;
const encS = (imm, rs2, rs1, f3) => (((((imm >> 5) & 0x7F) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1F) << 7) | 0x23) | 0) >>> 0;
const encB = (imm, rs2, rs1, f3) => {
  const i = imm | 0;
  return ((((i >> 12) & 1) << 31) | (((i >> 5) & 0x3F) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (((i >> 1) & 0xF) << 8) | (((i >> 11) & 1) << 7) | 0x63 | 0) >>> 0;
};
const encU = (imm20, rd, op) => ((((imm20 & 0xFFFFF) << 12) | (rd << 7) | op) | 0) >>> 0;
const encJ = (imm, rd) => {
  const i = imm | 0;
  return (((((i >> 20) & 1) << 31) | (((i >> 1) & 0x3FF) << 21) | (((i >> 11) & 1) << 20) | (((i >> 12) & 0xFF) << 12) | (rd << 7) | 0x6F) | 0) >>> 0;
};
const encSh = (shamt, rs1, f7, f3, rd) => ((((f7 & 0x7F) << 25) | ((shamt & 0x1F) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | 0x13) | 0) >>> 0;
const encCsr = (csr, field, f3, rd, immForm) => {
  if (immForm) return (((csr & 0xFFF) << 20) | ((field & 0x1F) << 15) | (f3 << 12) | (rd << 7) | 0x73) >>> 0;
  return (((csr & 0xFFF) << 20) | ((field & 0x1F) << 15) | (f3 << 12) | (rd << 7) | 0x73) >>> 0;
};

// ---------------- parser + two-pass assembly ----------------

function splitOperandTokens(tokens, start, lineNo) {
  // Collect expression tokens until end of tokens (commas are dropped by lexer).
  return tokens.slice(start);
}

function expectReg(tok, lineNo) {
  if (!tok || tok.type !== 'tok') throw new AsmError('expected register', lineNo);
  const r = REGS[tok.value];
  if (r === undefined) throw new AsmError('unknown register "' + tok.value + '"', lineNo);
  return r;
}

// Parse memory operand "expr(reg)": tokens = [e1, e2, ..., '(', reg, ')'] or ['(', reg, ')']
function parseMem(tokens, lineNo) {
  const openIdx = tokens.findIndex((t) => t.type === 'tok' && t.value === '(');
  if (openIdx < 0) throw new AsmError('expected "(reg)" memory operand', lineNo);
  const after = tokens.slice(openIdx + 1);
  if (after.length !== 2 || after[0].type !== 'tok' || after[1].type !== 'tok' || after[1].value !== ')') {
    throw new AsmError('malformed memory operand', lineNo);
  }
  const off = tokens.slice(0, openIdx);
  const reg = expectReg(after[0], lineNo);
  return { base: reg, off };
}

function assemble(src, opts = {}) {
  const base = opts.base !== undefined ? opts.base : 0x10000;
  if ((base & 3) !== 0) throw new AsmError('base must be 4-byte aligned');

  const sections = { '.text': { items: [], size: 0 }, '.data': { items: [], size: 0 }, '.bss': { items: [], size: 0 } };
  const order = ['.text', '.data', '.bss'];
  let cur = '.text';
  const symbols = new Map(); // name -> { kind: 'label'|'const', value }
  const globals = new Set();

  function padSection(sec, align) {
    const off = sec.size;
    const a = 1 << align;
    const p = (off + a - 1) & ~(a - 1);
    if (p > off) sec.items.push({ kind: 'align', n: p - off });
    sec.size = p;
  }

  const lines = String(src).split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const lineNo = ln + 1;
    const toks = lexLine(lines[ln], lineNo);
    if (toks.length === 0) continue;

    let i = 0;
    // labels
    while (i + 1 < toks.length && toks[i].type === 'tok' && toks[i + 1].type === 'tok' && toks[i + 1].value === ':') {
      const name = toks[i].value;
      if (symbols.has(name)) throw new AsmError('duplicate symbol "' + name + '"', lineNo);
      symbols.set(name, { kind: 'label', section: cur, offset: sections[cur].size });
      i += 2;
    }
    if (i >= toks.length) continue;

    const head = toks[i];
    if (head.type !== 'tok') throw new AsmError('unexpected token', lineNo);
    const word = head.value;

    // -------- directives --------
    if (word.startsWith('.')) {
      const args = toks.slice(i + 1);
      const argVals = args.filter((t) => t.type === 'tok').map((t) => t.value);
      switch (word) {
        case '.section': {
          if (args.length !== 1 || args[0].type !== 'tok') throw new AsmError('.section needs one name', lineNo);
          if (!sections[args[0].value]) throw new AsmError('unknown section "' + args[0].value + '"', lineNo);
          cur = args[0].value;
          break;
        }
        case '.text': cur = '.text'; break;
        case '.data': cur = '.data'; break;
        case '.bss': cur = '.bss'; break;
        case '.globl': case '.global':
          for (const v of argVals) globals.add(v);
          break;
        case '.byte': {
          if (args.length === 0) throw new AsmError('.byte needs values', lineNo);
          const bytes = args.map((t) => {
            const v = evalOperand([t], symbols, lineNo);
            if (v < -128 || v > 255) throw new AsmError('.byte value out of range', lineNo);
            return v & 0xFF;
          });
          sections[cur].items.push({ kind: 'bytes', data: bytes });
          sections[cur].size += bytes.length;
          break;
        }
        case '.word': {
          if (args.length === 0) throw new AsmError('.word needs values', lineNo);
          const out = [];
          for (const t of args) {
            const v = evalOperand([t], symbols, lineNo) >>> 0;
            out.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF);
          }
          sections[cur].items.push({ kind: 'bytes', data: out });
          sections[cur].size += out.length;
          break;
        }
        case '.asciz': case '.ascii': {
          if (args.length === 0) throw new AsmError(word + ' needs a string', lineNo);
          let out = [];
          for (const t of args) {
            if (t.type !== 'str') throw new AsmError(word + ' needs string literals', lineNo);
            for (let k = 0; k < t.value.length; k++) out.push(t.value.charCodeAt(k) & 0xFF);
          }
          if (word === '.asciz') out.push(0);
          sections[cur].items.push({ kind: 'bytes', data: out });
          sections[cur].size += out.length;
          break;
        }
        case '.zero': {
          const n = evalOperand(args.slice(0, 1), symbols, lineNo);
          if (n < 0) throw new AsmError('.zero needs non-negative size', lineNo);
          sections[cur].items.push({ kind: 'bytes', data: new Uint8Array(n) });
          sections[cur].size += n;
          break;
        }
        case '.align': {
          const n = evalOperand(args.slice(0, 1), symbols, lineNo);
          if (n < 0 || n > 16) throw new AsmError('.align needs 0..16', lineNo);
          padSection(sections[cur], n);
          break;
        }
        case '.equ': case '.set': {
          if (args.length < 2 || args[0].type !== 'tok') {
            throw new AsmError('.equ needs "NAME expr"', lineNo);
          }
          let vToks;
          if (args.length >= 3 && args[1].type === 'tok' && args[1].value === '=') vToks = args.slice(2);
          else vToks = args.slice(1);
          const v = evalOperand(vToks, symbols, lineNo);
          if (symbols.has(args[0].value)) throw new AsmError('duplicate symbol "' + args[0].value + '"', lineNo);
          symbols.set(args[0].value, { kind: 'const', value: v });
          break;
        }
        default:
          throw new AsmError('unknown directive "' + word + '"', lineNo);
      }
      continue;
    }

    // -------- instructions --------
    if (!OP[word] && !PSEUDO.has(word)) throw new AsmError('unknown instruction "' + word + '"', lineNo);
    const instToks = toks.slice(i + 1);
    const lineNoAtInst = lineNo;
    emitInstruction(cur, word, instToks, lineNoAtInst);
  }

  function emitInstruction(sec, word, toks, lineNo) {
    const secObj = sections[sec];
    const emit = (item) => {
      item.offset = secObj.size;
      secObj.items.push(item);
      secObj.size += item.size;
    };
    const reg = () => expectReg(toks.length ? toks[0] : null, lineNo);
    const expr = () => ({ tokens: splitOperandTokens(toks, 1, lineNo), lineNo });

    switch (word) {
      case 'nop': emit({ kind: 'inst', size: 4, enc: 0x00000013 }); return;
      case 'ret': emit({ kind: 'inst', size: 4, enc: encI(0, 1, 0, 0, 0x67) }); return;
      case 'mv': {
        const rd = reg(); const rs = expectReg(toks[1], lineNo);
        emit({ kind: 'inst', size: 4, enc: encI(0, rs, 0, rd, 0x13) }); return;
      }
      case 'not': {
        const rd = reg(); const rs = expectReg(toks[1], lineNo);
        emit({ kind: 'inst', size: 4, enc: encI(-1, rs, 4, rd, 0x13) }); return;
      }
      case 'neg': {
        const rd = reg(); const rs = expectReg(toks[1], lineNo);
        emit({ kind: 'inst', size: 4, enc: encR(0x20, rs, 0, 0, rd) }); return;
      }
      case 'j': case 'call': {
        const rd = word === 'call' ? 1 : 0;
        const target = splitOperandTokens(toks, 0, lineNo);
        const item = { kind: 'inst', size: 4, enc: 0, patch: { type: 'j', tokens: target, lineNo } };
        item.rd = rd;
        emit(item); return;
      }
      case 'jal': {
        if (toks.length === 1) {
          const target = splitOperandTokens(toks, 0, lineNo);
          const item = { kind: 'inst', size: 4, enc: 0, patch: { type: 'j', tokens: target, lineNo } };
          emit(item); return;
        }
        const rd = reg();
        const target = splitOperandTokens(toks, 1, lineNo);
        const item = { kind: 'inst', size: 4, enc: 0, patch: { type: 'j', tokens: target, lineNo } };
        item.rd = rd;
        emit(item); return;
      }
      case 'beqz': case 'bnez': {
        const rs = reg();
        const op = word === 'beqz' ? 'beq' : 'bne';
        const target = splitOperandTokens(toks, 1, lineNo);
        const item = { kind: 'inst', size: 4, enc: 0, patch: { type: 'b', op, f3: OP[op].f3, rs1: rs, rs2: 0, tokens: target, lineNo } };
        emit(item); return;
      }
      case 'li': {
        const rd = reg();
        const immToks = splitOperandTokens(toks, 1, lineNo);
        let immVal = null;
        try { immVal = evalOperand(immToks, symbols, lineNo); } catch (e) { /* forward ref: defer */ }
        if (immVal !== null && immVal >= -2048 && immVal <= 2047) {
          emit({ kind: 'inst', size: 4, enc: encI(immVal, 0, 0, rd, 0x13) });
          return;
        }
        emit({ kind: 'inst', size: 4, enc: 0, patch: { type: 'li_hi', tokens: immToks, rd, lineNo } });
        emit({ kind: 'inst', size: 4, enc: 0, patch: { type: 'li_lo', tokens: immToks, rd, hiOffset: secObj.size, lineNo } });
        return;
      }
      case 'la': {
        const rd = reg();
        const symToks = splitOperandTokens(toks, 1, lineNo);
        const hiOffset = secObj.size;
        emit({ kind: 'inst', size: 4, enc: 0, patch: { type: 'pcrel_hi', tokens: symToks, rd, lineNo } });
        emit({ kind: 'inst', size: 4, enc: 0, patch: { type: 'pcrel_lo', tokens: symToks, rd, hiOffset, lineNo } });
        return;
      }
    }

    const spec = OP[word];
    switch (spec.fmt) {
      case 'r': {
        const rd = reg(); const rs1 = expectReg(toks[1], lineNo); const rs2 = expectReg(toks[2], lineNo);
        emit({ kind: 'inst', size: 4, enc: encR(spec.f7, rs2, rs1, spec.f3, rd) });
        return;
      }
      case 'i': {
        if (word === 'jalr' || word === 'lb' || word === 'lh' || word === 'lw' || word === 'lbu' || word === 'lhu') {
          const rd = reg();
          const mem = parseMem(splitOperandTokens(toks, 1, lineNo), lineNo);
          const item = { kind: 'inst', size: 4, enc: 0, patch: { type: 'i', op: word, f3: spec.f3, rd, rs1: mem.base, tokens: mem.off, lineNo } };
          emit(item); return;
        }
        const rd = reg();
        const rs1 = expectReg(toks[1], lineNo);
        const immToks = splitOperandTokens(toks, 2, lineNo);
        const item = { kind: 'inst', size: 4, enc: 0, patch: { type: 'i', op: word, f3: spec.f3, rd, rs1, tokens: immToks, lineNo } };
        emit(item); return;
      }
      case 'sh': {
        const rd = reg();
        const rs1 = expectReg(toks[1], lineNo);
        let shamt = 0;
        if (toks.length >= 3) {
          const v = evalOperand([toks[2]], symbols, lineNo);
          if (v < 0 || v > 31) throw new AsmError('shift amount must be 0..31', lineNo);
          shamt = v;
        }
        emit({ kind: 'inst', size: 4, enc: encSh(shamt, rs1, word === 'srai' ? 0x20 : 0, spec.f3, rd) });
        return;
      }
      case 's': {
        const rs2 = reg();
        const mem = parseMem(splitOperandTokens(toks, 1, lineNo), lineNo);
        const item = { kind: 'inst', size: 4, enc: 0, patch: { type: 's', op: word, f3: spec.f3, rs2, rs1: mem.base, tokens: mem.off, lineNo } };
        emit(item); return;
      }
      case 'b': {
        const rs1 = reg(); const rs2 = expectReg(toks[1], lineNo);
        const target = splitOperandTokens(toks, 2, lineNo);
        const item = { kind: 'inst', size: 4, enc: 0, patch: { type: 'b', op: word, f3: spec.f3, rs1, rs2, tokens: target, lineNo } };
        emit(item); return;
      }
      case 'u': {
        const rd = reg();
        const immToks = splitOperandTokens(toks, 1, lineNo);
        const item = { kind: 'inst', size: 4, enc: 0, patch: { type: 'u', op: word, rd, tokens: immToks, lineNo } };
        emit(item); return;
      }
      case 'j': {
        const rd = toks.length >= 2 ? reg() : 1;
        const target = splitOperandTokens(toks, toks.length >= 2 ? 1 : 0, lineNo);
        const item = { kind: 'inst', size: 4, enc: 0, patch: { type: 'j', tokens: target, lineNo } };
        item.rd = rd;
        emit(item); return;
      }
      case 'csr': {
        const rd = reg();
        const immForm = spec.f3 >= 5;
        const csrTok = toks[1];
        const csr = csrTok && csrTok.type === 'tok' && CSRS[csrTok.value] !== undefined
          ? CSRS[csrTok.value]
          : evalOperand([csrTok], symbols, lineNo);
        const field = immForm ? evalOperand([toks[2]], symbols, lineNo) : expectReg(toks[2], lineNo);
        emit({ kind: 'inst', size: 4, enc: encCsr(csr, field, spec.f3, rd, immForm) });
        return;
      }
      case 'sys': {
        if (word === 'sfence' || word === 'sfence.vma') {
          let rs1 = 0, rs2 = 0;
          if (toks.length >= 1) rs1 = expectReg(toks[0], lineNo);
          if (toks.length >= 2) rs2 = expectReg(toks[1], lineNo);
          emit({ kind: 'inst', size: 4, enc: (((0x09 << 25) | (rs2 << 20) | (rs1 << 15) | 0x73) | 0) >>> 0 });
          return;
        }
        if (word === 'fence' || word === 'fencei' || word === 'fence.i') {
          emit({ kind: 'inst', size: 4, enc: word === 'fence' ? 0x0000000F : 0x0000100F });
          return;
        }
        emit({ kind: 'inst', size: 4, enc: OP[word].code << 20 | 0x73 });
        return;
      }
      default:
        throw new AsmError('internal: unhandled format', lineNo);
    }
  }

  // ---------- pass 2: addresses + patching ----------
  const textEnd = sections['.text'].size;
  const dataBase = base + alignUp(textEnd, 4);
  const dataEnd = sections['.data'].size;
  const bssBase = dataBase + alignUp(dataEnd, 4);
  const bases = { '.text': base, '.data': dataBase, '.bss': bssBase };

  // Resolve label addresses (consts already have values).
  for (const [name, sym] of symbols) {
    if (sym.kind === 'label') sym.value = bases[sym.section] + sym.offset;
  }

  const textBytes = renderSection(sections['.text'], bases['.text']);
  const dataBytes = renderSection(sections['.data'], bases['.data']);
  const bssBytes = renderSection(sections['.bss'], bases['.bss']);
  const bssSize = sections['.bss'].size;

  function alignUp(v, a) { return (v + a - 1) & ~(a - 1); }

  function renderSection(sec) {
    const out = [];
    for (const item of sec.items) {
      if (item.kind === 'align') {
        for (let k = 0; k < item.n; k++) out.push(0);
        continue;
      }
      if (item.kind === 'bytes') {
        for (const b of item.data) out.push(b & 0xFF);
        continue;
      }
      // instruction
      const addr = sec === sections['.text'] ? base + item.offset : dataBase + item.offset;
      const inst = patchInst(item, addr, lineNoFor(item));
      out.push(inst & 0xFF, (inst >>> 8) & 0xFF, (inst >>> 16) & 0xFF, (inst >>> 24) & 0xFF);
    }
    return Buffer.from(out);
  }

  function lineNoFor(item) { return item.patch ? item.patch.lineNo : null; }

  function patchInst(item, addr, lineNo) {
    if (!item.patch) return item.enc;
    const p = item.patch;
    const val = () => evalOperand(p.tokens, symbols, p.lineNo);
    switch (p.type) {
      case 'i': {
        let imm = p.tokens.length ? val() : 0;
        if (imm < -2048 || imm > 2047) throw new AsmError('immediate out of range (-2048..2047)', p.lineNo);
        const op = p.op === 'jalr' ? 0x67 : (p.op === 'lb' || p.op === 'lh' || p.op === 'lw' || p.op === 'lbu' || p.op === 'lhu') ? 0x03 : 0x13;
        return encI(imm, p.rs1, p.f3, p.rd, op);
      }
      case 's': {
        let imm = val();
        if (imm < -2048 || imm > 2047) throw new AsmError('immediate out of range (-2048..2047)', p.lineNo);
        return encS(imm, p.rs2, p.rs1, p.f3);
      }
      case 'b': {
        const target = val();
        const diff = target - addr;
        if (diff & 1) throw new AsmError('branch target not aligned', p.lineNo);
        if (diff < -4096 || diff > 4094) throw new AsmError('branch out of range (-4096..4094)', p.lineNo);
        return encB(diff, p.rs2, p.rs1, p.f3);
      }
      case 'u': {
        let imm = val();
        if (imm < -0x80000000 || imm > 0x7FFFFFFF) throw new AsmError('immediate out of range', p.lineNo);
        return encU(imm, p.rd, p.op === 'lui' ? 0x37 : 0x17);
      }
      case 'j': {
        const target = val();
        const diff = target - addr;
        if (diff & 1) throw new AsmError('jump target not aligned', p.lineNo);
        if (diff < -(1 << 20) || diff > (1 << 20) - 2) throw new AsmError('jump out of range', p.lineNo);
        return encJ(diff, item.rd !== undefined ? item.rd : 1);
      }
      case 'li_hi': {
        const v = val();
        const hi = (v + 0x800) >> 12;
        return encU(hi & 0xFFFFF, p.rd, 0x37);
      }
      case 'li_lo': {
        const v = val();
        const hi = (v + 0x800) >> 12;
        const lo = (v - hi * 4096) | 0;
        if (lo < -2048 || lo > 2047) throw new AsmError('li lo out of range', p.lineNo);
        return encI(lo, p.rd, 0, p.rd, 0x13);
      }
      case 'pcrel_hi': {
        const target = val();
        const off = target - addr;
        const hi = (off + 0x800) >> 12;
        return encU(hi & 0xFFFFF, p.rd, 0x17);
      }
      case 'pcrel_lo': {
        const target = val();
        const hiAddr = base + p.hiOffset;
        const hi = (target - hiAddr + 0x800) >> 12;
        const lo = (target - (hiAddr + hi * 4096)) | 0;
        if (lo < -2048 || lo > 2047) throw new AsmError('pcrel_lo out of range', p.lineNo);
        return encI(lo, p.rd, 0, p.rd, 0x13);
      }
      default:
        throw new AsmError('internal: unknown patch type ' + p.type, p.lineNo);
    }
  }

  const entry = symbols.get('_start') ? symbols.get('_start').value : 0;

  let bytes;
  if (opts.elf === false) {
    bytes = Buffer.concat([textBytes, dataBytes]);
  } else {
    bytes = buildElf({ entry, base, textBytes, dataBytes, bssSize, textSize: sections['.text'].size, dataSize: sections['.data'].size, dataBase, symbols, globals });
  }

  return {
    bytes,
    entry,
    base,
    symbols,
    globals: [...globals],
    sections: {
      text: { base: bases['.text'], size: sections['.text'].size },
      data: { base: dataBase, size: sections['.data'].size },
      bss: { base: bssBase, size: bssSize }
    }
  };
}

// ---------------- ELF32 writer ----------------

function buildElf({ entry, base, textBytes, dataBytes, bssSize, textSize, dataSize, dataBase, symbols, globals }) {
  const SEG_OFF = 0x100; // program bytes start here (after headers)
  const ELF_HDR = 52;
  const PHDR = 32;
  const SHDR = 40;
  const NSEC = 7;

  const prog = Buffer.concat([textBytes, dataBytes]);
  const shstr = Buffer.from('\0.text\0.data\0.bss\0.shstrtab\0.symtab\0.strtab\0');

  const labels = [];
  for (const [name, s] of symbols) {
    if (s.kind !== 'label') continue;
    let section = -1;
    let vaddr = 0;
    if (s.section === '.text') { section = 1; vaddr = base + s.offset; }
    else if (s.section === '.data') { section = 2; vaddr = dataBase + s.offset; }
    else if (s.section === '.bss') { section = 3; vaddr = dataBase + dataSize + s.offset; }
    labels.push({ name, section, vaddr: vaddr >>> 0, bind: globals.has(name) ? 0x10 : 0x00 });
  }
  labels.sort((a, b) => (a.section - b.section) || (a.vaddr - b.vaddr));

  const strParts = [Buffer.from('\0')];
  const stOffsets = new Map();
  for (const l of labels) {
    stOffsets.set(l.name, strParts.reduce((n, p) => n + p.length, 0));
    strParts.push(Buffer.from(l.name + '\0'));
  }
  const strtab = Buffer.concat(strParts);

  const symtabSize = labels.length * 16;
  const shoff = SEG_OFF + prog.length;
  const shstrOff = shoff + NSEC * SHDR;
  const symtabOff = shstrOff + shstr.length;
  const strtabOff = symtabOff + symtabSize;

  const f = Buffer.alloc(strtabOff + strtab.length);

  // e_ident
  f[0] = 0x7F; f[1] = 0x45; f[2] = 0x4C; f[3] = 0x46; // \x7fELF
  f[4] = 1; // ELFCLASS32
  f[5] = 1; // little endian
  f[6] = 1; // EV_CURRENT
  let o = 0;

  const u16 = (off, v) => { f.writeUInt16LE(v, off); };
  const u32 = (off, v) => { f.writeUInt32LE(v, off); };

  u16(16, 2);             // e_type ET_EXEC
  u16(18, 243);           // e_machine EM_RISCV
  u32(20, 1);             // e_version
  u32(24, entry);         // e_entry
  u32(28, ELF_HDR);       // e_phoff
  u32(32, shoff);         // e_shoff
  u32(36, 0);             // e_flags
  u16(40, ELF_HDR);       // e_ehsize
  u16(42, PHDR);          // e_phentsize
  u16(44, 1);             // e_phnum
  u16(46, SHDR);          // e_shentsize
  u16(48, NSEC);          // e_shnum (null, .text, .data, .bss, .shstrtab, .symtab, .strtab)
  u16(50, 4);             // e_shstrndx

  // program header (PT_LOAD, one segment)
  o = ELF_HDR;
  u32(o, 1);              // p_type PT_LOAD
  u32(o + 4, SEG_OFF);    // p_offset
  u32(o + 8, base);       // p_vaddr
  u32(o + 12, base);      // p_paddr
  u32(o + 16, prog.length);      // p_filesz
  u32(o + 20, prog.length + bssSize); // p_memsz
  u32(o + 24, 7);         // p_flags RWX
  u32(o + 28, 4096);      // p_align

  // section headers
  const sh = (idx, name, type, flags, addr, offset, size, align) => {
    o = shoff + idx * SHDR;
    u32(o, name); u32(o + 4, type); u32(o + 8, flags); u32(o + 12, addr);
    u32(o + 16, offset); u32(o + 20, size); u32(o + 24, 0); u32(o + 28, 0);
    u32(o + 32, align); u32(o + 36, 0);
  };
  sh(0, 0, 0, 0, 0, 0, 0, 0); // null
  sh(1, 1, 1, 6, base, SEG_OFF, textSize, 4);                      // .text PROGBITS ALLOC|EXEC
  sh(2, 7, 1, 3, dataBase, SEG_OFF + textSize, dataSize, 4);       // .data PROGBITS ALLOC|WRITE
  sh(3, 13, 8, 3, dataBase + dataSize, SEG_OFF + textSize + dataSize, bssSize, 4); // .bss NOBITS
  sh(4, 18, 3, 0, 0, shstrOff, shstr.length, 1);                   // .shstrtab STRTAB
  sh(5, 28, 2, 0, 0, symtabOff, symtabSize, 4);                    // .symtab SYMTAB
  sh(6, 35, 8, 0, 0, strtabOff, strtab.length, 1);                 // .strtab STRTAB

  // program bytes
  prog.copy(f, SEG_OFF);
  // shstrtab
  shstr.copy(f, shstrOff);
  // symtab
  let so = symtabOff;
  for (const l of labels) {
    u32(so, stOffsets.get(l.name));
    u32(so + 4, l.vaddr);
    u32(so + 8, 0);
    f[so + 12] = l.bind;
    f[so + 13] = 0;
    u16(so + 14, l.section);
    so += 16;
  }
  // strtab
  strtab.copy(f, strtabOff);

  return f;
}

function assembleFile(file, opts) {
  const src = fs.readFileSync(file, 'utf8');
  const result = assemble(src, opts);
  result.sourceFile = path.basename(file);
  return result;
}

module.exports = { assemble, assembleFile, AsmError, REGS, CSRS };

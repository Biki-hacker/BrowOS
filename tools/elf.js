'use strict';

function readU16(b, o) { return b[o] | (b[o + 1] << 8); }
function readU32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function readElf(bytes) {
  if (bytes[0] !== 0x7F || bytes[1] !== 0x45 || bytes[2] !== 0x4C || bytes[3] !== 0x46) {
    throw new Error('not an ELF file');
  }
  const is64 = bytes[4] === 2;
  const endian = bytes[5]; // 1 = little
  const rd = (b, o) => (is64 ? readU32(b, o + 4) : readU32(b, o));
  if (!is64 && endian !== 1) throw new Error('unsupported ELF format');
  const e_phoff = rd(bytes, 28);
  const e_phentsize = readU16(bytes, 42);
  const e_phnum = readU16(bytes, 44);
  const e_shoff = rd(bytes, 32);
  const e_shentsize = readU16(bytes, 46);
  const e_shnum = readU16(bytes, 48);
  const e_shstrndx = readU16(bytes, 50);
  const e_entry = rd(bytes, 24);

  const segments = [];
  for (let i = 0; i < e_phnum; i++) {
    const ph = e_phoff + i * e_phentsize;
    const type = readU32(bytes, ph);
    if (type !== 1) continue; // PT_LOAD
    const off = rd(bytes, ph + 4);
    const vaddr = rd(bytes, ph + 8);
    const filesz = rd(bytes, ph + 16);
    const memsz = rd(bytes, ph + 20);
    segments.push({ off, vaddr, filesz, memsz });
  }

  const sections = {};
  let shstr = null;
  for (let i = 0; i < e_shnum; i++) {
    const sh = e_shoff + i * e_shentsize;
    const nameOff = readU32(bytes, sh);
    const type = readU32(bytes, sh + 4);
    const addr = rd(bytes, sh + 12);
    const off = rd(bytes, sh + 16);
    const size = rd(bytes, sh + 20);
    if (i === e_shstrndx) {
      shstr = { off, size };
      continue;
    }
    if (type === 3) {
      sections['.shstrtab'] = { addr, off, size };
    }
    if (type === 2) {
      sections['.symtab'] = { addr, off, size };
    }
    if (type === 8) {
      sections['.strtab'] = { addr, off, size };
    }
  }
  if (shstr) {
    let name = '', s = 0;
    while (s < e_shnum) {
      const sh = e_shoff + s * e_shentsize;
      const nameOff = readU32(bytes, sh);
      let n = '';
      let k = shstr.off + nameOff;
      while (bytes[k] !== 0) n += String.fromCharCode(bytes[k++]);
      if (n !== '' && n !== '.shstrtab') {
        const type = readU32(bytes, sh + 4);
        const addr = rd(bytes, sh + 12);
        const off = rd(bytes, sh + 16);
        const size = rd(bytes, sh + 20);
        sections[n] = { addr, off, size, type };
      }
      s++;
    }
  }

  const symbols = {};
  const symtab = sections['.symtab'];
  const strtab = sections['.strtab'];
  if (symtab && strtab) {
    const entsize = 16;
    const n = Math.floor(symtab.size / entsize);
    for (let i = 0; i < n; i++) {
      const st = symtab.off + i * entsize;
      const nameOff = readU32(bytes, st);
      const value = rd(bytes, st + 4);
      const info = bytes[st + 12];
      let nm = '';
      let k = strtab.off + nameOff;
      while (bytes[k] !== 0) nm += String.fromCharCode(bytes[k++]);
      if (nm !== '') symbols[nm] = { value: value >>> 0, type: info & 0xF, size: rd(bytes, st + 8) };
    }
  }

  return { is64, endian, entry: e_entry >>> 0, segments, sections, symbols };
}

function loadSegments(bus, fileBytes, elf) {
  for (const seg of elf.segments) {
    const span = Math.max(seg.filesz, seg.memsz);
    bus.zero(seg.vaddr, span);
    if (seg.filesz > 0) {
      bus.load(seg.vaddr, fileBytes.subarray(seg.off, seg.off + seg.filesz));
    }
  }
}

module.exports = { readElf, loadSegments };

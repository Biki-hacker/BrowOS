'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { assemble } = require('../tools/asm.js');

const KERNEL_DIR = path.join(__dirname, '..', 'kernel');
const KERNEL_PARTS = [
  '0-memmap.s',
  'pmm.s',
  'heap.s',
  'vmm.s',
  'proc.s',
  'sched.s',
  'syscall.s',
  'trap.s',
  'driver_uart.s',
  'driver_blk.s',
  'fs.s',
  'main.s',
];

function buildKernel() {
  const src = KERNEL_PARTS
    .map((f) => fs.readFileSync(path.join(KERNEL_DIR, f), 'utf8'))
    .join('\n');
  return assemble(src);
}

test('fs: kernel image exports all BrFS filesystem functions', () => {
  const r = buildKernel();
  const expectedSymbols = [
    'fs_init',
    'fs_alloc_block',
    'fs_free_block',
    'fs_read_inode',
    'fs_write_inode',
    'fs_alloc_inode',
    'fs_create',
    'fs_lookup',
    'fs_read',
    'fs_write',
    'fs_unlink',
    'fs_mkdir',
    'fs_dir_add',
    'uart_init',
    'uart_putc',
    'uart_puts',
    'uart_getc',
    'blk_init',
    'blk_read_sector',
    'blk_write_sector',
    'blk_capacity',
  ];

  for (const sym of expectedSymbols) {
    assert.ok(r.symbols.has(sym), `Symbol ${sym} must be present in assembled kernel`);
  }
});

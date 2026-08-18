'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Bus } = require('../tools/mem.js');
const {
  Uart,
  BlockDevice,
  SECTOR_SIZE,
  UART_RBR,
  UART_THR,
  UART_IER,
  UART_IIR,
  UART_FCR,
  UART_LCR,
  UART_LSR,
  LSR_DATA_READY,
  LSR_TX_EMPTY,
  BLK_STATUS,
  BLK_COMMAND,
  BLK_SECTOR,
  BLK_DMA_ADDR,
  BLK_CAPACITY,
  BLK_SECT_SIZE,
  BLK_CMD_READ,
  BLK_CMD_WRITE,
} = require('../tools/devices.js');
const { UART_BASE, BLOCK_BASE, RAM_SIZE } = require('../tools/memmap.js');

test('uart: 16550A register reads and writes', () => {
  const bus = new Bus(RAM_SIZE, 0);
  const txChars = [];
  const uart = new Uart({ onTx: (c) => txChars.push(c) });
  uart.attach(bus);

  // Initial state: TX empty, no RX data
  assert.equal(bus.read8(UART_BASE + UART_LSR) & LSR_TX_EMPTY, LSR_TX_EMPTY);
  assert.equal(bus.read8(UART_BASE + UART_LSR) & LSR_DATA_READY, 0);

  // Write characters to THR
  bus.write8(UART_BASE + UART_THR, 0x48); // 'H'
  bus.write8(UART_BASE + UART_THR, 0x69); // 'i'
  assert.equal(uart.output(), 'Hi');
  assert.deepEqual(txChars, [0x48, 0x69]);

  // Push character into RX FIFO
  uart.pushRx(0x41); // 'A'
  assert.equal(bus.read8(UART_BASE + UART_LSR) & LSR_DATA_READY, LSR_DATA_READY);

  // Read RBR
  const ch = bus.read8(UART_BASE + UART_RBR);
  assert.equal(ch, 0x41);
  assert.equal(bus.read8(UART_BASE + UART_LSR) & LSR_DATA_READY, 0);
});

test('uart: line control and interrupt enable registers', () => {
  const bus = new Bus(RAM_SIZE, 0);
  const uart = new Uart();
  uart.attach(bus);

  // Set IER (enable RX interrupt)
  bus.write8(UART_BASE + UART_IER, 0x01);
  assert.equal(bus.read8(UART_BASE + UART_IER), 0x01);

  // Set LCR (8-N-1)
  bus.write8(UART_BASE + UART_LCR, 0x03);
  assert.equal(bus.read8(UART_BASE + UART_LCR), 0x03);

  // IRQ pending check
  assert.equal(uart.irqPending, false);
  uart.pushRx(0x21);
  assert.equal(uart.irqPending, true);
});

test('block device: capacity and sector size registers', () => {
  const bus = new Bus(RAM_SIZE, 0);
  const TOTAL_SECTORS = 4096;
  const blk = new BlockDevice(TOTAL_SECTORS, bus);
  blk.attach(bus);

  assert.equal(bus.read32(BLOCK_BASE + BLK_CAPACITY), TOTAL_SECTORS);
  assert.equal(bus.read32(BLOCK_BASE + BLK_SECT_SIZE), SECTOR_SIZE);
  assert.equal(bus.read32(BLOCK_BASE + BLK_STATUS), 0); // idle
});

test('block device: DMA sector write and read roundtrip', () => {
  const bus = new Bus(RAM_SIZE, 0);
  const blk = new BlockDevice(1024, bus);
  blk.attach(bus);

  // Fill guest RAM with a pattern at 0x10000
  const DMA_BUFFER = 0x00010000;
  for (let i = 0; i < SECTOR_SIZE; i++) {
    bus.write8(DMA_BUFFER + i, (i * 7 + 3) & 0xFF);
  }

  // Command: Write DMA_BUFFER to sector 42
  bus.write32(BLOCK_BASE + BLK_SECTOR, 42);
  bus.write32(BLOCK_BASE + BLK_DMA_ADDR, DMA_BUFFER);
  bus.write32(BLOCK_BASE + BLK_COMMAND, BLK_CMD_WRITE);
  assert.equal(bus.read32(BLOCK_BASE + BLK_STATUS), 2); // done-ok

  // Clear guest RAM buffer
  for (let i = 0; i < SECTOR_SIZE; i++) {
    bus.write8(DMA_BUFFER + i, 0);
  }

  // Command: Read sector 42 back into DMA_BUFFER
  bus.write32(BLOCK_BASE + BLK_SECTOR, 42);
  bus.write32(BLOCK_BASE + BLK_DMA_ADDR, DMA_BUFFER);
  bus.write32(BLOCK_BASE + BLK_COMMAND, BLK_CMD_READ);
  assert.equal(bus.read32(BLOCK_BASE + BLK_STATUS), 2); // done-ok

  // Verify data
  for (let i = 0; i < SECTOR_SIZE; i++) {
    assert.equal(bus.read8(DMA_BUFFER + i), (i * 7 + 3) & 0xFF);
  }
});

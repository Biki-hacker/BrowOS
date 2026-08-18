# 0-memmap.s - physical memory map constants.
# Kept in sync with tools/memmap.js. No code, only .equ definitions.

# RAM
.equ RAM_BASE,     0x00000000
.equ RAM_SIZE,     0x10000000
.equ FRAME_SIZE,   0x00001000
.equ NFRAMES,      0x00010000
.equ KERNEL_LINK,  0x00000000
.equ KERNEL_FRAMES, 0x00000100
.equ KERNEL_MAX,   0x00100000

# Kernel heap (kmalloc arena, 1 MiB)
.equ HEAP_START,   0x00100000
.equ HEAP_END,     0x00200000

# Machine timer (CLINT: msip + mtime)
.equ CLINT_BASE,   0x02000000

# Future device block
.equ UART_BASE,    0x10000000
.equ TIMER_BASE,   0x10001000
.equ INTC_BASE,    0x10002000
.equ BLOCK_BASE,   0x10003000
.equ GPU_CTRL_BASE, 0x10004000
.equ GPU_CMD_BASE, 0x10005000
.equ MMIO_END,     0xFFFFF000
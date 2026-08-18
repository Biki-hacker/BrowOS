# driver_uart.s - UART 16550A driver for BrowOS kernel.
# UART base address is UART_BASE (0x10000000).
# Uses MMIO byte-width accesses to read/write UART registers.

.section .text
.align 2
.global uart_init
.global uart_putc
.global uart_puts
.global uart_getc

# uart_init(): Initializes the UART for 8-N-1, FIFOs enabled.
uart_init:
  li t0, UART_BASE

  # Disable all interrupts
  sb x0, UART_IER(t0)

  # Enable FIFO, clear TX/RX, 14-byte threshold
  li t1, 0xC7
  sb t1, UART_FCR(t0)

  # Set line control: 8 data bits, no parity, 1 stop bit (8-N-1)
  li t1, 0x03
  sb t1, UART_LCR(t0)

  # Modem control: DTR + RTS + OUT2
  li t1, 0x0B
  sb t1, UART_MCR(t0)

  ret

# uart_putc(a0=char): Polls LSR until TX holding register empty, then writes byte.
uart_putc:
  li t0, UART_BASE
uart_putc_wait:
  lbu t1, UART_LSR(t0)
  andi t1, t1, LSR_TX_EMPTY
  beqz t1, uart_putc_wait
  sb a0, UART_THR(t0)
  ret

# uart_puts(a0=str_ptr): Writes null-terminated string via uart_putc.
uart_puts:
  addi sp, sp, -8
  sw ra, 4(sp)
  sw s0, 0(sp)
  mv s0, a0
uart_puts_loop:
  lbu a0, 0(s0)
  beqz a0, uart_puts_done
  call uart_putc
  addi s0, s0, 1
  j uart_puts_loop
uart_puts_done:
  lw ra, 4(sp)
  lw s0, 0(sp)
  addi sp, sp, 8
  ret

# uart_getc(): Returns byte from RBR in a0, or -1 if no data ready.
uart_getc:
  li t0, UART_BASE
  lbu t1, UART_LSR(t0)
  andi t1, t1, LSR_DATA_READY
  beqz t1, uart_getc_empty
  lbu a0, UART_RBR(t0)
  ret
uart_getc_empty:
  li a0, -1
  ret

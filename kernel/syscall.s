# syscall.s - Syscall Dispatcher and System Call Implementations.

.section .text
.align 2
.global syscall_dispatch
.global sys_getpid
.global sys_sleep
.global sys_write
.global sys_read

# syscall_dispatch(a7=num, a0..a5=args): Dispatches system call by number.
syscall_dispatch:
  li t0, 1  # SYS_EXIT
  beq a7, t0, sys_handle_exit
  li t0, 2  # SYS_FORK
  beq a7, t0, sys_handle_fork
  li t0, 3  # SYS_YIELD
  beq a7, t0, sys_handle_yield
  li t0, 4  # SYS_SLEEP
  beq a7, t0, sys_handle_sleep
  li t0, 5  # SYS_GETPID
  beq a7, t0, sys_handle_getpid
  li t0, 6  # SYS_WRITE
  beq a7, t0, sys_handle_write
  li t0, 7  # SYS_READ
  beq a7, t0, sys_handle_read

  # Unknown syscall
  li a0, -1
  ret

sys_handle_exit:
  j proc_exit

sys_handle_fork:
  # Return child PID in parent, or 0 in child (stub returning 0 for now)
  li a0, 0
  ret

sys_handle_yield:
  j sys_yield

sys_handle_sleep:
  la t0, current_proc
  lw t1, 0(t0)
  beqz t1, sys_sleep_done

  sw a0, 36(t1)  # pcb.sleep_ticks
  li t2, 3       # PROC_SLEEPING
  sw t2, 0(t1)   # pcb.state
  call schedule

sys_sleep_done:
  li a0, 0
  ret

sys_handle_getpid:
  la t0, current_proc
  lw t1, 0(t0)
  beqz t1, sys_getpid_zero
  lw a0, 4(t1)   # pcb.pid
  ret
sys_getpid_zero:
  li a0, 0
  ret

sys_handle_write:
  # a0 = fd, a1 = buf_ptr, a2 = count
  # For fd 1 (stdout) or fd 2 (stderr), write to UART
  li t0, 1
  beq a0, t0, sys_write_uart
  li t0, 2
  beq a0, t0, sys_write_uart
  # Other fds: return count (stub for now)
  mv a0, a2
  ret

sys_write_uart:
  # Write a2 bytes from a1 to UART
  addi sp, sp, -12
  sw ra, 8(sp)
  sw s0, 4(sp)
  sw s1, 0(sp)
  mv s0, a1       # buf
  mv s1, a2       # count
  li t0, 0
sys_write_uart_loop:
  bge t0, s1, sys_write_uart_done
  add t1, s0, t0
  lbu a0, 0(t1)
  sw t0, 0(sp)
  call uart_putc
  lw t0, 0(sp)
  addi t0, t0, 1
  j sys_write_uart_loop
sys_write_uart_done:
  mv a0, s1
  lw s1, 0(sp)
  lw s0, 4(sp)
  lw ra, 8(sp)
  addi sp, sp, 12
  ret

sys_handle_read:
  # a0 = fd, a1 = buf_ptr, a2 = count
  # For fd 0 (stdin), read from UART
  bnez a0, sys_read_other
  # Read up to count bytes from UART
  addi sp, sp, -12
  sw ra, 8(sp)
  sw s0, 4(sp)
  sw s1, 0(sp)
  mv s0, a1       # buf
  mv s1, a2       # max count
  li t0, 0
sys_read_uart_loop:
  bge t0, s1, sys_read_uart_done
  sw t0, 0(sp)
  call uart_getc
  lw t0, 0(sp)
  li t1, -1
  beq a0, t1, sys_read_uart_done
  add t2, s0, t0
  sb a0, 0(t2)
  addi t0, t0, 1
  j sys_read_uart_loop
sys_read_uart_done:
  mv a0, t0
  lw s1, 0(sp)
  lw s0, 4(sp)
  lw ra, 8(sp)
  addi sp, sp, 12
  ret

sys_read_other:
  li a0, 0
  ret

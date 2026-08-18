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
  # Stub returning bytes written
  mv a0, a2
  ret

sys_handle_read:
  li a0, 0
  ret

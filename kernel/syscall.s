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
  beq a7, t0, sys_fork
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
  li t0, 8  # SYS_OPEN
  beq a7, t0, sys_handle_open
  li t0, 9  # SYS_CLOSE
  beq a7, t0, sys_handle_close
  li t0, 10 # SYS_STAT
  beq a7, t0, sys_handle_stat
  li t0, 11 # SYS_MKDIR
  beq a7, t0, sys_handle_mkdir
  li t0, 12 # SYS_UNLINK
  beq a7, t0, sys_handle_unlink
  li t0, 13 # SYS_EXEC
  beq a7, t0, sys_handle_exec
  li t0, 15 # SYS_HALT
  beq a7, t0, sys_handle_halt
  li t0, 16 # SYS_PIPE
  beq a7, t0, sys_pipe
  li t0, 17 # SYS_KILL
  beq a7, t0, sys_kill
  li t0, 18 # SYS_WAITPID
  beq a7, t0, sys_waitpid

  # Unknown syscall
  li a0, -1
  ret

sys_handle_exit:
  j proc_exit

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

  # Check if pipe fd (fd >= 100)
  li t0, 100
  bgeu a0, t0, sys_write_pipe
  # Other fds: write to file via BrFS (fd maps directly to inode_no - 3 for simple file fds)
  addi sp, sp, -20
  sw ra, 16(sp)
  sw s0, 12(sp)
  sw s1, 8(sp)
  sw s2, 4(sp)
  sw s3, 0(sp)
  addi s0, a0, -3  # s0 = inode_no
  mv s1, a1        # buf
  mv s2, a2        # count
  mv a0, s0
  li a1, 0         # offset (append / overwrite at 0)
  mv a2, s1
  mv a3, s2
  call fs_write
  lw s3, 0(sp)
  lw s2, 4(sp)
  lw s1, 8(sp)
  lw s0, 12(sp)
  lw ra, 16(sp)
  addi sp, sp, 20
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

sys_write_pipe:
  # a0 = fd (>= 100), a1 = buf_ptr, a2 = count
  addi t0, a0, -100
  srli a0, t0, 1       # pipe_id = (fd - 100) / 2
  j pipe_write

sys_handle_read:
  # a0 = fd, a1 = buf_ptr, a2 = count
  # For fd 0 (stdin), read from UART
  beqz a0, sys_read_uart
  # Check if pipe fd (fd >= 100)
  li t0, 100
  bgeu a0, t0, sys_read_pipe
  # Other fds: read from file via BrFS
  addi sp, sp, -20
  sw ra, 16(sp)
  sw s0, 12(sp)
  sw s1, 8(sp)
  sw s2, 4(sp)
  sw s3, 0(sp)
  addi s0, a0, -3  # s0 = inode_no
  mv s1, a1        # buf
  mv s2, a2        # count
  mv a0, s0
  li a1, 0         # offset
  mv a2, s1
  mv a3, s2
  call fs_read
  lw s3, 0(sp)
  lw s2, 4(sp)
  lw s1, 8(sp)
  lw s0, 12(sp)
  lw ra, 16(sp)
  addi sp, sp, 20
  ret

sys_read_pipe:
  # a0 = fd (>= 100), a1 = buf_ptr, a2 = count
  addi t0, a0, -100
  srli a0, t0, 1       # pipe_id = (fd - 100) / 2
  j pipe_read

sys_read_uart:
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

sys_handle_open:
  # a0 = path_ptr, a1 = flags
  # Look up file in root directory (parent inode 0)
  addi sp, sp, -8
  sw ra, 4(sp)
  sw s0, 0(sp)
  mv s0, a1        # flags
  mv a1, a0        # path_ptr
  li a0, 0         # root dir inode
  call fs_lookup
  li t0, -1
  bne a0, t0, sys_open_found
  # If not found and flag is write/create (flags & 1)
  andi t1, s0, 1
  beqz t1, sys_open_notfound
  # Create file
  li a0, 0
  mv a1, a1
  li a2, 1         # BRFS_INODE_FILE
  call fs_create
  li t0, -1
  beq a0, t0, sys_open_notfound

sys_open_found:
  # fd = inode_no + 3 (0=stdin, 1=stdout, 2=stderr, 3+=files)
  addi a0, a0, 3
  j sys_open_ret

sys_open_notfound:
  li a0, -1

sys_open_ret:
  lw s0, 0(sp)
  lw ra, 4(sp)
  addi sp, sp, 8
  ret

sys_handle_close:
  li t0, 100
  bgeu a0, t0, sys_close_pipe
  li a0, 0
  ret
sys_close_pipe:
  addi t0, a0, -100
  andi a1, t0, 1       # is_write = (fd - 100) % 2
  srli a0, t0, 1       # pipe_id = (fd - 100) / 2
  j pipe_close

sys_handle_stat:
  # a0 = path_ptr, a1 = stat_buf_ptr
  addi sp, sp, -12
  sw ra, 8(sp)
  sw s0, 4(sp)
  sw s1, 0(sp)
  mv s1, a1        # stat_buf
  li a0, 0
  call fs_lookup
  li t0, -1
  beq a0, t0, sys_stat_notfound
  # Read inode
  call fs_read_inode
  la t0, fs_inode_buf
  # Copy type (0) and size (4) into stat_buf
  lw t1, 0(t0)
  sw t1, 0(s1)     # stat.type
  lw t1, 4(t0)
  sw t1, 4(s1)     # stat.size
  li a0, 0
  j sys_stat_done
sys_stat_notfound:
  li a0, -1
sys_stat_done:
  lw s1, 0(sp)
  lw s0, 4(sp)
  lw ra, 8(sp)
  addi sp, sp, 12
  ret

sys_handle_mkdir:
  # a0 = path_ptr
  addi sp, sp, -8
  sw ra, 4(sp)
  mv a1, a0
  li a0, 0         # parent root
  call fs_mkdir
  lw ra, 4(sp)
  addi sp, sp, 8
  ret

sys_handle_unlink:
  # a0 = path_ptr
  addi sp, sp, -8
  sw ra, 4(sp)
  mv a1, a0
  li a0, 0
  call fs_unlink
  lw ra, 4(sp)
  addi sp, sp, 8
  ret

sys_handle_exec:
  j sys_exec

sys_handle_halt:
  la t0, tohost
  li t1, 1
  sw t1, 0(t0)
  # Spin if still running
sys_halt_spin:
  wfi
  j sys_halt_spin

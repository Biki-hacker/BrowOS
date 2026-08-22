# syscall.s - Syscall Dispatcher and System Call Implementations.

.section .text
.align 2
.global syscall_dispatch
.global sys_getpid
.global sys_write
.global sys_read
.global sys_chdir
.global sys_getcwd
.global sys_lseek
.global ofile_clear
.global ofile_copy

# syscall_dispatch(a7=num, a0..a5=args): Dispatches system call by number.
syscall_dispatch:
  li t0, 1  # SYS_EXIT
  bne a7, t0, sysc_1
  j sys_handle_exit
sysc_1:
  li t0, 2  # SYS_FORK
  bne a7, t0, sysc_2
  j sys_fork
sysc_2:
  li t0, 3  # SYS_YIELD
  bne a7, t0, sysc_3
  j sys_handle_yield
sysc_3:
  li t0, 4  # SYS_SLEEP
  bne a7, t0, sysc_4
  j sys_handle_sleep
sysc_4:
  li t0, 5  # SYS_GETPID
  bne a7, t0, sysc_5
  j sys_handle_getpid
sysc_5:
  li t0, 6  # SYS_WRITE
  bne a7, t0, sysc_6
  j sys_handle_write
sysc_6:
  li t0, 7  # SYS_READ
  bne a7, t0, sysc_7
  j sys_handle_read
sysc_7:
  li t0, 8  # SYS_OPEN
  bne a7, t0, sysc_8
  j sys_handle_open
sysc_8:
  li t0, 9  # SYS_CLOSE
  bne a7, t0, sysc_9
  j sys_handle_close
sysc_9:
  li t0, 10 # SYS_STAT
  bne a7, t0, sysc_10
  j sys_handle_stat
sysc_10:
  li t0, 11 # SYS_MKDIR
  bne a7, t0, sysc_11
  j sys_handle_mkdir
sysc_11:
  li t0, 12 # SYS_UNLINK
  bne a7, t0, sysc_12
  j sys_handle_unlink
sysc_12:
  li t0, 13 # SYS_EXEC
  bne a7, t0, sysc_13
  j sys_handle_exec
sysc_13:
  li t0, 15 # SYS_HALT
  bne a7, t0, sysc_14
  j sys_handle_halt
sysc_14:
  li t0, 16 # SYS_PIPE
  bne a7, t0, sysc_15
  j sys_pipe
sysc_15:
  li t0, 17 # SYS_KILL
  bne a7, t0, sysc_16
  j sys_kill
sysc_16:
  li t0, 18 # SYS_WAITPID
  bne a7, t0, sysc_17
  j sys_waitpid
sysc_17:
  li t0, 19 # SYS_GPU
  bne a7, t0, sysc_18
  j sys_gpu_dispatch
sysc_18:
  li t0, 20 # SYS_CHDIR
  bne a7, t0, sysc_19
  j sys_chdir
sysc_19:
  li t0, 21 # SYS_GETCWD
  bne a7, t0, sysc_20
  j sys_getcwd
sysc_20:
  li t0, 22 # SYS_LSEEK
  bne a7, t0, sysc_21
  j sys_lseek
sysc_21:

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
  # File fds: 3..3+MAX_OFILES-1, offset tracked in the ofile table
  addi sp, sp, -24
  sw ra, 20(sp)
  sw s0, 16(sp)
  sw s1, 12(sp)
  sw s2, 8(sp)
  sw s3, 4(sp)
  sw s4, 0(sp)
  mv s1, a1        # buf
  mv s2, a2        # count
  la t0, current_proc
  lw s3, 0(t0)     # pcb
  beqz s3, sys_write_badfd
  addi s0, a0, -3  # s0 = slot
  li t0, MAX_OFILES
  bgeu s0, t0, sys_write_badfd
  mv a0, s3
  call ofile_base
  slli t0, s0, 4
  add s4, a0, t0   # s4 = &ofile[slot]
  lw t0, 0(s4)     # type
  li t1, 1         # OFILE_FILE
  bne t0, t1, sys_write_badfd
  lw s0, 4(s4)     # inode
  lw a1, 8(s4)     # offset
  mv a0, s0
  mv a2, s1
  mv a3, s2
  call fs_write
  # Advance the ofile offset by bytes written
  lw t0, 8(s4)
  add t0, t0, a0
  sw t0, 8(s4)
  j sys_write_ret

sys_write_badfd:
  li a0, -1

sys_write_ret:
  lw s4, 0(sp)
  lw s3, 4(sp)
  lw s2, 8(sp)
  lw s1, 12(sp)
  lw s0, 16(sp)
  lw ra, 20(sp)
  addi sp, sp, 24
  ret

sys_write_uart:
  # Write a2 bytes from a1 to UART
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)
  sw s2, 0(sp)
  mv s0, a1       # buf
  mv s1, a2       # count
  li s2, 0        # index
sys_write_uart_loop:
  bge s2, s1, sys_write_uart_done
  add t1, s0, s2
  lbu a0, 0(t1)
  call uart_putc
  addi s2, s2, 1
  j sys_write_uart_loop
sys_write_uart_done:
  mv a0, s1
  lw s2, 0(sp)
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
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
  # File fds: 3..3+MAX_OFILES-1, offset tracked in the ofile table
  addi sp, sp, -24
  sw ra, 20(sp)
  sw s0, 16(sp)
  sw s1, 12(sp)
  sw s2, 8(sp)
  sw s3, 4(sp)
  sw s4, 0(sp)
  mv s1, a1        # buf
  mv s2, a2        # count
  la t0, current_proc
  lw s3, 0(t0)     # pcb
  beqz s3, sys_read_badfd
  addi s0, a0, -3  # s0 = slot
  li t0, MAX_OFILES
  bgeu s0, t0, sys_read_badfd
  mv a0, s3
  call ofile_base
  slli t0, s0, 4
  add s4, a0, t0   # s4 = &ofile[slot]
  lw t0, 0(s4)     # type
  li t1, 1         # OFILE_FILE
  bne t0, t1, sys_read_badfd
  lw s0, 4(s4)     # inode
  lw a1, 8(s4)     # offset
  mv a0, s0
  mv a2, s1
  mv a3, s2
  call fs_read
  # Advance the ofile offset by bytes read
  lw t0, 8(s4)
  add t0, t0, a0
  sw t0, 8(s4)
  j sys_read_ret

sys_read_badfd:
  li a0, -1

sys_read_ret:
  lw s4, 0(sp)
  lw s3, 4(sp)
  lw s2, 8(sp)
  lw s1, 12(sp)
  lw s0, 16(sp)
  lw ra, 20(sp)
  addi sp, sp, 24
  ret

sys_read_pipe:
  # a0 = fd (>= 100), a1 = buf_ptr, a2 = count
  addi t0, a0, -100
  srli a0, t0, 1       # pipe_id = (fd - 100) / 2
  j pipe_read

sys_read_uart:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)
  sw s2, 0(sp)
  mv s0, a1       # buf
  mv s1, a2       # max count
  li s2, 0        # count read
sys_read_uart_loop:
  bge s2, s1, sys_read_uart_done
  call uart_getc
  li t1, -1
  beq a0, t1, sys_read_uart_done
  add t2, s0, s2
  sb a0, 0(t2)
  addi s2, s2, 1
  j sys_read_uart_loop
sys_read_uart_done:
  mv a0, s2
  lw s2, 0(sp)
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

sys_handle_open:
  # a0 = path_ptr, a1 = flags
  addi sp, sp, -28
  sw ra, 24(sp)
  sw s0, 20(sp)
  sw s1, 16(sp)
  sw s2, 12(sp)
  sw s3, 8(sp)
  sw s4, 4(sp)
  sw s5, 0(sp)
  mv s1, a0        # path_ptr
  mv s2, a1        # flags
  la t0, current_proc
  lw s0, 0(t0)     # pcb
  beqz s0, sys_open_notfound

  # Try to resolve the path relative to the current working directory
  lw a0, 40(s0)    # pcb.cwd
  mv a1, s1
  call fs_resolve
  li t0, -1
  bne a0, t0, sys_open_found
  mv s3, a0

  # Not found: create only if O_CREATE
  andi t1, s2, O_CREATE
  beqz t1, sys_open_notfound
  lw a0, 40(s0)    # pcb.cwd
  mv a1, s1
  call fs_resolve_parent
  li t0, -1
  beq a0, t0, sys_open_notfound
  mv s4, a0        # parent inode
  mv a0, s4
  la a1, fs_path_scratch
  li a2, 1         # BRFS_INODE_FILE
  call fs_create
  li t0, -1
  beq a0, t0, sys_open_notfound
  j sys_open_found

sys_open_found:
  # a0 = inode_no
  mv s3, a0

  # O_TRUNC: truncate file contents (only for regular files)
  andi t1, s2, O_TRUNC
  beqz t1, sys_open_alloc
  mv a0, s3
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 0(t0)
  li t2, 1         # BRFS_INODE_FILE
  bne t1, t2, sys_open_alloc
  mv a0, s3
  call fs_truncate

sys_open_alloc:
  # Allocate an ofile slot for the current process
  mv a0, s0        # pcb
  call ofile_alloc
  li t0, -1
  beq a0, t0, sys_open_notfound
  mv s5, a0        # s5 = slot
  mv a0, s0
  call ofile_base
  slli t0, s5, 4
  add s4, a0, t0   # s4 = &ofile[slot]

  li t0, 1         # OFILE_FILE
  sw t0, 0(s4)
  sw s3, 4(s4)     # inode
  # Initial offset: file size if O_APPEND, else 0
  andi t1, s2, O_APPEND
  beqz t1, sys_open_off0
  mv a0, s3
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 4(t0)
  sw t1, 8(s4)
  j sys_open_offdone
sys_open_off0:
  sw x0, 8(s4)
sys_open_offdone:
  sw s2, 12(s4)    # flags

  addi a0, s5, 3   # fd = 3 + slot
  j sys_open_ret

sys_open_notfound:
  li a0, -1

sys_open_ret:
  lw s5, 0(sp)
  lw s4, 4(sp)
  lw s3, 8(sp)
  lw s2, 12(sp)
  lw s1, 16(sp)
  lw s0, 20(sp)
  lw ra, 24(sp)
  addi sp, sp, 28
  ret

sys_handle_close:
  # a0 = fd
  li t0, 100
  bgeu a0, t0, sys_close_pipe
  li t0, 3
  blt a0, t0, sys_close_bad
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  addi s0, a0, -3          # s0 = slot
  li t0, MAX_OFILES
  bgeu s0, t0, sys_close_bad_pop
  la t0, current_proc
  lw a0, 0(t0)
  beqz a0, sys_close_bad_pop
  call ofile_base
  slli t0, s0, 4
  add t0, a0, t0
  sw x0, 0(t0)             # mark slot free
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  li a0, 0
  ret
sys_close_bad_pop:
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
sys_close_bad:
  li a0, -1
  ret
sys_close_pipe:
  addi t0, a0, -100
  andi a1, t0, 1       # is_write = (fd - 100) % 2
  srli a0, t0, 1       # pipe_id = (fd - 100) / 2
  j pipe_close

sys_handle_stat:
  # a0 = path_ptr, a1 = stat_buf_ptr
  addi sp, sp, -20
  sw ra, 16(sp)
  sw s0, 12(sp)
  sw s1, 8(sp)
  mv s0, a0        # path_ptr
  mv s1, a1        # stat_buf_ptr

  la t0, current_proc
  lw t1, 0(t0)
  beqz t1, sys_stat_notfound
  lw a0, 40(t1)    # pcb.cwd
  mv a1, s0
  call fs_resolve
  li t0, -1
  beq a0, t0, sys_stat_notfound
  mv s2, a0        # s2 = inode_no

  # Read inode and copy type, size, nlinks, inode into stat_buf
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 0(t0)
  sw t1, 0(s1)     # stat.type
  lw t1, 4(t0)
  sw t1, 4(s1)     # stat.size
  lw t1, 8(t0)
  sw t1, 8(s1)     # stat.nlinks
  sw s2, 12(s1)    # stat.inode
  li a0, 0
  j sys_stat_done

sys_stat_notfound:
  li a0, -1

sys_stat_done:
  lw s2, 4(sp)
  lw s1, 8(sp)
  lw s0, 12(sp)
  lw ra, 16(sp)
  addi sp, sp, 20
  ret

sys_handle_mkdir:
  # a0 = path_ptr
  addi sp, sp, -20
  sw ra, 16(sp)
  sw s0, 12(sp)
  sw s1, 8(sp)
  mv s0, a0        # path_ptr

  la t0, current_proc
  lw t1, 0(t0)
  beqz t1, sys_mkdir_err
  lw a0, 40(t1)    # pcb.cwd
  mv a1, s0
  call fs_resolve_parent
  li t0, -1
  beq a0, t0, sys_mkdir_err
  mv s1, a0        # parent inode

  mv a0, s1
  la a1, fs_path_scratch
  li a2, 2         # BRFS_INODE_DIR
  call fs_create
  li t0, -1
  beq a0, t0, sys_mkdir_err
  li a0, 0
  j sys_mkdir_done

sys_mkdir_err:
  li a0, -1

sys_mkdir_done:
  lw s1, 8(sp)
  lw s0, 12(sp)
  lw ra, 16(sp)
  addi sp, sp, 20
  ret

sys_handle_unlink:
  # a0 = path_ptr
  addi sp, sp, -20
  sw ra, 16(sp)
  sw s0, 12(sp)
  sw s1, 8(sp)
  mv s0, a0        # path_ptr

  la t0, current_proc
  lw t1, 0(t0)
  beqz t1, sys_unlink_err
  lw a0, 40(t1)    # pcb.cwd
  mv a1, s0
  call fs_resolve_parent
  li t0, -1
  beq a0, t0, sys_unlink_err
  mv s1, a0        # parent inode

  mv a0, s1
  la a1, fs_path_scratch
  call fs_unlink
  li t0, -1
  beq a0, t0, sys_unlink_err
  li a0, 0
  j sys_unlink_done

sys_unlink_err:
  li a0, -1

sys_unlink_done:
  lw s1, 8(sp)
  lw s0, 12(sp)
  lw ra, 16(sp)
  addi sp, sp, 20
  ret

# ─── sys_chdir(a0=path_ptr) ───────────────────────────────────────────
# Changes the current working directory of the calling process.
# Returns a0 = 0 on success, -1 on error.
sys_chdir:
  addi sp, sp, -24
  sw ra, 20(sp)
  sw s0, 16(sp)
  sw s1, 12(sp)
  sw s2, 8(sp)
  mv s1, a0        # save path_ptr
  la t0, current_proc
  lw s0, 0(t0)     # s0 = pcb
  beqz s0, sys_chdir_err
  lw a0, 40(s0)    # pcb.cwd
  mv a1, s1        # path
  call fs_resolve
  li t0, -1
  beq a0, t0, sys_chdir_err
  mv s2, a0        # resolved inode
  mv a0, s2
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 0(t0)
  li t2, BRFS_INODE_DIR
  bne t1, t2, sys_chdir_err
  sw s2, 40(s0)    # pcb.cwd = new dir
  li a0, 0
  j sys_chdir_done
sys_chdir_err:
  li a0, -1
sys_chdir_done:
  lw s2, 8(sp)
  lw s1, 12(sp)
  lw s0, 16(sp)
  lw ra, 20(sp)
  addi sp, sp, 24
  ret

# ─── sys_getcwd(a0=buf_ptr, a1=size) ──────────────────────────────────
# Writes the absolute path of the current working directory to buf_ptr.
# Returns a0 = path length, or -1 on error.
sys_getcwd:
  addi sp, sp, -32
  sw ra, 28(sp)
  sw s0, 24(sp)
  sw s1, 20(sp)
  sw s2, 16(sp)
  sw s3, 12(sp)
  sw s4, 8(sp)
  sw s5, 4(sp)
  sw s6, 0(sp)
  mv s1, a0        # buf
  mv s2, a1        # size
  la t0, current_proc
  lw s0, 0(t0)     # pcb
  beqz s0, sys_getcwd_err

  lw s3, 40(s0)    # s3 = cur inode
  # Build the path backwards in fs_getcwd_scratch
  la s4, fs_getcwd_scratch
  addi s4, s4, 255
  sb x0, 0(s4)
  bnez s3, sys_getcwd_walk
  # cwd is root: write "/" and emit
  addi s4, s4, -1
  li t0, '/'
  sb t0, 0(s4)
  j sys_getcwd_emit

sys_getcwd_walk:
  # Find the parent of s3 via ".."
  mv a0, s3
  la a1, fs_str_dotdot
  call fs_lookup
  li t0, -1
  beq a0, t0, sys_getcwd_err
  mv s5, a0        # s5 = parent
  # Find s3's name within s5
  mv a0, s5
  mv a1, s3
  la a2, fs_path_scratch
  call fs_dir_name_of
  li t0, -1
  beq a0, t0, sys_getcwd_err

  # Prepend the name, then "/" (building backwards)
  la t0, fs_path_scratch
  li t1, 0
sys_getcwd_len:
  lbu t2, 0(t0)
  beqz t2, sys_getcwd_prepend
  addi t0, t0, 1
  addi t1, t1, 1
  j sys_getcwd_len
sys_getcwd_prepend:
  addi t0, t0, -1  # last name char
sys_getcwd_prepend_loop:
  beqz t1, sys_getcwd_prepend_slash
  lbu t2, 0(t0)
  la t3, fs_getcwd_scratch
  blt s4, t3, sys_getcwd_err   # overflow
  addi s4, s4, -1
  sb t2, 0(s4)
  addi t0, t0, -1
  addi t1, t1, -1
  j sys_getcwd_prepend_loop
sys_getcwd_prepend_slash:
  la t3, fs_getcwd_scratch
  blt s4, t3, sys_getcwd_err
  addi s4, s4, -1
  li t2, '/'
  sb t2, 0(s4)
  mv s3, s5
  bnez s3, sys_getcwd_walk

sys_getcwd_emit:
  # Copy from s4 to user buf
  la t0, fs_getcwd_scratch
  addi t0, t0, 256
  sub t1, t0, s4   # t1 = length (incl NUL)
  blt s2, t1, sys_getcwd_err
  mv s5, s1        # s5 = dst
  mv s6, s4        # s6 = src
  li t2, 0
sys_getcwd_copy:
  bge t2, t1, sys_getcwd_done
  lbu t3, 0(s6)
  sb t3, 0(s5)
  addi s6, s6, 1
  addi s5, s5, 1
  addi t2, t2, 1
  j sys_getcwd_copy
sys_getcwd_done:
  addi a0, t1, -1  # length without NUL
  j sys_getcwd_ret

sys_getcwd_err:
  li a0, -1

sys_getcwd_ret:
  lw s6, 0(sp)
  lw s5, 4(sp)
  lw s4, 8(sp)
  lw s3, 12(sp)
  lw s2, 16(sp)
  lw s1, 20(sp)
  lw s0, 24(sp)
  lw ra, 28(sp)
  addi sp, sp, 32
  ret

# ─── sys_lseek(a0=fd, a1=offset, a2=whence) ───────────────────────────
# whence: 0=SEEK_SET, 1=SEEK_CUR, 2=SEEK_END.
# Returns a0 = new offset, or -1 on error.
sys_lseek:
  addi sp, sp, -24
  sw ra, 20(sp)
  sw s0, 16(sp)
  sw s1, 12(sp)
  sw s2, 8(sp)
  sw s3, 4(sp)
  mv s1, a1        # offset
  mv s2, a2        # whence
  la t0, current_proc
  lw s3, 0(t0)     # pcb
  beqz s3, sys_lseek_err
  addi s0, a0, -3  # s0 = slot
  li t0, MAX_OFILES
  bgeu s0, t0, sys_lseek_err
  mv a0, s3
  call ofile_base
  slli t0, s0, 4
  add s3, a0, t0   # s3 = &ofile[slot]
  lw t0, 0(s3)
  li t1, 1         # OFILE_FILE
  bne t0, t1, sys_lseek_err

  # base = current offset (whence 1), size (whence 2), or 0 (whence 0)
  li t0, 1
  beq s2, t0, sys_lseek_cur
  li t0, 2
  beq s2, t0, sys_lseek_end
  li t0, 0
  j sys_lseek_have_base
sys_lseek_cur:
  lw t0, 8(s3)
  j sys_lseek_have_base
sys_lseek_end:
  lw a0, 4(s3)
  call fs_read_inode
  la t0, fs_inode_buf
  lw t0, 4(t0)     # file size
sys_lseek_have_base:
  add t0, t0, s1
  bltz t0, sys_lseek_err
  sw t0, 8(s3)
  mv a0, t0
  j sys_lseek_ret
sys_lseek_err:
  li a0, -1
sys_lseek_ret:
  lw s3, 4(sp)
  lw s2, 8(sp)
  lw s1, 12(sp)
  lw s0, 16(sp)
  lw ra, 20(sp)
  addi sp, sp, 24
  ret

# ─── ofile table helpers ──────────────────────────────────────────────

# ofile_base(a0=pcb) → a0 = base of that PCB's ofile array
ofile_base:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)
  la s0, proc_table
  sub a0, a0, s0        # byte offset of PCB
  li s1, PCB_SIZE
  div a0, a0, s1        # pcb index
  li s1, MAX_OFILES * OF_SIZE
  mul a0, a0, s1
  la s1, ofiles
  add a0, a0, s1
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# ofile_alloc(a0=pcb) → a0 = first free slot, or -1
ofile_alloc:
  addi sp, sp, -20
  sw ra, 16(sp)
  sw s0, 12(sp)
  sw s1, 8(sp)
  sw s2, 4(sp)
  mv s2, a0        # pcb
  call ofile_base
  mv s0, a0        # base
  li s1, 0
ofile_alloc_loop:
  li t0, MAX_OFILES
  bge s1, t0, ofile_alloc_fail
  slli t0, s1, 4
  add t0, s0, t0
  lw t1, 0(t0)
  beqz t1, ofile_alloc_done
  addi s1, s1, 1
  j ofile_alloc_loop
ofile_alloc_fail:
  li a0, -1
  j ofile_alloc_ret
ofile_alloc_done:
  mv a0, s1
ofile_alloc_ret:
  lw s2, 4(sp)
  lw s1, 8(sp)
  lw s0, 12(sp)
  lw ra, 16(sp)
  addi sp, sp, 20
  ret

# ofile_clear(a0=pcb): Marks all of the PCB's file descriptors as free.
ofile_clear:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)
  call ofile_base
  mv s0, a0
  li s1, 0
ofile_clear_loop:
  li t0, MAX_OFILES
  bge s1, t0, ofile_clear_done
  slli t0, s1, 4
  add t0, s0, t0
  sw x0, 0(t0)
  addi s1, s1, 1
  j ofile_clear_loop
ofile_clear_done:
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# ofile_copy(a0=parent_pcb, a1=child_pcb): Copies open file slots from
# parent to child during fork.
ofile_copy:
  addi sp, sp, -24
  sw ra, 20(sp)
  sw s0, 16(sp)
  sw s1, 12(sp)
  sw s2, 8(sp)
  sw s3, 4(sp)
  mv s2, a0        # parent pcb
  mv s3, a1        # child pcb
  call ofile_base
  mv s0, a0        # parent base
  mv a0, s3
  call ofile_base
  mv s1, a0        # child base
  li s3, 0
ofile_copy_loop:
  li t0, MAX_OFILES
  bge s3, t0, ofile_copy_done
  slli t0, s3, 4
  add t0, s0, t0
  lw t1, 0(t0)     # type
  beqz t1, ofile_copy_next
  add t2, s1, t0
  # Copy 16-byte slot: type, inode, offset, flags
  lw t3, 0(t0)
  sw t3, 0(t2)
  lw t3, 4(t0)
  sw t3, 4(t2)
  lw t3, 8(t0)
  sw t3, 8(t2)
  lw t3, 12(t0)
  sw t3, 12(t2)
ofile_copy_next:
  addi s3, s3, 1
  j ofile_copy_loop
ofile_copy_done:
  lw s3, 4(sp)
  lw s2, 8(sp)
  lw s1, 12(sp)
  lw s0, 16(sp)
  lw ra, 20(sp)
  addi sp, sp, 24
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

.section .bss
.align 4
.global ofiles
ofiles: .zero 4096  # 16 PCBs * 16 ofiles * 16 bytes


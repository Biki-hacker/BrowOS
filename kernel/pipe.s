# pipe.s - Kernel Pipe Subsystem for BrowOS.
# Implements FIFO ring buffers and IPC between processes.

.equ PIPE_BUF_SIZE, 1024
.equ MAX_PIPES,     8
.equ PIPE_STRUCT_SZ,32
.equ PIPE_FD_BASE,  100

.section .text
.align 2
.global pipe_init
.global pipe_alloc
.global pipe_read
.global pipe_write
.global pipe_close
.global sys_pipe

# pipe_init(): Initializes the pipe table.
pipe_init:
  la t0, pipe_table
  li t1, 0
  li t2, 64   # MAX_PIPES * PIPE_STRUCT_SZ / 4 = 8 * 32 / 4 = 64 words
pipe_init_clear:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, pipe_init_clear
  ret

# pipe_alloc(): Allocates a free pipe from the table.
# Returns a0 = pipe_id (0..MAX_PIPES-1), or -1 if full.
pipe_alloc:
  la t0, pipe_table
  li t1, 0
pipe_alloc_loop:
  li t2, MAX_PIPES
  bge t1, t2, pipe_alloc_full
  lw t3, 0(t0)        # pipe.state
  beqz t3, pipe_alloc_found
  addi t0, t0, PIPE_STRUCT_SZ
  addi t1, t1, 1
  j pipe_alloc_loop

pipe_alloc_found:
  # Initialize pipe struct at t0
  li t3, 1            # state = 1 (active)
  sw t3, 0(t0)
  # Compute buffer address for pipe t1
  la t4, pipe_buffers
  slli t5, t1, 10     # t1 * 1024
  add t4, t4, t5
  sw t4, 4(t0)        # buf_ptr
  sw x0, 8(t0)        # head = 0
  sw x0, 12(t0)       # tail = 0
  sw x0, 16(t0)       # count = 0
  li t3, 1
  sw t3, 20(t0)       # read_open = 1
  sw t3, 24(t0)       # write_open = 1
  mv a0, t1           # return pipe_id
  ret

pipe_alloc_full:
  li a0, -1
  ret

# pipe_write(a0=pipe_id, a1=src_buf, a2=count): Writes count bytes into pipe.
# Returns a0 = bytes written, or -1 on EPIPE (broken pipe).
pipe_write:
  li t0, MAX_PIPES
  bgeu a0, t0, pipe_write_err

  slli t0, a0, 5      # pipe_id * 32
  la t1, pipe_table
  add t0, t1, t0      # t0 = &pipe

  lw t2, 0(t0)        # state
  beqz t2, pipe_write_err

  lw t2, 20(t0)       # read_open
  beqz t2, pipe_write_err # reader closed -> EPIPE

  lw t1, 4(t0)        # t1 = buf_ptr
  lw t2, 8(t0)        # t2 = head
  lw t3, 16(t0)       # t3 = count

  li t4, 0            # written count
pipe_write_loop:
  bge t4, a2, pipe_write_done
  li t5, PIPE_BUF_SIZE
  bge t3, t5, pipe_write_done # buffer full

  # Copy byte: src_buf[t4] -> buf[head]
  add t5, a1, t4
  lbu t6, 0(t5)
  add t5, t1, t2
  sb t6, 0(t5)

  # head = (head + 1) % PIPE_BUF_SIZE
  addi t2, t2, 1
  andi t2, t2, 1023
  addi t3, t3, 1
  addi t4, t4, 1
  j pipe_write_loop

pipe_write_done:
  sw t2, 8(t0)        # update head
  sw t3, 16(t0)       # update count
  mv a0, t4           # return written
  ret

pipe_write_err:
  li a0, -1
  ret

# pipe_read(a0=pipe_id, a1=dst_buf, a2=max_count): Reads bytes from pipe.
# Returns a0 = bytes read (0 if EOF or empty).
pipe_read:
  li t0, MAX_PIPES
  bgeu a0, t0, pipe_read_err

  slli t0, a0, 5      # pipe_id * 32
  la t1, pipe_table
  add t0, t1, t0      # t0 = &pipe

  lw t2, 0(t0)        # state
  beqz t2, pipe_read_err

  lw t1, 4(t0)        # t1 = buf_ptr
  lw t2, 12(t0)       # t2 = tail
  lw t3, 16(t0)       # t3 = count

  beqz t3, pipe_read_empty

  li t4, 0            # read count
pipe_read_loop:
  bge t4, a2, pipe_read_done
  beqz t3, pipe_read_done

  # Copy byte: buf[tail] -> dst_buf[t4]
  add t5, t1, t2
  lbu t6, 0(t5)
  add t5, a1, t4
  sb t6, 0(t5)

  # tail = (tail + 1) % PIPE_BUF_SIZE
  addi t2, t2, 1
  andi t2, t2, 1023
  addi t3, t3, -1
  addi t4, t4, 1
  j pipe_read_loop

pipe_read_done:
  sw t2, 12(t0)       # update tail
  sw t3, 16(t0)       # update count
  mv a0, t4           # return read count
  ret

pipe_read_empty:
  # Check if writer is closed -> EOF
  lw t2, 24(t0)       # write_open
  beqz t2, pipe_read_eof
  li a0, 0            # no data ready
  ret
pipe_read_eof:
  li a0, 0            # EOF
  ret

pipe_read_err:
  li a0, -1
  ret

# pipe_close(a0=pipe_id, a1=is_write): Closes one endpoint of a pipe.
pipe_close:
  li t0, MAX_PIPES
  bgeu a0, t0, pipe_close_done

  slli t0, a0, 5
  la t1, pipe_table
  add t0, t1, t0

  bnez a1, pipe_close_write
  sw x0, 20(t0)       # read_open = 0
  j pipe_close_check
pipe_close_write:
  sw x0, 24(t0)       # write_open = 0

pipe_close_check:
  lw t1, 20(t0)       # read_open
  lw t2, 24(t0)       # write_open
  or t1, t1, t2
  bnez t1, pipe_close_done
  # Both closed: mark pipe free
  sw x0, 0(t0)        # state = 0

pipe_close_done:
  li a0, 0
  ret

# sys_pipe(a0=pipefds_ptr): System call 16.
sys_pipe:
  addi sp, sp, -12
  sw ra, 8(sp)
  sw s0, 4(sp)
  mv s0, a0           # s0 = pipefds_ptr

  call pipe_alloc
  li t0, -1
  beq a0, t0, sys_pipe_fail

  # Calculate fds: read_fd = 100 + id * 2, write_fd = 101 + id * 2
  slli t1, a0, 1
  addi t2, t1, PIPE_FD_BASE     # read_fd
  addi t3, t2, 1                # write_fd

  sw t2, 0(s0)        # pipefd[0] = read_fd
  sw t3, 4(s0)        # pipefd[1] = write_fd

  li a0, 0
  j sys_pipe_ret

sys_pipe_fail:
  li a0, -1

sys_pipe_ret:
  lw s0, 4(sp)
  lw ra, 8(sp)
  addi sp, sp, 12
  ret

.section .bss
.align 4
pipe_table:   .zero 256  # 8 pipes * 32 bytes
.align 12
pipe_buffers: .zero 8192 # 8 pipes * 1024 bytes

# main.s - boot entry and kernel self-test.
# Boots in M-mode; _start sets sp and calls kmain. kmain runs the
# physical-memory self-tests and reports via tohost
# (1 = pass, (testnum << 1) | 1 = fail).

.text
.globl _start
_start:
  la sp, stack_top
  call kmain
_start_spin:
  j _start_spin

# kmain: s0 = testnum, s1..s3 scratch; frame:
#   ra@40 s0@36 s1@32 s2@28 s3@24 f1@20 f2@16 f3@12 f4@8
.globl kmain
kmain:
  addi sp, sp, -44
  sw ra, 40(sp)
  sw s0, 36(sp)
  sw s1, 32(sp)
  sw s2, 28(sp)
  sw s3, 24(sp)

  call pmm_init

  # TEST 1: four frames: aligned, in RAM, nonzero, distinct
  li s0, 1
  call alloc_frame
  mv s1, a0
  call check_frame
  call alloc_frame
  mv s2, a0
  call check_frame
  call alloc_frame
  mv s3, a0
  call check_frame
  call alloc_frame
  sw a0, 20(sp)
  call check_frame
  beq s1, s2, kmain_fail
  beq s1, s3, kmain_fail
  lw t0, 20(sp)
  beq s1, t0, kmain_fail
  beq s2, s3, kmain_fail
  beq s2, t0, kmain_fail
  beq s3, t0, kmain_fail
  sw s1, 16(sp)
  sw s2, 12(sp)
  sw s3, 8(sp)

  # TEST 2: exhaustion; every allocatable frame is handed out exactly once
  li s0, 2
  li s1, 0
kmain_exhaust:
  call alloc_frame
  li t0, -1
  beq a0, t0, kmain_exhaust_done
  addi s1, s1, 1
  j kmain_exhaust
kmain_exhaust_done:
  li t0, NFRAMES
  li t1, KERNEL_FRAMES
  sub t0, t0, t1
  addi t0, t0, -4
  bne s1, t0, kmain_fail
  lw a0, 16(sp)
  call free_frame
  lw a0, 12(sp)
  call free_frame
  lw a0, 8(sp)
  call free_frame
  lw a0, 20(sp)
  call free_frame

  # TEST 3: the freed frame comes back on the next alloc
  li s0, 3
  call alloc_frame
  lw t0, 16(sp)
  bne a0, t0, kmain_fail

  # TEST 4: zero_frame clears a whole frame
  li s0, 4
  lw a0, 12(sp)
  li t0, 0xAA
  li t1, 1024
kmain_fill:
  sw t0, 0(a0)
  addi a0, a0, 4
  addi t1, t1, -1
  bnez t1, kmain_fill
  lw a0, 12(sp)
  call zero_frame
  lw a0, 12(sp)
  li t1, 1024
kmain_check_zero:
  lw t0, 0(a0)
  bnez t0, kmain_fail
  addi a0, a0, 4
  addi t1, t1, -1
  bnez t1, kmain_check_zero

  # TEST 5: refcounts keep a frame held until the last release
  li s0, 5
  call alloc_frame
  mv s2, a0
  call refcount_frame
  call refcount_frame
  call refcount_frame
  call release_frame
  call alloc_frame
  beq a0, s2, kmain_fail
  mv s3, a0
  mv a0, s2
  call release_frame
  mv a0, s2
  call release_frame
  mv a0, s3
  call free_frame
  call alloc_frame
  mv s3, a0
  call free_frame
  call alloc_frame
  bne a0, s2, kmain_fail

  # TEST 6: kmalloc/kfree roundtrip, alignment, free-list reuse
  li s0, 6
  li a0, 4
  call kmalloc
  beqz a0, kmain_fail
  mv s1, a0
  andi t0, a0, 15
  bnez t0, kmain_fail
  li a0, 32
  call kmalloc
  beqz a0, kmain_fail
  mv s2, a0
  andi t0, a0, 15
  bnez t0, kmain_fail
  li a0, 1000
  call kmalloc
  beqz a0, kmain_fail
  mv s3, a0
  andi t0, a0, 15
  bnez t0, kmain_fail
  li t0, 0xDEADBEEF
  sw t0, 0(s1)
  li t0, 0xCAFEBABE
  sw t0, 0(s2)
  li t0, 0x12345678
  sw t0, 0(s3)
  lw t0, 0(s1)
  li t1, 0xDEADBEEF
  bne t0, t1, kmain_fail
  lw t0, 0(s2)
  li t1, 0xCAFEBABE
  bne t0, t1, kmain_fail
  lw t0, 0(s3)
  li t1, 0x12345678
  bne t0, t1, kmain_fail
  mv a0, s1
  call kfree
  mv a0, s2
  call kfree
  li a0, 32
  call kmalloc
  bne a0, s2, kmain_fail
  mv s2, a0

  # TEST 7: heap exhaustion; count = (HEAP_END - HEAP_START - b2 - b3) / 32
  li s0, 7
  li s1, 0
kmain_heap_fill:
  li a0, 16
  call kmalloc
  beqz a0, kmain_heap_full
  addi s1, s1, 1
  j kmain_heap_fill
kmain_heap_full:
  li t0, 0x100000
  li t1, 1096
  sub t0, t0, t1
  srai t0, t0, 5
  addi t0, t0, 1
  bne s1, t0, kmain_fail

  # Reset PMM and Heap for kernel runtime
  call pmm_init
  la t0, heap_next
  li t1, HEAP_START
  sw t1, 0(t0)
  la t0, heap_free
  sw x0, 0(t0)

  # TEST 8: VMM initialization & Sv32 page table activation
  li s0, 8
  call vmm_init
  la t0, vmm_kernel_root
  lw a0, 0(t0)
  call check_frame

  # TEST 9: Process manager and process table creation
  li s0, 9
  call proc_init
  call trap_init
  call scheduler_init

  la a0, user_proc_1
  li a1, 1
  call proc_create
  beqz a0, kmain_fail
  mv s1, a0  # Proc 1
  lw t0, 4(s1)  # pid
  li t1, 1
  bne t0, t1, kmain_fail

  la a0, user_proc_2
  li a1, 2
  call proc_create
  beqz a0, kmain_fail
  mv s2, a0  # Proc 2
  lw t0, 4(s2)  # pid
  li t1, 2
  bne t0, t1, kmain_fail

  # TEST 10: Multitasking, yield, and syscall execution
  li s0, 10
  sw s1, 16(sp)
  sw s2, 20(sp)
  la t0, kmain_saved_sp
  sw sp, 0(t0)
  la t0, kmain_saved_ra
  la t1, kmain_sched_returned
  sw t1, 0(t0)
  call schedule
.global kmain_sched_returned
kmain_sched_returned:
  li s0, 10
  lw s1, 16(sp)
  lw s2, 20(sp)

  # Verify user process 1 completed and returned exit code 5! = 120
  lw t0, 32(s1)  # pcb.exitcode
  li t1, 120
  bne t0, t1, kmain_fail

  # Verify user process 2 completed and returned exit code sum 1..10 = 55
  lw t0, 32(s2)  # pcb.exitcode
  li t1, 55
  bne t0, t1, kmain_fail

  # Verify both processes reached ZOMBIE state (4)
  lw t0, 0(s1)  # proc 1 state
  li t1, 4
  bne t0, t1, kmain_fail

  lw t0, 0(s2)  # proc 2 state
  li t1, 4
  bne t0, t1, kmain_fail

  # Reset PMM and Heap again for device/FS tests
  call pmm_init
  la t0, heap_next
  li t1, HEAP_START
  sw t1, 0(t0)
  la t0, heap_free
  sw x0, 0(t0)
  call vmm_init
  call pipe_init

  # TEST 11: UART transmit and receive
  li s0, 11
  call uart_init

  # Transmit 'B' via UART
  li a0, 'B'
  call uart_putc

  # Transmit 'O' via UART
  li a0, 'O'
  call uart_putc

  # Transmit 'S' via UART
  li a0, 'S'
  call uart_putc

  # Read UART (should return -1 since no input is pending)
  call uart_getc
  li t0, -1
  bne a0, t0, kmain_fail

  # TEST 12: Block device sector read/write
  li s0, 12
  call blk_init
  beqz a0, kmain_fail     # capacity must be > 0

  # Write a known pattern to a scratch area in RAM, then write sector
  li t0, 0x00300000       # scratch area (3 MiB, in allocatable range)
  li t1, 0
  li t2, 128              # fill 512 bytes (128 words)
blk_test_fill:
  addi t3, t1, 0xA5
  sw t3, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, blk_test_fill

  # Write sector 2047 from RAM
  li a0, 2047
  li a1, 0x00300000
  call blk_write_sector
  bnez a0, kmain_fail

  # Clear the RAM area
  li t0, 0x00300000
  li t1, 128
blk_test_clear:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, -1
  bnez t1, blk_test_clear

  # Read sector 2047 back into RAM
  li a0, 2047
  li a1, 0x00300000
  call blk_read_sector
  bnez a0, kmain_fail

  # Verify pattern
  li t0, 0x00300000
  li t1, 0
  li t2, 128
blk_test_verify:
  lw t3, 0(t0)
  addi t4, t1, 0xA5
  bne t3, t4, kmain_fail
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, blk_test_verify

  # TEST 13: BrFS filesystem
  li s0, 13

  # Initialize filesystem (formats disk)
  call fs_init
  bnez a0, kmain_fail

  # Verify superblock was written
  la t0, fs_total_blocks
  lw t1, 0(t0)
  beqz t1, kmain_fail

  # Create /dev directory
  li a0, 0              # parent = root inode
  la a1, str_dev
  call fs_mkdir
  li t0, -1
  beq a0, t0, kmain_fail
  mv s1, a0             # s1 = dev inode

  # Create /tmp directory
  li a0, 0
  la a1, str_tmp
  call fs_mkdir
  li t0, -1
  beq a0, t0, kmain_fail
  mv s2, a0             # s2 = tmp inode

  # Lookup /dev from root
  li a0, 0
  la a1, str_dev
  call fs_lookup
  bne a0, s1, kmain_fail

  # Lookup /tmp from root
  li a0, 0
  la a1, str_tmp
  call fs_lookup
  bne a0, s2, kmain_fail

  # Create a file /tmp/hello
  mv a0, s2             # parent = /tmp inode
  la a1, str_hello
  li a2, BRFS_INODE_FILE
  call fs_create
  li t0, -1
  beq a0, t0, kmain_fail
  mv s3, a0             # s3 = hello file inode

  # Write "BrowOS\0" to the file
  mv a0, s3
  li a1, 0              # offset = 0
  la a2, str_browos
  li a3, 7              # 7 bytes including null
  call fs_write
  li t0, 7
  bne a0, t0, kmain_fail

  # Read it back to verify
  mv a0, s3
  li a1, 0
  la a2, fs_read_scratch
  li a3, 7
  call fs_read
  li t0, 7
  bne a0, t0, kmain_fail

  # Compare read data with original
  la t0, fs_read_scratch
  la t1, str_browos
  li t2, 0
fs_verify_loop:
  li t3, 7
  bge t2, t3, fs_verify_done
  lbu t4, 0(t0)
  lbu t5, 0(t1)
  bne t4, t5, kmain_fail
  addi t0, t0, 1
  addi t1, t1, 1
  addi t2, t2, 1
  j fs_verify_loop
fs_verify_done:

  # Unlink /tmp/hello
  mv a0, s2
  la a1, str_hello
  call fs_unlink
  bnez a0, kmain_fail

  # Verify lookup fails now
  mv a0, s2
  la a1, str_hello
  call fs_lookup
  li t0, -1
  bne a0, t0, kmain_fail

  # Initialize pipe and GPU subsystems
  call pipe_init
  call gpu_init

  # TEST 14: Check if /sh executable exists in root directory. If present, load and execute in U-mode!
  li s0, 14
  li a0, 0             # root dir inode
  la a1, str_sh
  call fs_lookup
  li t0, -1
  beq a0, t0, kmain_no_sh
  mv s3, a0            # s3 = /sh inode

  # Allocate user process for the shell
  call proc_alloc
  beqz a0, kmain_fail
  mv s1, a0            # s1 = shell PCB

  # Allocate virtual address space
  call vmm_create_space
  sw a0, 16(s1)        # pcb.satp = root_pa

  # Load ELF binary
  mv a0, s3
  mv a1, s1
  call elf_load
  bnez a0, kmain_fail

  # Mark RUNNABLE
  li t0, 1             # PROC_RUNNABLE
  sw t0, 0(s1)

  # Hand off CPU to scheduler to run shell!
  la t0, kmain_saved_sp
  sw sp, 0(t0)
  la t0, kmain_saved_ra
  la t1, kmain_sched_returned_14
  sw t1, 0(t0)
  call schedule
.global kmain_sched_returned_14
kmain_sched_returned_14:
  li t0, 1
  j kmain_report

kmain_no_sh:
  li t0, 1
  j kmain_report
kmain_fail:
  slli t0, s0, 1
  ori t0, t0, 1
kmain_report:
  la t1, tohost
  sw t0, 0(t1)
  lw ra, 40(sp)
  lw s0, 36(sp)
  lw s1, 32(sp)
  lw s2, 28(sp)
  lw s3, 24(sp)
  addi sp, sp, 44
  ret

# check_frame(a0): aligned, nonzero, below RAM_SIZE
check_frame:
  li t0, -1
  beq a0, t0, kmain_fail
  li t0, 0xFFF
  and t0, a0, t0
  bnez t0, kmain_fail
  li t0, RAM_SIZE
  bltu a0, t0, check_frame_ok
  j kmain_fail
check_frame_ok:
  ret

# User test process 1: Computes 5! = 120, yields, then exits with code 120
.align 2
.global user_proc_1
user_proc_1:
  li a0, 5
  li a1, 1
u1_loop:
  mul a1, a1, a0
  addi a0, a0, -1
  bgtz a0, u1_loop

  # Voluntary yield via syscall 3
  li a7, 3  # SYS_YIELD
  ecall

  # Exit with result 120 via syscall 1
  li a7, 1  # SYS_EXIT
  mv a0, a1 # a0 = 120
  ecall
u1_spin:
  j u1_spin

# User test process 2: Computes sum 1..10 = 55, then exits with code 55
.align 2
.global user_proc_2
user_proc_2:
  li a0, 10
  li a1, 0
u2_loop:
  add a1, a1, a0
  addi a0, a0, -1
  bgtz a0, u2_loop

  # Exit with result 55 via syscall 1
  li a7, 1  # SYS_EXIT
  mv a0, a1 # a0 = 55
  ecall
u2_spin:
  j u2_spin

.data
tohost: .word 0
fromhost: .word 0
.global kmain_saved_sp
kmain_saved_sp: .word 0
.global kmain_saved_ra
kmain_saved_ra: .word 0

str_dev:    .asciz "dev"
str_tmp:    .asciz "tmp"
str_hello:  .asciz "hello"
str_browos: .asciz "BrowOS"
str_sh:     .asciz "sh"

.bss
.align 12
stack: .zero 8192
stack_top:
.align 4
fs_read_scratch: .zero 64
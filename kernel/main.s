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

.data
tohost: .word 0
fromhost: .word 0

.bss
.align 12
stack: .zero 8192
stack_top:
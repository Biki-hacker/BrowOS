# pmm.s - physical frame allocator.
# Bitmap: 1 bit per 4 KiB frame; NFRAMES bits = 8192 bytes.
# Refcounts: 1 byte per frame, used by refcount_frame/release_frame.
# Hint: next scan start index, stored in pmm_hint.
# API (t* and a0 scratch only; ra caller-saved):
#   pmm_init()
#   alloc_frame() -> a0 frame address or -1
#   free_frame(a0)
#   zero_frame(a0)
#   refcount_frame(a0)
#   release_frame(a0)

.bss
pmm_bitmap: .zero 8192
pmm_refs: .zero 65536
pmm_hint: .zero 4

.text

.globl pmm_init
pmm_init:
  la t0, pmm_bitmap
  li t1, -1
  li t2, 0
pmm_init_kernel_loop:
  li t3, 64
  bge t2, t3, pmm_init_free_loop
  add t4, t0, t2
  sw t1, 0(t4)
  addi t2, t2, 4
  j pmm_init_kernel_loop
pmm_init_free_loop:
  li t3, 8192
  bge t2, t3, pmm_init_done
  add t4, t0, t2
  sw x0, 0(t4)
  addi t2, t2, 4
  j pmm_init_free_loop
pmm_init_done:
  la t0, pmm_hint
  li t1, KERNEL_FRAMES
  sw t1, 0(t0)
  ret

.globl alloc_frame
alloc_frame:
  la t0, pmm_hint
  lw t1, 0(t0)
  li t2, 0
pmm_alloc_scan:
  li t3, NFRAMES
  bge t2, t3, pmm_alloc_none
  addi t2, t2, 1
  srai t3, t1, 3
  andi t4, t1, 7
  la t5, pmm_bitmap
  add t5, t5, t3
  lbu t3, 0(t5)
  srl t3, t3, t4
  andi t3, t3, 1
  bnez t3, pmm_alloc_next
  lbu t3, 0(t5)
  li t4, 1
  andi t6, t1, 7
  sll t4, t4, t6
  or t3, t3, t4
  sb t3, 0(t5)
  mv t3, t1
  addi t1, t1, 1
  li t4, NFRAMES
  blt t1, t4, pmm_alloc_hint_ok
  li t1, 0
pmm_alloc_hint_ok:
  sw t1, 0(t0)
  slli t3, t3, 12
  mv a0, t3
  ret
pmm_alloc_next:
  addi t1, t1, 1
  li t4, NFRAMES
  blt t1, t4, pmm_alloc_scan
  li t1, 0
  j pmm_alloc_scan
pmm_alloc_none:
  li a0, -1
  ret

.globl free_frame
free_frame:
  srai t1, a0, 12
  la t2, pmm_refs
  add t2, t2, t1
  sb x0, 0(t2)
  srai t3, t1, 3
  andi t4, t1, 7
  la t5, pmm_bitmap
  add t5, t5, t3
  lbu t3, 0(t5)
  li t6, 1
  sll t6, t6, t4
  not t6, t6
  and t3, t3, t6
  sb t3, 0(t5)
  ret

.globl zero_frame
zero_frame:
  mv t1, a0
  li t0, 1024
pmm_zero_loop:
  sw x0, 0(t1)
  addi t1, t1, 4
  addi t0, t0, -1
  bnez t0, pmm_zero_loop
  ret

.globl refcount_frame
refcount_frame:
  srai t1, a0, 12
  la t2, pmm_refs
  add t2, t2, t1
  lbu t3, 0(t2)
  addi t3, t3, 1
  sb t3, 0(t2)
  ret

.globl release_frame
release_frame:
  srai t1, a0, 12
  la t2, pmm_refs
  add t2, t2, t1
  lbu t3, 0(t2)
  beqz t3, pmm_release_done
  addi t3, t3, -1
  sb t3, 0(t2)
  bnez t3, pmm_release_done
  srai t3, t1, 3
  andi t4, t1, 7
  la t5, pmm_bitmap
  add t5, t5, t3
  lbu t3, 0(t5)
  li t6, 1
  sll t6, t6, t4
  not t6, t6
  and t3, t3, t6
  sb t3, 0(t5)
pmm_release_done:
  ret
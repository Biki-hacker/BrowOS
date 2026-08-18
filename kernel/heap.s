# heap.s - kernel heap: kmalloc/kfree.
# Block layout: [size:4][next:4][pad:8][payload...]; payload 16-aligned.
# Free blocks live on a singly-linked list (heap_free); unused space past
# the last bump allocation grows from heap_next up to HEAP_END.
# API:
#   kmalloc(a0 = size) -> a0 payload pointer, or 0 on exhaustion
#   kfree(a0 = payload)

.bss
heap_next: .zero 4
heap_free: .zero 4

.text

.globl kmalloc
kmalloc:
  addi t0, a0, 15
  andi t0, t0, -16
  addi t0, t0, 16
  la t1, heap_free
  lw t2, 0(t1)
  li t3, 0
heap_km_fit:
  beqz t2, heap_km_bump
  lw t4, 0(t2)
  bge t4, t0, heap_km_found
  mv t3, t2
  lw t2, 4(t2)
  j heap_km_fit
heap_km_found:
  lw t4, 4(t2)
  beqz t3, heap_km_head
  sw t4, 4(t3)
  j heap_km_pop
heap_km_head:
  sw t4, 0(t1)
heap_km_pop:
  addi a0, t2, 16
  ret
heap_km_bump:
  la t3, heap_next
  lw t4, 0(t3)
  bnez t4, heap_km_bump_ok
  li t4, HEAP_START
heap_km_bump_ok:
  add t5, t4, t0
  li t6, HEAP_END
  bge t5, t6, heap_km_oom
  sw t0, 0(t4)
  sw x0, 4(t4)
  sw t5, 0(t3)
  addi a0, t4, 16
  ret
heap_km_oom:
  li a0, 0
  ret

.globl kfree
kfree:
  addi t0, a0, -16
  la t1, heap_free
  lw t2, 0(t1)
  sw t2, 4(t0)
  sw t0, 0(t1)
  ret
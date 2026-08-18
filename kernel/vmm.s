# vmm.s - Guest Virtual Memory Manager (Sv32)
# Manages two-level page tables, address spaces, and mappings.

.section .data
.align 4
.global vmm_kernel_root
vmm_kernel_root: .word 0

.section .text
.align 2
.global vmm_init
.global vmm_create_space
.global vmm_map_page
.global vmm_unmap_page
.global vmm_switch

# vmm_init(): Initializes the kernel root page table and activates Sv32.
vmm_init:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)

  # Allocate root frame
  call alloc_frame
  mv s0, a0
  la t0, vmm_kernel_root
  sw s0, 0(t0)

  # Zero root table
  mv a0, s0
  call zero_frame

  # Identity-map first 4 MiB (Kernel text, data, BSS, Heap) as 4 MiB Superpage (level 1 leaf)
  # PTE = (0x00000000 >> 12 << 10) | PTE_KERN_DATA | PTE_X | PTE_G
  # Flags: V(1) | R(2) | W(4) | X(8) | G(0x20) | A(0x40) | D(0x80) = 0xEF
  li t1, 0xEF
  sw t1, 0(s0)

  # Identity-map second 4 MiB (0x00400000 - 0x007FFFFF, RAM frames)
  # PTE = (0x00400000 >> 12 << 10) | 0xEF = (0x400 << 10) | 0xEF = 0x001000EF
  li t1, 0x001000EF
  sw t1, 4(s0)

  # Identity-map third 4 MiB (0x00800000 - 0x00BFFFFF)
  li t1, 0x002000EF
  sw t1, 8(s0)

  # Identity-map fourth 4 MiB (0x00C00000 - 0x00FFFFFF)
  li t1, 0x003000EF
  sw t1, 12(s0)

  # Identity-map CLINT timer (0x02000000 -> VPN[1] = 0x02000000 >> 22 = 8)
  # PTE = (0x02000000 >> 12 << 10) | 0xEF = (0x2000 << 10) | 0xEF = 0x008000EF
  li t1, 0x008000EF
  sw t1, 32(s0)

  # Activate Sv32 paging in kernel
  mv a0, s0
  call vmm_switch

  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# vmm_create_space(): Allocates a new root table and copies kernel mappings.
# Returns a0 = root_pa
vmm_create_space:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)

  call alloc_frame
  mv s0, a0
  call zero_frame

  # Copy kernel mappings (first 16 entries = 64 MiB and CLINT) from vmm_kernel_root
  la t0, vmm_kernel_root
  lw s1, 0(t0)

  li t2, 0
vmm_copy_loop:
  slli t3, t2, 2
  add t4, s1, t3
  lw t5, 0(t4)
  add t4, s0, t3
  sw t5, 0(t4)
  addi t2, t2, 1
  li t3, 64
  blt t2, t3, vmm_copy_loop

  mv a0, s0
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# vmm_map_page(a0=root_pa, a1=va, a2=pa, a3=flags)
# Maps a 4 KiB virtual page to physical page pa with flags.
vmm_map_page:
  addi sp, sp, -28
  sw ra, 24(sp)
  sw s0, 20(sp)
  sw s1, 16(sp)
  sw s2, 12(sp)
  sw s3, 8(sp)
  sw s4, 4(sp)

  mv s0, a0  # root_pa
  mv s1, a1  # va
  mv s2, a2  # pa
  mv s3, a3  # flags

  # vpn1 = (va >> 22) & 0x3FF
  srli t0, s1, 22
  andi t0, t0, 0x3FF
  slli t0, t0, 2
  add s4, s0, t0  # s4 = &pte1

  lw t1, 0(s4)
  andi t2, t1, 1  # PTE_V
  beqz t2, vmm_alloc_l0
  andi t2, t1, 0xE # R | W | X
  beqz t2, vmm_have_l0

vmm_alloc_l0:
  # Level 0 table missing, allocate frame
  call alloc_frame
  mv t3, a0
  mv a0, t3
  sw t3, 0(sp)
  call zero_frame
  lw t3, 0(sp)

  # Install PTE1 pointer: ((l0_pa >> 12) << 10) | PTE_V
  srli t4, t3, 12
  slli t4, t4, 10
  ori t4, t4, 1  # PTE_V
  sw t4, 0(s4)
  mv t1, t4

vmm_have_l0:
  # l0_pa = (pte1 >> 10) << 12
  srli t3, t1, 10
  slli t3, t3, 12

  # vpn0 = (va >> 12) & 0x3FF
  srli t0, s1, 12
  andi t0, t0, 0x3FF
  slli t0, t0, 2
  add t5, t3, t0  # t5 = &pte0

  # pte0 = ((pa >> 12) << 10) | (flags & 0xFF) | PTE_V | PTE_A | PTE_D
  srli t6, s2, 12
  slli t6, t6, 10
  andi t4, s3, 0xFF
  or t6, t6, t4
  ori t6, t6, 0xC1  # PTE_V | PTE_A | PTE_D
  sw t6, 0(t5)

  sfence.vma
  li a0, 0

  lw s4, 4(sp)
  lw s3, 8(sp)
  lw s2, 12(sp)
  lw s1, 16(sp)
  lw s0, 20(sp)
  lw ra, 24(sp)
  addi sp, sp, 28
  ret

# vmm_unmap_page(a0=root_pa, a1=va)
vmm_unmap_page:
  srli t0, a1, 22
  andi t0, t0, 0x3FF
  slli t0, t0, 2
  add t0, a0, t0  # &pte1

  lw t1, 0(t0)
  andi t2, t1, 1
  beqz t2, vmm_unmap_done

  srli t3, t1, 10
  slli t3, t3, 12  # l0_pa

  srli t0, a1, 12
  andi t0, t0, 0x3FF
  slli t0, t0, 2
  add t5, t3, t0  # &pte0
  sw x0, 0(t5)
  sfence.vma

vmm_unmap_done:
  ret

# vmm_switch(a0=root_pa): Loads satp with Sv32 mode and root_pa.
vmm_switch:
  srli t0, a0, 12
  li t1, 0x80000000
  or t0, t0, t1
  csrw satp, t0
  sfence.vma
  ret

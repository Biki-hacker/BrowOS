# fs.s - BrFS (BrowOS Filesystem) implementation.
#
# On-disk layout (4096-byte blocks):
#   Block 0: Superblock
#   Block 1: Free-block bitmap (1 bit per block, supports up to 32768 blocks)
#   Block 2..5: Inode table (128 inodes * 128 bytes = 16384 bytes = 4 blocks)
#   Block 6+: Data blocks (directories and file data)
#
# Superblock (block 0, at sector 0):
#   0x00: magic (0x42524653 = "BRFS")
#   0x04: total_blocks
#   0x08: total_inodes (128)
#   0x0C: free_blocks
#   0x10: first_data_block (6)
#   0x14: block_size (4096)
#
# Inode (128 bytes each):
#   0x00: type (0=free, 1=file, 2=dir)
#   0x04: size (bytes)
#   0x08: nlinks
#   0x0C..0x3B: direct[12] (12 block pointers, 48 bytes)
#   0x3C: indirect (1 block pointer)
#   0x40..0x7F: reserved
#
# Directory entry (32 bytes):
#   0x00: inode_no (4 bytes)
#   0x04: name (28 bytes, null-terminated)
#
# This implementation uses the block device for persistent storage but the
# filesystem operations themselves work through an in-kernel sector cache
# built on top of the block driver.

.section .text
.align 2
.global fs_init
.global fs_alloc_block
.global fs_free_block
.global fs_read_inode
.global fs_write_inode
.global fs_create
.global fs_lookup
.global fs_read
.global fs_write
.global fs_unlink
.global fs_mkdir
.global fs_bmap
.global fs_truncate
.global fs_free_inode_blocks
.global fs_dir_add
.global fs_dir_empty
.global fs_dir_name_of
.global fs_resolve
.global fs_resolve_parent

# ─── Sector cache helpers ──────────────────────────────────────────────
# We use a simple scratch buffer in kernel heap for block I/O.
# fs_read_block(a0=block_no): Reads 4096-byte block into fs_block_buf.
# Reads 8 consecutive 512-byte sectors.
fs_read_block:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)

  # sector = block_no * 8
  slli s0, a0, 3   # s0 = first sector
  la s1, fs_block_buf
  li t0, 0
fs_read_block_loop:
  add a0, s0, t0
  li t1, BLK_SECTOR_SIZE
  mul t1, t1, t0
  add a1, s1, t1
  sw t0, 0(sp)
  call blk_read_sector
  lw t0, 0(sp)
  addi t0, t0, 1
  li t1, BRFS_SECTS_PER_BLK
  blt t0, t1, fs_read_block_loop

  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# fs_write_block(a0=block_no): Writes fs_block_buf to 8 sectors on disk.
fs_write_block:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)

  slli s0, a0, 3
  la s1, fs_block_buf
  li t0, 0
fs_write_block_loop:
  add a0, s0, t0
  li t1, BLK_SECTOR_SIZE
  mul t1, t1, t0
  add a1, s1, t1
  sw t0, 0(sp)
  call blk_write_sector
  lw t0, 0(sp)
  addi t0, t0, 1
  li t1, BRFS_SECTS_PER_BLK
  blt t0, t1, fs_write_block_loop

  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# ─── fs_init ───────────────────────────────────────────────────────────
# Formats the block device with BrFS if not already formatted.
# Creates root directory (inode 0).
# Returns a0 = 0 on success, -1 on error.
fs_init:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)

  # Read superblock (block 0)
  li a0, 0
  call fs_read_block
  la t0, fs_block_buf
  lw t1, 0(t0)         # magic
  li t2, BRFS_MAGIC
  beq t1, t2, fs_init_mounted

  # Format: compute total blocks from disk capacity
  call blk_capacity
  # a0 = total sectors
  srli s0, a0, 3       # total_blocks = sectors / 8
  beqz s0, fs_init_err

  # Store totals, then allocate the root directory data block BEFORE writing
  # the superblock so its free_blocks count matches the bitmap.
  la t1, fs_total_blocks
  sw s0, 0(t1)
  li t1, 6             # first 6 blocks reserved (super + bitmap + 4 inode blocks)
  sub t2, s0, t1
  la t1, fs_free_blocks
  sw t2, 0(t1)

  call fs_alloc_block
  bltz a0, fs_init_err
  mv s1, a0            # s1 = root dir data block

  # Write superblock
  la t0, fs_block_buf
  # Clear buffer first
  li t1, 0
  li t2, 1024
fs_init_clear_sb:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, fs_init_clear_sb

  la t0, fs_block_buf
  li t1, BRFS_MAGIC
  sw t1, 0(t0)         # magic
  sw s0, 4(t0)         # total_blocks
  li t1, BRFS_MAX_INODES
  sw t1, 8(t0)         # total_inodes
  la t1, fs_free_blocks
  lw t2, 0(t1)
  sw t2, 12(t0)        # free_blocks
  li t1, 6
  sw t1, 16(t0)        # first_data_block
  li t1, BRFS_BLOCK_SIZE
  sw t1, 20(t0)        # block_size

  li a0, 0
  call fs_write_block

  # Clear bitmap (block 1): mark first 6 blocks as used
  la t0, fs_block_buf
  li t1, 0
  li t2, 1024
fs_init_clear_bm:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, fs_init_clear_bm

  la t0, fs_block_buf
  li t1, 0x3F           # bits 0..5 set = blocks 0..5 used
  sw t1, 0(t0)
  li a0, 1
  call fs_write_block

  # Clear inode table (blocks 2..5)
  la t0, fs_block_buf
  li t1, 0
  li t2, 1024
fs_init_clear_inodes:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, fs_init_clear_inodes

  li s1, 2
fs_init_write_inodes:
  mv a0, s1
  call fs_write_block
  addi s1, s1, 1
  li t0, 6
  blt s1, t0, fs_init_write_inodes

  # Create root directory inode (inode 0)
  # s1 already holds the root dir data block allocated above

  # Write root inode: type=DIR, size=0, nlinks=2, direct[0]=data_block
  la t0, fs_block_buf
  li t1, 0
  li t2, 1024
fs_init_clear_root:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, fs_init_clear_root

  la t0, fs_block_buf
  li t1, BRFS_INODE_DIR
  sw t1, 0(t0)         # type = DIR
  # Write "." and ".." entries to root dir data block
  # Size = 2 entries * 32 bytes = 64
  li t1, 64
  sw t1, 4(t0)         # size = 64
  li t1, 2
  sw t1, 8(t0)         # nlinks = 2
  sw s1, 12(t0)        # direct[0] = data block

  # Write inode 0 to block 2 (first inode block)
  li a0, 2
  call fs_write_block

  # Write root dir data block with "." and ".." entries
  la t0, fs_block_buf
  li t1, 0
  li t2, 1024
fs_init_clear_dir:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, fs_init_clear_dir

  la t0, fs_block_buf
  # Entry 0: "." -> inode 0
  sw x0, 0(t0)         # inode_no = 0
  li t1, '.'
  sb t1, 4(t0)
  sb x0, 5(t0)
  # Entry 1: ".." -> inode 0
  sw x0, 32(t0)        # inode_no = 0
  li t1, '.'
  sb t1, 36(t0)
  sb t1, 37(t0)
  sb x0, 38(t0)

  mv a0, s1
  call fs_write_block

fs_init_mounted:
  # Store superblock info
  la t0, fs_block_buf
  la t1, fs_total_blocks
  lw t2, 4(t0)
  sw t2, 0(t1)
  la t1, fs_free_blocks
  lw t2, 12(t0)
  sw t2, 0(t1)

  li a0, 0
  j fs_init_done

fs_init_err:
  li a0, -1

fs_init_done:
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# ─── fs_alloc_block ────────────────────────────────────────────────────
# Allocates a free data block from the bitmap.
# Returns a0 = block number, or -1 if full.
fs_alloc_block:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)

  # Read bitmap block
  li a0, 1
  call fs_read_block

  la s0, fs_block_buf
  la t0, fs_total_blocks
  lw s1, 0(t0)        # total blocks

  li t0, 0             # current block index
fs_alloc_scan:
  bge t0, s1, fs_alloc_full
  # byte index = t0 / 8, bit index = t0 % 8
  srli t1, t0, 3       # byte offset
  andi t2, t0, 7       # bit index
  add t3, s0, t1
  lbu t4, 0(t3)
  li t5, 1
  sll t5, t5, t2
  and t6, t4, t5
  bnez t6, fs_alloc_next
  # Found free block at t0
  or t4, t4, t5
  sb t4, 0(t3)
  # Write bitmap back
  sw t0, 0(sp)
  li a0, 1
  call fs_write_block
  lw a0, 0(sp)
  # Decrement free_blocks
  la t1, fs_free_blocks
  lw t2, 0(t1)
  addi t2, t2, -1
  sw t2, 0(t1)
  j fs_alloc_done

fs_alloc_next:
  addi t0, t0, 1
  j fs_alloc_scan

fs_alloc_full:
  li a0, -1

fs_alloc_done:
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# ─── fs_free_block(a0=block_no) ───────────────────────────────────────
# Frees a block by clearing its bit in the bitmap.
fs_free_block:
  addi sp, sp, -12
  sw ra, 8(sp)
  sw s0, 4(sp)
  mv s0, a0

  li a0, 1
  call fs_read_block

  la t0, fs_block_buf
  srli t1, s0, 3
  andi t2, s0, 7
  add t3, t0, t1
  lbu t4, 0(t3)
  li t5, 1
  sll t5, t5, t2
  not t5, t5
  and t4, t4, t5
  sb t4, 0(t3)

  li a0, 1
  call fs_write_block

  la t1, fs_free_blocks
  lw t2, 0(t1)
  addi t2, t2, 1
  sw t2, 0(t1)

  mv a0, s0
  lw s0, 4(sp)
  lw ra, 8(sp)
  addi sp, sp, 12
  ret

# ─── fs_zero_block(a0=block_no) ───────────────────────────────────────
# Zero-fills the block on disk.
fs_zero_block:
  addi sp, sp, -12
  sw ra, 8(sp)
  sw s0, 4(sp)
  mv s0, a0
  la t0, fs_block_buf
  li t1, 0
  li t2, 1024
fs_zero_block_loop:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, fs_zero_block_loop
  mv a0, s0
  call fs_write_block
  lw s0, 4(sp)
  lw ra, 8(sp)
  addi sp, sp, 12
  ret

# ─── fs_bmap(a0=inode_no, a1=block_idx, a2=create) ────────────────────
# Resolves block_idx to a data block number: direct[0..11] first, then a
# single indirect block (1024 pointers). If create != 0, missing blocks
# are allocated (and zero-filled); fs_inode_buf must already hold the inode.
# Returns a0 = block_no, 0 if missing (create == 0), -1 on error.
fs_bmap:
  addi sp, sp, -24
  sw ra, 20(sp)
  sw s0, 16(sp)
  sw s1, 12(sp)
  sw s2, 8(sp)
  sw s3, 4(sp)
  mv s0, a1            # s0 = block_idx
  mv s1, a2            # s1 = create flag

  li t0, BRFS_MAX_DIRECT
  bge s0, t0, fs_bmap_indirect

  # Direct pointer
  slli t0, s0, 2
  addi t0, t0, 12
  la t1, fs_inode_buf
  add t1, t1, t0
  lw a0, 0(t1)
  bnez a0, fs_bmap_done
  beqz s1, fs_bmap_missing
  mv s3, t1            # s3 = &direct[block_idx]
  call fs_alloc_block
  li t0, -1
  beq a0, t0, fs_bmap_err
  mv s2, a0
  sw s2, 0(s3)
  mv a0, s2
  call fs_zero_block
  mv a0, s2
  j fs_bmap_done

fs_bmap_indirect:
  li t0, BRFS_MAX_DIRECT
  li t1, 1024
  add t0, t0, t1
  bge s0, t0, fs_bmap_err     # block_idx too large
  addi s2, s0, -12            # s2 = index within indirect block
  la t0, fs_inode_buf
  lw s0, 60(t0)               # s0 = indirect block
  bnez s0, fs_bmap_ind_have
  beqz s1, fs_bmap_missing
  call fs_alloc_block
  li t0, -1
  beq a0, t0, fs_bmap_err
  mv s0, a0
  mv a0, s0
  call fs_zero_block
  la t0, fs_inode_buf
  sw s0, 60(t0)               # inode.indirect = s0

fs_bmap_ind_have:
  mv a0, s0
  call fs_read_block           # indirect block into fs_block_buf
  slli t0, s2, 2
  la t1, fs_block_buf
  add t1, t1, t0
  lw a0, 0(t1)
  bnez a0, fs_bmap_done
  beqz s1, fs_bmap_missing
  mv s3, t1
  call fs_alloc_block
  li t0, -1
  beq a0, t0, fs_bmap_err
  mv s2, a0
  sw s2, 0(s3)
  mv a0, s0
  call fs_write_block          # persist indirect block
  mv a0, s2
  j fs_bmap_done

fs_bmap_missing:
  li a0, 0
  j fs_bmap_done

fs_bmap_err:
  li a0, -1

fs_bmap_done:
  lw s3, 4(sp)
  lw s2, 8(sp)
  lw s1, 12(sp)
  lw s0, 16(sp)
  lw ra, 20(sp)
  addi sp, sp, 24
  ret

# ─── fs_free_inode_data(a0=inode_no) ──────────────────────────────────
# Frees all data blocks (direct + indirect) of the inode and zeroes the
# block pointers in fs_inode_buf. The inode is NOT written back and its
# type/size/nlinks fields are preserved.
# Returns a0 = 0.
fs_free_inode_data:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)
  sw s2, 0(sp)
  mv s0, a0            # s0 = inode_no
  call fs_read_inode

  li s1, 0
fs_fid_direct:
  li t0, BRFS_MAX_DIRECT
  bge s1, t0, fs_fid_indirect
  slli t0, s1, 2
  addi t0, t0, 12
  la t1, fs_inode_buf
  add t1, t1, t0
  lw s2, 0(t1)
  beqz s2, fs_fid_direct_next
  mv a0, s2
  call fs_free_block
  slli t0, s1, 2
  addi t0, t0, 12
  la t1, fs_inode_buf
  add t1, t1, t0
  sw x0, 0(t1)
fs_fid_direct_next:
  addi s1, s1, 1
  j fs_fid_direct

fs_fid_indirect:
  la t0, fs_inode_buf
  lw s2, 60(t0)        # s2 = indirect block
  beqz s2, fs_fid_done
  mv a0, s2
  call fs_read_block
  li s1, 0
fs_fid_ind_loop:
  li t0, 1024
  bge s1, t0, fs_fid_ind_free
  slli t0, s1, 2
  la t1, fs_block_buf
  add t1, t1, t0
  lw t2, 0(t1)
  beqz t2, fs_fid_ind_next
  mv a0, t2
  call fs_free_block
fs_fid_ind_next:
  addi s1, s1, 1
  j fs_fid_ind_loop
fs_fid_ind_free:
  mv a0, s2
  call fs_free_block
  la t0, fs_inode_buf
  sw x0, 60(t0)

fs_fid_done:
  li a0, 0
  lw s2, 0(sp)
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# ─── fs_free_inode_blocks(a0=inode_no) ────────────────────────────────
# Frees all data blocks of the inode and zeroes the inode slot entirely.
# Returns a0 = 0.
fs_free_inode_blocks:
  addi sp, sp, -12
  sw ra, 8(sp)
  sw s0, 4(sp)
  mv s0, a0
  call fs_free_inode_data
  la t0, fs_inode_buf
  li t1, 0
  li t2, 32
fs_fib_zero:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, fs_fib_zero
  mv a0, s0
  call fs_write_inode
  li a0, 0
  lw s0, 4(sp)
  lw ra, 8(sp)
  addi sp, sp, 12
  ret

# ─── fs_truncate(a0=inode_no) ─────────────────────────────────────────
# Frees all data blocks of a file and sets its size to 0 (type preserved).
# Returns a0 = 0.
fs_truncate:
  addi sp, sp, -12
  sw ra, 8(sp)
  sw s0, 4(sp)
  mv s0, a0
  call fs_free_inode_data
  la t0, fs_inode_buf
  sw x0, 4(t0)         # size = 0
  mv a0, s0
  call fs_write_inode
  li a0, 0
  lw s0, 4(sp)
  lw ra, 8(sp)
  addi sp, sp, 12
  ret

# ─── fs_read_inode(a0=inode_no) ───────────────────────────────────────
# Reads inode into fs_inode_buf (128 bytes).
# Inode N is at block (2 + N/32), offset (N%32)*128 within block.
fs_read_inode:
  addi sp, sp, -12
  sw ra, 8(sp)
  sw s0, 4(sp)
  mv s0, a0

  # block = 2 + inode_no / 32
  srli t0, s0, 5
  addi a0, t0, 2
  call fs_read_block

  # offset = (inode_no % 32) * 128
  andi t0, s0, 31
  slli t0, t0, 7     # *128
  la t1, fs_block_buf
  add t1, t1, t0
  la t2, fs_inode_buf

  # Copy 128 bytes (32 words)
  li t3, 0
fs_read_inode_copy:
  lw t4, 0(t1)
  sw t4, 0(t2)
  addi t1, t1, 4
  addi t2, t2, 4
  addi t3, t3, 1
  li t5, 32
  blt t3, t5, fs_read_inode_copy

  lw s0, 4(sp)
  lw ra, 8(sp)
  addi sp, sp, 12
  ret

# ─── fs_write_inode(a0=inode_no) ──────────────────────────────────────
# Writes fs_inode_buf back to disk.
fs_write_inode:
  addi sp, sp, -12
  sw ra, 8(sp)
  sw s0, 4(sp)
  mv s0, a0

  srli t0, s0, 5
  addi a0, t0, 2
  sw a0, 0(sp)
  call fs_read_block

  andi t0, s0, 31
  slli t0, t0, 7
  la t1, fs_block_buf
  add t1, t1, t0
  la t2, fs_inode_buf

  li t3, 0
fs_write_inode_copy:
  lw t4, 0(t2)
  sw t4, 0(t1)
  addi t1, t1, 4
  addi t2, t2, 4
  addi t3, t3, 1
  li t5, 32
  blt t3, t5, fs_write_inode_copy

  lw a0, 0(sp)
  call fs_write_block

  lw s0, 4(sp)
  lw ra, 8(sp)
  addi sp, sp, 12
  ret

# ─── fs_alloc_inode(a0=type) ──────────────────────────────────────────
# Finds a free inode, sets its type, writes it, returns inode_no in a0.
# Returns -1 if no free inode.
.global fs_alloc_inode
fs_alloc_inode:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)
  mv s1, a0           # s1 = type

  li s0, 0             # s0 = inode_no
fs_alloc_inode_loop:
  li t0, BRFS_MAX_INODES
  bge s0, t0, fs_alloc_inode_full

  mv a0, s0
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 0(t0)         # type
  bnez t1, fs_alloc_inode_next

  # Found free inode
  sw s1, 0(t0)         # type
  sw x0, 4(t0)         # size = 0
  li t1, 1
  sw t1, 8(t0)         # nlinks = 1
  # Clear direct block pointers
  li t1, 0
fs_alloc_inode_clear:
  sw x0, 12(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  li t2, 13
  blt t1, t2, fs_alloc_inode_clear

  mv a0, s0
  call fs_write_inode
  mv a0, s0
  j fs_alloc_inode_done

fs_alloc_inode_next:
  addi s0, s0, 1
  j fs_alloc_inode_loop

fs_alloc_inode_full:
  li a0, -1

fs_alloc_inode_done:
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# ─── fs_lookup(a0=parent_inode, a1=name_ptr) ──────────────────────────
# Searches directory inode (across all its blocks) for entry matching name.
# Returns a0 = inode_no, or -1 if not found.
fs_lookup:
  addi sp, sp, -24
  sw ra, 20(sp)
  sw s0, 16(sp)
  sw s1, 12(sp)
  sw s2, 8(sp)
  sw s3, 4(sp)
  mv s2, a1            # s2 = name to find
  mv s3, a0            # s3 = parent inode

  # Read parent inode
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 0(t0)
  li t2, BRFS_INODE_DIR
  bne t1, t2, fs_lookup_notfound

  lw s1, 4(t0)         # s1 = dir size
  li s0, 0             # s0 = block_idx

fs_lookup_blk:
  slli t0, s0, 12
  bge t0, s1, fs_lookup_notfound

  mv a0, s3
  mv a1, s0
  li a2, 0
  call fs_bmap
  beqz a0, fs_lookup_notfound
  bltz a0, fs_lookup_notfound
  call fs_read_block

  slli t0, s0, 12      # t0 = block_start (global offset)
  la t1, fs_block_buf
  li t2, 0             # t2 = entry index within block
fs_lookup_scan:
  slli t3, t2, 5       # entry offset within block
  add t4, t0, t3       # global entry offset
  li t5, 4096
  add t5, t5, t0    # block end
  bge t4, t5, fs_lookup_next_blk
  bge t4, s1, fs_lookup_next_blk
  add t5, t1, t3
  addi t5, t5, 4       # name start in entry
  mv t6, s2            # name to match
fs_lookup_cmp:
  lbu a0, 0(t5)
  lbu a1, 0(t6)
  bne a0, a1, fs_lookup_nomatch
  beqz a0, fs_lookup_matched  # both null → match
  addi t5, t5, 1
  addi t6, t6, 1
  j fs_lookup_cmp
fs_lookup_nomatch:
  addi t2, t2, 1
  j fs_lookup_scan
fs_lookup_matched:
  add t5, t1, t3
  lw a0, 0(t5)
  j fs_lookup_done

fs_lookup_next_blk:
  addi s0, s0, 1
  j fs_lookup_blk

fs_lookup_notfound:
  li a0, -1

fs_lookup_done:
  lw s3, 4(sp)
  lw s2, 8(sp)
  lw s1, 12(sp)
  lw s0, 16(sp)
  lw ra, 20(sp)
  addi sp, sp, 24
  ret

# ─── fs_dir_add(a0=parent_inode, a1=name_ptr, a2=child_inode) ─────────
# Adds a directory entry to parent, growing the directory across blocks
# (direct + indirect) as needed. Names longer than 27 chars are rejected.
# Returns a0 = 0 on success, -1 on error.
.global fs_dir_add
fs_dir_add:
  addi sp, sp, -28
  sw ra, 24(sp)
  sw s0, 20(sp)
  sw s1, 16(sp)
  sw s2, 12(sp)
  sw s3, 8(sp)
  sw s4, 4(sp)
  mv s0, a0            # s0 = parent inode
  mv s1, a1            # s1 = name
  mv s2, a2            # s2 = child inode

  # Name length must be <= 27 (BRFS_NAME_MAX - 1)
  mv t0, s1
  li t1, 0
fs_dir_add_len:
  li t2, 28
  bge t1, t2, fs_dir_add_err
  lbu t3, 0(t0)
  beqz t3, fs_dir_add_len_done
  addi t0, t0, 1
  addi t1, t1, 1
  j fs_dir_add_len
fs_dir_add_len_done:

  mv a0, s0
  call fs_read_inode
  la t0, fs_inode_buf
  lw s3, 4(t0)         # s3 = dir size

  # Locate the block with free space: if size is block-aligned, the next
  # entry goes at offset 0 of the next block; otherwise at (size % 4096).
  slli t0, s3, 20
  srli t0, t0, 20
  bnez t0, fs_dir_add_room_have
  srli a1, s3, 12
  li t0, 0             # entry_off = 0
  j fs_dir_add_do
fs_dir_add_room_have:
  srli a1, s3, 12
  slli t0, s3, 20
  srli t0, t0, 20

fs_dir_add_do:
  sw t0, 0(sp)         # save entry_off
  mv a0, s0
  li a2, 1
  call fs_bmap
  li t0, -1
  beq a0, t0, fs_dir_add_err
  beqz a0, fs_dir_add_err
  mv s4, a0            # s4 = dir block
  call fs_read_block
  lw t1, 0(sp)         # entry_off

  la t0, fs_block_buf
  add t0, t0, t1
  sw s2, 0(t0)         # inode_no
  addi t0, t0, 4
  # Copy name (up to 27 chars) and pad the field to 28 bytes
  mv t1, s1
  li t2, 0
fs_dir_add_name:
  li t3, 27
  bge t2, t3, fs_dir_add_name_end
  lbu t4, 0(t1)
  sb t4, 0(t0)
  beqz t4, fs_dir_add_name_pad
  addi t0, t0, 1
  addi t1, t1, 1
  addi t2, t2, 1
  j fs_dir_add_name
fs_dir_add_name_pad:
  addi t0, t0, 1
  addi t2, t2, 1
  li t3, 28
  bge t2, t3, fs_dir_add_name_end
  sb x0, 0(t0)
  j fs_dir_add_name_pad
fs_dir_add_name_end:

  mv a0, s4
  call fs_write_block

  # Update parent inode size (+32)
  la t0, fs_inode_buf
  lw t1, 4(t0)
  addi t1, t1, 32
  sw t1, 4(t0)
  mv a0, s0
  call fs_write_inode

  li a0, 0
  j fs_dir_add_done

fs_dir_add_err:
  li a0, -1

fs_dir_add_done:
  lw s4, 4(sp)
  lw s3, 8(sp)
  lw s2, 12(sp)
  lw s1, 16(sp)
  lw s0, 20(sp)
  lw ra, 24(sp)
  addi sp, sp, 28
  ret

# ─── fs_create(a0=parent_inode, a1=name_ptr, a2=type) ─────────────────
# Creates a new file or directory. Returns a0 = new inode_no, or -1.
fs_create:
  addi sp, sp, -20
  sw ra, 16(sp)
  sw s0, 12(sp)
  sw s1, 8(sp)
  sw s2, 4(sp)
  mv s0, a0            # parent inode
  mv s1, a1            # name
  mv s2, a2            # type

  # Allocate inode
  mv a0, s2
  call fs_alloc_inode
  li t0, -1
  beq a0, t0, fs_create_err
  mv s2, a0            # s2 = new inode

  # If it's a directory, allocate a data block and set up "." and ".."
  la t0, fs_inode_buf
  lw t1, 0(t0)
  li t2, BRFS_INODE_DIR
  bne t1, t2, fs_create_add_entry

  # Alloc data block for new dir
  sw s2, 0(sp)
  call fs_alloc_block
  lw s2, 0(sp)
  mv t3, a0            # t3 = dir data block
  sw t3, 0(sp)

  # Read new inode again
  mv a0, s2
  call fs_read_inode
  lw t3, 0(sp)

  la t0, fs_inode_buf
  sw t3, 12(t0)        # direct[0]
  li t1, 64
  sw t1, 4(t0)         # size = 64 (for "." and "..")
  li t1, 2
  sw t1, 8(t0)         # nlinks = 2
  mv a0, s2
  call fs_write_inode

  # Write "." and ".." entries
  la t0, fs_block_buf
  li t1, 0
  li t2, 1024
fs_create_clear_dir:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, fs_create_clear_dir

  la t0, fs_block_buf
  sw s2, 0(t0)         # "." -> self
  li t1, '.'
  sb t1, 4(t0)
  sb x0, 5(t0)
  sw s0, 32(t0)        # ".." -> parent
  li t1, '.'
  sb t1, 36(t0)
  sb t1, 37(t0)
  sb x0, 38(t0)

  lw t3, 0(sp)
  mv a0, t3
  call fs_write_block

fs_create_add_entry:
  mv a0, s0
  mv a1, s1
  mv a2, s2
  call fs_dir_add
  li t0, -1
  beq a0, t0, fs_create_rollback

  mv a0, s2
  j fs_create_done

fs_create_rollback:
  # Directory entry could not be added: free the inode and its blocks so
  # the failed create leaks nothing.
  mv a0, s2
  call fs_free_inode_blocks
  li a0, -1
  j fs_create_done

fs_create_err:
  li a0, -1

fs_create_done:
  lw s2, 4(sp)
  lw s1, 8(sp)
  lw s0, 12(sp)
  lw ra, 16(sp)
  addi sp, sp, 20
  ret

# ─── fs_mkdir(a0=parent_inode, a1=name_ptr) ───────────────────────────
# Convenience: creates a directory entry.
fs_mkdir:
  li a2, BRFS_INODE_DIR
  j fs_create

# ─── fs_read(a0=inode_no, a1=offset, a2=dst_ptr, a3=count) ──────────
# Reads up to count bytes from file at offset into dst_ptr, walking
# direct + indirect blocks via fs_bmap.
# Returns a0 = bytes read.
fs_read:
  addi sp, sp, -40
  sw ra, 36(sp)
  sw s0, 32(sp)
  sw s1, 28(sp)
  sw s2, 24(sp)
  sw s3, 20(sp)
  sw s4, 16(sp)
  sw s5, 12(sp)
  sw s6, 8(sp)
  mv s0, a0            # inode_no
  mv s1, a1            # offset
  mv s2, a2            # dst
  mv s3, a3            # count
  li s5, 0             # total bytes read

  # Read inode to get size
  mv a0, s0
  call fs_read_inode
  la t0, fs_inode_buf
  lw s4, 4(t0)         # file size

  # Clamp: if offset >= size, return 0
  bge s1, s4, fs_read_done
  # Clamp count to remaining file size
  sub t1, s4, s1
  blt s3, t1, fs_read_loop
  mv s3, t1

fs_read_loop:
  beqz s3, fs_read_done

  # block_idx = s1 / 4096
  mv a0, s0
  srli a1, s1, 12
  li a2, 0
  call fs_bmap
  beqz a0, fs_read_done
  bltz a0, fs_read_done
  mv s6, a0            # s6 = data block

  slli t1, s1, 20
  srli t1, t1, 20   # offset within block
  sw t1, 0(sp)         # save block_off
  mv a0, s6
  call fs_read_block
  lw t1, 0(sp)         # restore block_off

  # Calculate chunk size = min(s3, 4096 - block_off)
  li t5, 4096
  sub t5, t5, t1       # t5 = 4096 - block_off
  blt s3, t5, fs_read_use_s3
  mv t2, t5            # t2 = chunk bytes
  j fs_read_copy_start
fs_read_use_s3:
  mv t2, s3            # t2 = chunk bytes

fs_read_copy_start:
  # Copy t2 bytes from fs_block_buf + t1 to s2
  la t0, fs_block_buf
  add t0, t0, t1       # src = fs_block_buf + block_off
  li t3, 0             # loop index
fs_read_copy_loop:
  bge t3, t2, fs_read_copy_end
  lbu t4, 0(t0)
  sb t4, 0(s2)
  addi t0, t0, 1
  addi s2, s2, 1
  addi t3, t3, 1
  j fs_read_copy_loop

fs_read_copy_end:
  # Update offsets and counts
  add s1, s1, t2       # offset += chunk
  sub s3, s3, t2       # rem -= chunk
  add s5, s5, t2       # total_read += chunk
  j fs_read_loop

fs_read_done:
  mv a0, s5
  lw s6, 8(sp)
  lw s5, 12(sp)
  lw s4, 16(sp)
  lw s3, 20(sp)
  lw s2, 24(sp)
  lw s1, 28(sp)
  lw s0, 32(sp)
  lw ra, 36(sp)
  addi sp, sp, 40
  ret

# ─── fs_write(a0=inode_no, a1=offset, a2=src_ptr, a3=count) ─────────
# Writes count bytes from src_ptr to file at offset, allocating blocks as
# needed (direct + indirect via fs_bmap; new blocks are zero-filled).
# Returns a0 = bytes written.
fs_write:
  addi sp, sp, -40
  sw ra, 36(sp)
  sw s0, 32(sp)
  sw s1, 28(sp)
  sw s2, 24(sp)
  sw s3, 20(sp)
  sw s4, 16(sp)
  sw s5, 12(sp)
  sw s6, 8(sp)
  mv s0, a0            # inode_no
  mv s1, a1            # offset
  mv s2, a2            # src
  mv s3, a3            # count
  li s4, 0             # total bytes written
  beqz s3, fs_write_done

  mv a0, s0
  call fs_read_inode

fs_write_loop:
  beqz s3, fs_write_done

  # block_idx = s1 / 4096
  mv a0, s0
  srli a1, s1, 12
  li a2, 1
  call fs_bmap
  beqz a0, fs_write_done   # cannot allocate
  bltz a0, fs_write_done
  mv s5, a0                # s5 = data block

  slli t1, s1, 20
  srli t1, t1, 20       # offset within block
  sw t1, 0(sp)             # save block_off
  mv a0, s5
  call fs_read_block
  lw t1, 0(sp)             # restore block_off

  # chunk = min(s3, 4096 - block_off)
  li t0, 4096
  sub t0, t0, t1
  mv s6, s3
  blt s3, t0, fs_write_chunk_ok
  mv s6, t0

fs_write_chunk_ok:
  # Copy s6 bytes from s2 into fs_block_buf + t1
  la t0, fs_block_buf
  add t0, t0, t1
  li t2, 0
fs_write_copy:
  bge t2, s6, fs_write_copy_done
  lbu t3, 0(s2)
  sb t3, 0(t0)
  addi t0, t0, 1
  addi s2, s2, 1
  addi t2, t2, 1
  j fs_write_copy

fs_write_copy_done:
  mv a0, s5
  call fs_write_block

  add s1, s1, s6
  sub s3, s3, s6
  add s4, s4, s6
  j fs_write_loop

fs_write_done:
  # Update inode size if extended (s1 = final offset)
  la t0, fs_inode_buf
  lw t1, 4(t0)        # old size
  bge t1, s1, fs_write_size_ok
  sw s1, 4(t0)
fs_write_size_ok:
  mv a0, s0
  call fs_write_inode

  mv a0, s4
  j fs_write_ret

fs_write_ret:
  lw s6, 8(sp)
  lw s5, 12(sp)
  lw s4, 16(sp)
  lw s3, 20(sp)
  lw s2, 24(sp)
  lw s1, 28(sp)
  lw s0, 32(sp)
  lw ra, 36(sp)
  addi sp, sp, 40
  ret

# ─── fs_unlink(a0=parent_inode, a1=name_ptr) ─────────────────────────
# Removes a directory entry and frees the child inode + blocks.
# Guards: refuses to remove ".", "..", the root inode (0), and non-empty
# directories. Handles multi-block directories.
# Returns a0 = 0 on success, -1 on error.
fs_unlink:
  addi sp, sp, -36
  sw ra, 32(sp)
  sw s0, 28(sp)
  sw s1, 24(sp)
  sw s2, 20(sp)
  sw s3, 16(sp)
  sw s4, 12(sp)
  sw s5, 8(sp)
  mv s0, a0            # s0 = parent inode
  mv s1, a1            # s1 = name

  # Guards: empty name, ".", ".."
  lbu t0, 0(s1)
  beqz t0, fs_unlink_err
  li t1, '.'
  bne t0, t1, fs_unlink_find
  lbu t1, 1(s1)
  beqz t1, fs_unlink_err          # "."
  li t2, '.'
  bne t1, t2, fs_unlink_find
  lbu t2, 2(s1)
  beqz t2, fs_unlink_err          # ".."

fs_unlink_find:
  # Find child inode
  mv a0, s0
  mv a1, s1
  call fs_lookup
  li t0, -1
  beq a0, t0, fs_unlink_err
  mv s2, a0            # s2 = child inode
  beqz s2, fs_unlink_err          # refuse to unlink root

  # Directories may only be removed when empty
  mv a0, s2
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 0(t0)
  li t2, BRFS_INODE_DIR
  bne t1, t2, fs_unlink_free
  mv a0, s2
  call fs_dir_empty
  li t0, 1
  bne a0, t0, fs_unlink_err

fs_unlink_free:
  # Free child inode + blocks
  mv a0, s2
  call fs_free_inode_blocks

  # Remove the entry from the parent directory
  mv a0, s0
  call fs_read_inode
  la t0, fs_inode_buf
  lw s3, 4(t0)         # s3 = parent dir size

  li s4, 0             # s4 = block_idx
fs_unlink_blk:
  slli t0, s4, 12
  bge t0, s3, fs_unlink_err
  mv a0, s0
  mv a1, s4
  li a2, 0
  call fs_bmap
  beqz a0, fs_unlink_err
  bltz a0, fs_unlink_err
  mv s5, a0            # s5 = dir block
  call fs_read_block

  slli t0, s4, 12      # block_start
  la t1, fs_block_buf
  li t2, 0             # entry index within block
fs_unlink_scan:
  slli t3, t2, 5       # entry offset within block
  add t4, t0, t3       # global entry offset
  bge t4, s3, fs_unlink_next_blk
  add t5, t1, t3
  lw t6, 0(t5)         # entry inode
  bne t6, s2, fs_unlink_scan_next

  # Found the entry at global offset t4. The last entry lives at s3 - 32.
  addi t6, s3, -32
  beq t4, t6, fs_unlink_just_shrink

  # Copy the last entry over the removed entry (multi-block aware)
  sw t4, 0(sp)         # save found global offset
  mv a0, s0
  srli a1, t6, 12
  li a2, 0
  call fs_bmap
  beqz a0, fs_unlink_err
  bltz a0, fs_unlink_err
  call fs_read_block   # load block of the last entry
  slli t5, t6, 20
  srli t5, t5, 20   # last entry offset within its block
  la t0, fs_block_buf
  add t0, t0, t5
  # Save the last entry's 32 bytes to fs_entry_scratch
  la t1, fs_entry_scratch
  li t2, 0
fs_unlink_copy_last:
  li t3, 32
  bge t2, t3, fs_unlink_copy_last_done
  lbu t4, 0(t0)
  sb t4, 0(t1)
  addi t0, t0, 1
  addi t1, t1, 1
  addi t2, t2, 1
  j fs_unlink_copy_last
fs_unlink_copy_last_done:
  # Load the block of the removed entry
  mv a0, s0
  mv a1, s4
  li a2, 0
  call fs_bmap
  beqz a0, fs_unlink_err
  bltz a0, fs_unlink_err
  mv s5, a0
  call fs_read_block
  lw t4, 0(sp)         # found global offset
  slli t0, s4, 12
  sub t1, t4, t0       # offset within block
  la t0, fs_block_buf
  add t0, t0, t1
  la t1, fs_entry_scratch
  li t2, 0
fs_unlink_copy_found:
  li t3, 32
  bge t2, t3, fs_unlink_copy_found_done
  lbu t4, 0(t1)
  sb t4, 0(t0)
  addi t0, t0, 1
  addi t1, t1, 1
  addi t2, t2, 1
  j fs_unlink_copy_found
fs_unlink_copy_found_done:
  mv a0, s5
  call fs_write_block
  j fs_unlink_shrink

fs_unlink_just_shrink:
fs_unlink_shrink:
  # Shrink the directory size by one entry
  la t0, fs_inode_buf
  lw t1, 4(t0)
  addi t1, t1, -32
  sw t1, 4(t0)
  mv a0, s0
  call fs_write_inode
  li a0, 0
  j fs_unlink_done

fs_unlink_scan_next:
  addi t2, t2, 1
  li t5, 128
  blt t2, t5, fs_unlink_scan

fs_unlink_next_blk:
  addi s4, s4, 1
  j fs_unlink_blk

fs_unlink_err:
  li a0, -1

fs_unlink_done:
  lw s5, 8(sp)
  lw s4, 12(sp)
  lw s3, 16(sp)
  lw s2, 20(sp)
  lw s1, 24(sp)
  lw s0, 28(sp)
  lw ra, 32(sp)
  addi sp, sp, 36
  ret

# ─── fs_dir_empty(a0=inode_no) ────────────────────────────────────────
# Returns a0 = 1 if the directory contains only "." and "..", else 0.
fs_dir_empty:
  addi sp, sp, -24
  sw ra, 20(sp)
  sw s0, 16(sp)
  sw s1, 12(sp)
  sw s2, 8(sp)
  sw s3, 4(sp)
  mv s0, a0            # s0 = dir inode
  call fs_read_inode
  la t0, fs_inode_buf
  lw s1, 4(t0)         # s1 = size
  li t0, 64
  blt s1, t0, fs_de_empty     # less than "." + ".." → empty
  li s3, 0             # s3 = block_idx
fs_de_blk:
  slli t0, s3, 12
  bge t0, s1, fs_de_empty
  mv a0, s0
  mv a1, s3
  li a2, 0
  call fs_bmap
  beqz a0, fs_de_empty
  bltz a0, fs_de_empty
  call fs_read_block
  slli t0, s3, 12      # block_start
  la t1, fs_block_buf
  li t2, 0             # entry index within block
fs_de_scan:
  slli t3, t2, 5
  add t4, t0, t3       # global entry offset
  bge t4, s1, fs_de_next_blk
  li t5, 64
  blt t4, t5, fs_de_next_entry   # skip "." and ".."
  add t5, t1, t3
  lw t6, 0(t5)
  bnez t6, fs_de_not_empty
fs_de_next_entry:
  addi t2, t2, 1
  li t5, 128
  blt t2, t5, fs_de_scan
fs_de_next_blk:
  addi s3, s3, 1
  j fs_de_blk
fs_de_empty:
  li a0, 1
  j fs_dir_empty_done
fs_de_not_empty:
  li a0, 0
fs_dir_empty_done:
  lw s3, 4(sp)
  lw s2, 8(sp)
  lw s1, 12(sp)
  lw s0, 16(sp)
  lw ra, 20(sp)
  addi sp, sp, 24
  ret

# ─── fs_dir_name_of(a0=dir_inode, a1=target_inode, a2=out_buf) ────────
# Finds the name of target_inode within dir_inode and copies it (up to 27
# chars + NUL) to out_buf. Returns a0 = 0 on success, -1 if not found.
fs_dir_name_of:
  addi sp, sp, -28
  sw ra, 24(sp)
  sw s0, 20(sp)
  sw s1, 16(sp)
  sw s2, 12(sp)
  sw s3, 8(sp)
  sw s4, 4(sp)
  mv s0, a0            # s0 = dir inode
  mv s1, a1            # s1 = target inode
  mv s2, a2            # s2 = out_buf
  call fs_read_inode
  la t0, fs_inode_buf
  lw s3, 4(t0)         # s3 = size
  li s4, 0             # s4 = block_idx
fs_dno_blk:
  slli t0, s4, 12
  bge t0, s3, fs_dno_err
  mv a0, s0
  mv a1, s4
  li a2, 0
  call fs_bmap
  beqz a0, fs_dno_err
  bltz a0, fs_dno_err
  call fs_read_block
  slli t0, s4, 12      # block_start
  la t1, fs_block_buf
  li t2, 0             # entry index within block
fs_dno_scan:
  slli t3, t2, 5
  add t4, t0, t3
  bge t4, s3, fs_dno_next_blk
  add t5, t1, t3
  lw t6, 0(t5)         # entry inode
  bne t6, s1, fs_dno_next_entry
  # Found: copy the name
  addi t5, t5, 4
  mv t6, s2
  li t3, 0
fs_dno_copy:
  li t4, 28
  bge t3, t4, fs_dno_done
  lbu a0, 0(t5)
  sb a0, 0(t6)
  beqz a0, fs_dno_done
  addi t5, t5, 1
  addi t6, t6, 1
  addi t3, t3, 1
  j fs_dno_copy
fs_dno_done:
  li a0, 0
  j fs_dno_ret
fs_dno_next_entry:
  addi t2, t2, 1
  li t5, 128
  blt t2, t5, fs_dno_scan
fs_dno_next_blk:
  addi s4, s4, 1
  j fs_dno_blk
fs_dno_err:
  li a0, -1
fs_dno_ret:
  lw s4, 4(sp)
  lw s3, 8(sp)
  lw s2, 12(sp)
  lw s1, 16(sp)
  lw s0, 20(sp)
  lw ra, 24(sp)
  addi sp, sp, 28
  ret

# ─── fs_resolve(a0=start_inode, a1=path_ptr) ─────────────────────────
# Resolves a path relative to start_inode. Handles absolute paths ("/"),
# ".", "..", multiple components, and trailing slashes. Intermediate
# components must be directories. Leaf components may be any type.
# Returns a0 = inode_no, or -1 on error.
fs_resolve:
  addi sp, sp, -24
  sw ra, 20(sp)
  sw s0, 16(sp)
  sw s1, 12(sp)
  sw s2, 8(sp)
  sw s3, 4(sp)
  mv s0, a0            # s0 = current inode
  mv s1, a1            # s1 = path ptr
  lbu t0, 0(s1)
  beqz t0, fs_resolve_err
  li t1, '/'
  bne t0, t1, fs_resolve_skip
  li s0, 0             # absolute path → start at root

fs_resolve_skip:
  lbu t0, 0(s1)
  li t1, '/'
  bne t0, t1, fs_resolve_component
  addi s1, s1, 1
  j fs_resolve_skip

fs_resolve_component:
  lbu t0, 0(s1)
  beqz t0, fs_resolve_done
  # Copy the component into fs_path_scratch
  la s2, fs_path_scratch
  li s3, 0             # length
fs_resolve_copy:
  lbu t0, 0(s1)
  beqz t0, fs_resolve_copy_end
  li t1, '/'
  beq t0, t1, fs_resolve_copy_end
  li t1, 27
  bge s3, t1, fs_resolve_err    # name too long
  sb t0, 0(s2)
  addi s2, s2, 1
  addi s1, s1, 1
  addi s3, s3, 1
  j fs_resolve_copy
fs_resolve_copy_end:
  sb x0, 0(s2)

  # Component checks: "." skips, ".." walks to the parent
  la t0, fs_path_scratch
  lbu t1, 0(t0)
  li t2, '.'
  bne t1, t2, fs_resolve_do_lookup
  lbu t2, 1(t0)
  beqz t2, fs_resolve_skip              # "."
  li t3, '.'
  bne t2, t3, fs_resolve_do_lookup      # ".x"
  lbu t3, 2(t0)
  bnez t3, fs_resolve_do_lookup         # "..x"
  # ".." → parent of current (root stays root)
  beqz s0, fs_resolve_skip
  mv a0, s0
  la a1, fs_str_dotdot
  call fs_lookup
  li t0, -1
  beq a0, t0, fs_resolve_err
  mv s0, a0
  j fs_resolve_skip

fs_resolve_do_lookup:
  # Last component? (s1 is at '/' or NUL)
  lbu t0, 0(s1)
  li t1, '/'
  beq t0, t1, fs_resolve_not_last
  # Last component: any type allowed
  mv a0, s0
  la a1, fs_path_scratch
  call fs_lookup
  li t0, -1
  beq a0, t0, fs_resolve_err
  mv s0, a0
  j fs_resolve_done

fs_resolve_not_last:
  # Intermediate component must be a directory
  mv a0, s0
  la a1, fs_path_scratch
  call fs_lookup
  li t0, -1
  beq a0, t0, fs_resolve_err
  mv s0, a0
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 0(t0)
  li t2, BRFS_INODE_DIR
  bne t1, t2, fs_resolve_err
  j fs_resolve_skip

fs_resolve_done:
  mv a0, s0
  j fs_resolve_ret

fs_resolve_err:
  li a0, -1

fs_resolve_ret:
  lw s3, 4(sp)
  lw s2, 8(sp)
  lw s1, 12(sp)
  lw s0, 16(sp)
  lw ra, 20(sp)
  addi sp, sp, 24
  ret

# ─── fs_resolve_parent(a0=start_inode, a1=path_ptr) ───────────────────
# Resolves the parent directory of a path. The leaf component is copied
# to fs_path_scratch. Returns a0 = parent inode, or -1 on error.
# Errors: empty/all-slash path, leaf "." or "..", leaf too long, or the
# parent path does not resolve.
fs_resolve_parent:
  addi sp, sp, -28
  sw ra, 24(sp)
  sw s0, 20(sp)
  sw s1, 16(sp)
  sw s2, 12(sp)
  sw s3, 8(sp)
  sw s4, 4(sp)
  mv s0, a0            # s0 = start inode
  mv s1, a1            # s1 = path ptr
  lbu t0, 0(s1)
  beqz t0, fs_rp_err   # empty path

  # Trim trailing slashes (the path buffer has already been consumed by
  # the caller, so writing a NUL over the trailing '/' is safe)
  mv s3, s1
fs_rp_trim:
  lbu t0, 0(s3)
  beqz t0, fs_rp_trim_done
  addi s3, s3, 1
  j fs_rp_trim
fs_rp_trim_done:
  addi s3, s3, -1      # s3 = last char ptr
fs_rp_trim_loop:
  lbu t0, 0(s3)
  li t1, '/'
  bne t0, t1, fs_rp_scan
  beq s3, s1, fs_rp_err    # path is all slashes ("/")
  sb x0, 0(s3)
  addi s3, s3, -1
  j fs_rp_trim_loop

  # Find the last '/'
fs_rp_scan:
  li s2, 0             # s2 = last slash ptr (0 = none)
  mv s3, s1
fs_rp_scan_loop:
  lbu t0, 0(s3)
  beqz t0, fs_rp_scan_done
  li t1, '/'
  bne t0, t1, fs_rp_scan_next
  mv s2, s3
fs_rp_scan_next:
  addi s3, s3, 1
  j fs_rp_scan_loop
fs_rp_scan_done:

  beqz s2, fs_rp_no_slash
  # Leaf = s2 + 1; parent path = [s1, s2)
  addi s4, s2, 1
  lbu t0, 0(s2)
  sw t0, 0(sp)
  sb x0, 0(s2)         # temporarily terminate the parent path
  beq s2, s1, fs_rp_parent_root
  mv a0, s0
  mv a1, s1
  call fs_resolve
  j fs_rp_parent_done
fs_rp_parent_root:
  li a0, 0             # "/" alone → parent is root
fs_rp_parent_done:
  mv s0, a0
  lw t0, 0(sp)
  sb t0, 0(s2)         # restore
  li t0, -1
  beq s0, t0, fs_rp_err
  j fs_rp_leaf

fs_rp_no_slash:
  mv s4, s1            # whole path is the leaf; parent = start (s0)

fs_rp_leaf:
  # Leaf checks: non-empty, not "." or ".."
  lbu t0, 0(s4)
  beqz t0, fs_rp_err
  li t1, '.'
  bne t0, t1, fs_rp_copy_leaf
  lbu t1, 1(s4)
  beqz t1, fs_rp_err   # "."
  li t2, '.'
  bne t1, t2, fs_rp_copy_leaf
  lbu t2, 2(s4)
  beqz t2, fs_rp_err   # ".."

fs_rp_copy_leaf:
  # Copy leaf to fs_path_scratch (cap 27 chars)
  la s1, fs_path_scratch
  li s3, 0
fs_rp_copy:
  lbu t0, 0(s4)
  beqz t0, fs_rp_copy_done
  li t1, 27
  bge s3, t1, fs_rp_err
  sb t0, 0(s1)
  addi s1, s1, 1
  addi s4, s4, 1
  addi s3, s3, 1
  j fs_rp_copy
fs_rp_copy_done:
  sb x0, 0(s1)
  mv a0, s0
  j fs_rp_ret

fs_rp_err:
  li a0, -1

fs_rp_ret:
  lw s4, 4(sp)
  lw s3, 8(sp)
  lw s2, 12(sp)
  lw s1, 16(sp)
  lw s0, 20(sp)
  lw ra, 24(sp)
  addi sp, sp, 28
  ret

# ─── Data section ─────────────────────────────────────────────────────
.section .data
.global fs_total_blocks
.global fs_free_blocks
fs_total_blocks: .word 0
fs_free_blocks:  .word 0
fs_str_dotdot:   .asciz ".."

.section .bss
.align 4
.global fs_block_buf
fs_block_buf: .zero 4096
.global fs_inode_buf
fs_inode_buf: .zero 128
.global fs_path_scratch
fs_path_scratch: .zero 32
.global fs_entry_scratch
fs_entry_scratch: .zero 32
.global fs_getcwd_scratch
fs_getcwd_scratch: .zero 256

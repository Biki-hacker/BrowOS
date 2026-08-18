# fs.s - BrFS (BrowOS Filesystem) implementation.
#
# On-disk layout (4096-byte blocks):
#   Block 0: Superblock
#   Block 1: Free-block bitmap (1 bit per block, supports up to 32768 blocks)
#   Block 2..17: Inode table (128 inodes * 128 bytes = 16384 bytes = 4 blocks)
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
  li t1, 6             # first 6 blocks reserved (super + bitmap + 4 inode blocks)
  sub t2, s0, t1
  sw t2, 12(t0)        # free_blocks
  sw t1, 16(t0)        # first_data_block
  li t1, BRFS_BLOCK_SIZE
  sw t1, 20(t0)        # block_size

  # Store total and free blocks in kernel globals
  la t1, fs_total_blocks
  sw s0, 0(t1)
  la t1, fs_free_blocks
  sw t2, 0(t1)

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
  # Allocate a data block for root dir
  call fs_alloc_block
  mv s1, a0            # s1 = root dir data block

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
# Searches directory inode for entry matching name.
# Returns a0 = inode_no, or -1 if not found.
fs_lookup:
  addi sp, sp, -20
  sw ra, 16(sp)
  sw s0, 12(sp)
  sw s1, 8(sp)
  sw s2, 4(sp)
  sw s3, 0(sp)
  mv s2, a1            # s2 = name to find

  # Read parent inode
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 0(t0)
  li t2, BRFS_INODE_DIR
  bne t1, t2, fs_lookup_notfound

  lw s1, 4(t0)         # s1 = dir size
  lw s0, 12(t0)        # s0 = direct[0] block

  beqz s0, fs_lookup_notfound

  # Read dir data block
  mv a0, s0
  call fs_read_block

  la t0, fs_block_buf
  li s3, 0              # offset
fs_lookup_scan:
  bge s3, s1, fs_lookup_notfound
  # Entry at t0 + s3: 4 bytes inode_no, 28 bytes name
  add t1, t0, s3
  addi t2, t1, 4        # name start in entry
  mv t3, s2             # name to match
  li t4, 1              # match flag
fs_lookup_cmp:
  lbu t5, 0(t2)
  lbu t6, 0(t3)
  bne t5, t6, fs_lookup_nomatch
  beqz t5, fs_lookup_matched  # both null → match
  addi t2, t2, 1
  addi t3, t3, 1
  j fs_lookup_cmp
fs_lookup_nomatch:
  addi s3, s3, 32
  j fs_lookup_scan
fs_lookup_matched:
  add t1, t0, s3
  lw a0, 0(t1)
  j fs_lookup_done

fs_lookup_notfound:
  li a0, -1

fs_lookup_done:
  lw s3, 0(sp)
  lw s2, 4(sp)
  lw s1, 8(sp)
  lw s0, 12(sp)
  lw ra, 16(sp)
  addi sp, sp, 20
  ret

# ─── fs_dir_add(a0=parent_inode, a1=name_ptr, a2=child_inode) ─────────
# Adds a directory entry to parent.
.global fs_dir_add
fs_dir_add:
  addi sp, sp, -24
  sw ra, 20(sp)
  sw s0, 16(sp)
  sw s1, 12(sp)
  sw s2, 8(sp)
  sw s3, 4(sp)
  mv s1, a1            # name
  mv s2, a2            # child inode
  mv s3, a0            # parent inode

  call fs_read_inode
  la t0, fs_inode_buf
  lw s0, 12(t0)        # direct[0]

  beqz s0, fs_dir_add_alloc_block
  j fs_dir_add_have_block

fs_dir_add_alloc_block:
  call fs_alloc_block
  mv s0, a0
  la t0, fs_inode_buf
  sw s0, 12(t0)

fs_dir_add_have_block:
  # Read dir block
  mv a0, s0
  call fs_read_block

  # Find end of entries (at offset = inode.size, must be < 4096)
  la t0, fs_inode_buf
  lw t1, 4(t0)         # current size
  li t2, BRFS_BLOCK_SIZE
  addi t2, t2, -32
  blt t2, t1, fs_dir_add_err  # dir full

  la t0, fs_block_buf
  add t0, t0, t1       # pointer to new entry

  # Write entry: inode_no
  sw s2, 0(t0)
  # Copy name (up to 27 chars + null)
  addi t0, t0, 4
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

  # Write block back
  mv a0, s0
  call fs_write_block

  # Update parent inode size
  la t0, fs_inode_buf
  lw t1, 4(t0)
  addi t1, t1, 32
  sw t1, 4(t0)
  mv a0, s3
  call fs_write_inode

  li a0, 0
  j fs_dir_add_done

fs_dir_add_err:
  li a0, -1

fs_dir_add_done:
  lw s3, 4(sp)
  lw s2, 8(sp)
  lw s1, 12(sp)
  lw s0, 16(sp)
  lw ra, 20(sp)
  addi sp, sp, 24
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

  mv a0, s2
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
# Reads up to count bytes from file at offset into dst_ptr.
# Returns a0 = bytes read.
fs_read:
  addi sp, sp, -28
  sw ra, 24(sp)
  sw s0, 20(sp)
  sw s1, 16(sp)
  sw s2, 12(sp)
  sw s3, 8(sp)
  sw s4, 4(sp)
  mv s1, a1            # offset
  mv s2, a2            # dst
  mv s3, a3            # count

  call fs_read_inode
  la t0, fs_inode_buf
  lw s4, 4(t0)         # file size

  # Clamp: if offset >= size, read 0
  bge s1, s4, fs_read_zero
  # Clamp count to remaining bytes
  sub t1, s4, s1
  blt s3, t1, fs_read_count_ok
  mv s3, t1
fs_read_count_ok:
  beqz s3, fs_read_zero

  # block_idx = offset / 4096, block_off = offset % 4096
  srli t0, s1, 12      # block index
  slli s0, s1, 20
  srli s0, s0, 20      # offset within block (s1 & 0xFFF)

  # Get block number from direct[block_idx]
  la t1, fs_inode_buf
  slli t2, t0, 2
  addi t2, t2, 12      # offset of direct[block_idx]
  add t1, t1, t2
  lw t3, 0(t1)         # block_no
  beqz t3, fs_read_zero

  # Read the data block
  sw s3, 0(sp)
  mv a0, t3
  call fs_read_block
  lw s3, 0(sp)

  # Copy from fs_block_buf + s0 to s2, s3 bytes
  la t0, fs_block_buf
  add t0, t0, s0
  li t1, 0
fs_read_copy:
  bge t1, s3, fs_read_done_copy
  lbu t2, 0(t0)
  sb t2, 0(s2)
  addi t0, t0, 1
  addi s2, s2, 1
  addi t1, t1, 1
  j fs_read_copy

fs_read_done_copy:
  mv a0, s3
  j fs_read_ret

fs_read_zero:
  li a0, 0

fs_read_ret:
  lw s4, 4(sp)
  lw s3, 8(sp)
  lw s2, 12(sp)
  lw s1, 16(sp)
  lw s0, 20(sp)
  lw ra, 24(sp)
  addi sp, sp, 28
  ret

# ─── fs_write(a0=inode_no, a1=offset, a2=src_ptr, a3=count) ─────────
# Writes count bytes from src_ptr to file at offset.
# Allocates data blocks as needed.
# Returns a0 = bytes written.
fs_write:
  addi sp, sp, -32
  sw ra, 28(sp)
  sw s0, 24(sp)
  sw s1, 20(sp)
  sw s2, 16(sp)
  sw s3, 12(sp)
  sw s4, 8(sp)
  sw s5, 4(sp)
  mv s0, a0            # inode_no
  mv s1, a1            # offset
  mv s2, a2            # src
  mv s3, a3            # count
  beqz s3, fs_write_zero

  call fs_read_inode

  # block_idx = offset / 4096
  srli s4, s1, 12
  slli s5, s1, 20
  srli s5, s5, 20      # offset within block (s1 & 0xFFF)

  # Get or allocate block pointer
  la t0, fs_inode_buf
  slli t1, s4, 2
  addi t1, t1, 12
  add t2, t0, t1
  lw t3, 0(t2)
  bnez t3, fs_write_have_block

  # Allocate block
  sw t2, 0(sp)
  call fs_alloc_block
  lw t2, 0(sp)
  sw a0, 0(t2)         # store in inode direct
  mv t3, a0

fs_write_have_block:
  # Read block
  sw t3, 0(sp)
  mv a0, t3
  call fs_read_block
  lw t3, 0(sp)

  # Copy src -> block_buf + offset_in_block
  la t0, fs_block_buf
  add t0, t0, s5
  li t1, 0
fs_write_copy:
  bge t1, s3, fs_write_done_copy
  lbu t2, 0(s2)
  sb t2, 0(t0)
  addi t0, t0, 1
  addi s2, s2, 1
  addi t1, t1, 1
  j fs_write_copy

fs_write_done_copy:
  # Write block back
  mv a0, t3
  call fs_write_block

  # Update inode size if extended
  la t0, fs_inode_buf
  lw t1, 4(t0)        # old size
  add t2, s1, s3       # new end
  bge t1, t2, fs_write_size_ok
  sw t2, 4(t0)
fs_write_size_ok:
  mv a0, s0
  call fs_write_inode

  mv a0, s3
  j fs_write_ret

fs_write_zero:
  li a0, 0

fs_write_ret:
  lw s5, 4(sp)
  lw s4, 8(sp)
  lw s3, 12(sp)
  lw s2, 16(sp)
  lw s1, 20(sp)
  lw s0, 24(sp)
  lw ra, 28(sp)
  addi sp, sp, 32
  ret

# ─── fs_unlink(a0=parent_inode, a1=name_ptr) ─────────────────────────
# Removes a directory entry and frees the child inode + blocks.
# Returns a0 = 0 on success, -1 on not found.
fs_unlink:
  addi sp, sp, -20
  sw ra, 16(sp)
  sw s0, 12(sp)
  sw s1, 8(sp)
  sw s2, 4(sp)
  mv s0, a0            # parent
  mv s1, a1            # name

  # Find child inode
  call fs_lookup
  li t0, -1
  beq a0, t0, fs_unlink_notfound
  mv s2, a0            # child inode_no

  # Read child inode to free its blocks
  call fs_read_inode
  la t0, fs_inode_buf
  li t1, 0
fs_unlink_free_blocks:
  li t2, BRFS_MAX_DIRECT
  bge t1, t2, fs_unlink_clear_inode
  slli t3, t1, 2
  addi t3, t3, 12
  add t4, t0, t3
  lw t5, 0(t4)
  beqz t5, fs_unlink_next_block
  sw t1, 0(sp)
  mv a0, t5
  call fs_free_block
  lw t1, 0(sp)
  la t0, fs_inode_buf
fs_unlink_next_block:
  addi t1, t1, 1
  j fs_unlink_free_blocks

fs_unlink_clear_inode:
  # Clear inode
  la t0, fs_inode_buf
  li t1, 0
  li t2, 32
fs_unlink_zero_inode:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, fs_unlink_zero_inode
  mv a0, s2
  call fs_write_inode

  # Remove dir entry from parent: read parent inode, read its dir block,
  # shift entries down.
  mv a0, s0
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 12(t0)       # direct[0]
  sw t1, 0(sp)
  mv a0, t1
  call fs_read_block

  la t0, fs_inode_buf
  lw t5, 4(t0)         # parent dir size

  la t0, fs_block_buf
  li t1, 0
fs_unlink_scan_entry:
  bge t1, t5, fs_unlink_notfound_late
  add t2, t0, t1
  lw t3, 0(t2)
  bne t3, s2, fs_unlink_next_entry

  # Found entry; overwrite with last entry, shrink size by 32
  addi t5, t5, -32
  beq t1, t5, fs_unlink_just_shrink
  # Copy last entry over this entry
  add t3, t0, t5
  li t4, 0
fs_unlink_copy_entry:
  li t6, 32
  bge t4, t6, fs_unlink_just_shrink
  lbu t6, 0(t3)
  sb t6, 0(t2)
  addi t2, t2, 1
  addi t3, t3, 1
  addi t4, t4, 1
  j fs_unlink_copy_entry

fs_unlink_just_shrink:
  # Write dir block back
  lw a0, 0(sp)
  call fs_write_block

  # Update parent inode size
  la t0, fs_inode_buf
  addi t5, t5, 0       # t5 already updated
  sw t5, 4(t0)
  mv a0, s0
  call fs_write_inode

  li a0, 0
  j fs_unlink_done

fs_unlink_next_entry:
  addi t1, t1, 32
  j fs_unlink_scan_entry

fs_unlink_notfound_late:
fs_unlink_notfound:
  li a0, -1

fs_unlink_done:
  lw s2, 4(sp)
  lw s1, 8(sp)
  lw s0, 12(sp)
  lw ra, 16(sp)
  addi sp, sp, 20
  ret

# ─── Data section ─────────────────────────────────────────────────────
.section .data
.global fs_total_blocks
.global fs_free_blocks
fs_total_blocks: .word 0
fs_free_blocks:  .word 0

.section .bss
.align 4
.global fs_block_buf
fs_block_buf: .zero 4096
.global fs_inode_buf
fs_inode_buf: .zero 128

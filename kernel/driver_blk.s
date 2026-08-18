# driver_blk.s - Block device driver for BrowOS kernel.
# Block device is at BLOCK_BASE (0x10003000).
# Provides sector-level read/write using DMA (the block device
# copies data between its internal storage and guest physical RAM).

.section .text
.align 2
.global blk_init
.global blk_read_sector
.global blk_write_sector
.global blk_capacity

# blk_init(): Probes block device, stores capacity.
# Returns a0 = number of sectors (0 if no device).
blk_init:
  li t0, BLOCK_BASE
  lw a0, BLK_CAPACITY(t0)
  la t1, blk_num_sectors
  sw a0, 0(t1)
  ret

# blk_read_sector(a0=sector, a1=dst_pa): Reads 512 bytes from sector to physical RAM.
# Returns a0 = 0 on success, -1 on error.
blk_read_sector:
  li t0, BLOCK_BASE
  sw a0, BLK_SECTOR(t0)
  sw a1, BLK_DMA_ADDR(t0)
  li t1, BLK_CMD_READ
  sw t1, BLK_COMMAND(t0)

  # Check status (synchronous: device completes instantly in emulator)
  lw t1, BLK_STATUS(t0)
  li t2, 2  # done-ok
  beq t1, t2, blk_read_ok
  li a0, -1
  ret
blk_read_ok:
  li a0, 0
  ret

# blk_write_sector(a0=sector, a1=src_pa): Writes 512 bytes from physical RAM to sector.
# Returns a0 = 0 on success, -1 on error.
blk_write_sector:
  li t0, BLOCK_BASE
  sw a0, BLK_SECTOR(t0)
  sw a1, BLK_DMA_ADDR(t0)
  li t1, BLK_CMD_WRITE
  sw t1, BLK_COMMAND(t0)

  # Check status
  lw t1, BLK_STATUS(t0)
  li t2, 2  # done-ok
  beq t1, t2, blk_write_ok
  li a0, -1
  ret
blk_write_ok:
  li a0, 0
  ret

# blk_capacity(): Returns a0 = number of 512-byte sectors.
blk_capacity:
  la t0, blk_num_sectors
  lw a0, 0(t0)
  ret

.section .data
.global blk_num_sectors
blk_num_sectors: .word 0

'use strict';

/**
 * mkfs.js — BrFS (BrowOS Filesystem) disk image generator.
 * Formats a disk buffer with BrFS superblock, bitmap, inode table, and initial files.
 */

const BRFS_MAGIC = 0x42524653; // "BRFS"
const BLOCK_SIZE = 4096;
const SECTOR_SIZE = 512;
const SECTS_PER_BLK = 8;
const MAX_INODES = 128;
const INODE_SIZE = 128;
const FIRST_DATA_BLOCK = 6;
const INODE_FILE = 1;
const INODE_DIR = 2;

class BrfsBuilder {
  /**
   * @param {number} totalSectors Total disk size in 512-byte sectors (e.g. 2048 = 1 MiB).
   */
  constructor(totalSectors = 2048) {
    this.totalSectors = totalSectors;
    this.totalBlocks = Math.floor(totalSectors / SECTS_PER_BLK);
    this.disk = new Uint8Array(totalSectors * SECTOR_SIZE);
    this.nextFreeBlock = FIRST_DATA_BLOCK;
    this.nextInode = 0;
    this.inodes = [];
    this.bitmap = new Uint8Array(BLOCK_SIZE);

    // Mark blocks 0..5 as used in bitmap
    this.bitmap[0] = 0x3F; // bits 0..5
  }

  allocBlock() {
    const b = this.nextFreeBlock++;
    if (b >= this.totalBlocks) throw new Error('BrFS disk image full');
    const byteIdx = Math.floor(b / 8);
    const bitIdx = b % 8;
    this.bitmap[byteIdx] |= (1 << bitIdx);
    return b;
  }

  allocInode(type, size = 0) {
    const ino = this.nextInode++;
    if (ino >= MAX_INODES) throw new Error('BrFS max inodes exceeded');
    const inode = {
      ino,
      type,
      size,
      nlinks: 1,
      direct: new Uint32Array(12),
      indirect: 0,
    };
    this.inodes.push(inode);
    return inode;
  }

  writeBlock(blockNo, data) {
    const off = blockNo * BLOCK_SIZE;
    this.disk.set(data.subarray(0, BLOCK_SIZE), off);
  }

  /**
   * Formats the filesystem with root directory and optional initial files.
   * @param {Array<{path: string, content: string|Uint8Array, type?: string}>} initialFiles
   * @returns {Uint8Array} Formatted disk image bytes.
   */
  build(initialFiles = []) {
    // 1. Create root directory (Inode 0)
    const rootInode = this.allocInode(INODE_DIR, 64);
    rootInode.nlinks = 2;
    const rootBlockNo = this.allocBlock();
    rootInode.direct[0] = rootBlockNo;

    const rootDirBlock = new Uint8Array(BLOCK_SIZE);
    const view = new DataView(rootDirBlock.buffer);

    // Entry 0: "." -> 0
    view.setUint32(0, 0, true);
    rootDirBlock[4] = 0x2E; // '.'

    // Entry 1: ".." -> 0
    view.setUint32(32, 0, true);
    rootDirBlock[36] = 0x2E; // '.'
    rootDirBlock[37] = 0x2E; // '.'

    let rootDirEntries = 2;

    // 2. Add initial files
    for (const f of initialFiles) {
      const isDir = f.type === 'dir' || f.isDir;
      const contentBytes = typeof f.content === 'string'
        ? new TextEncoder().encode(f.content)
        : (f.content || new Uint8Array(0));

      const inode = this.allocInode(isDir ? INODE_DIR : INODE_FILE, contentBytes.length);

      if (isDir) {
        inode.nlinks = 2;
        const dirBlockNo = this.allocBlock();
        inode.direct[0] = dirBlockNo;
        inode.size = 64;

        const dirBlock = new Uint8Array(BLOCK_SIZE);
        const dv = new DataView(dirBlock.buffer);
        dv.setUint32(0, inode.ino, true); // "." -> self
        dirBlock[4] = 0x2E;
        dv.setUint32(32, 0, true);         // ".." -> root
        dirBlock[36] = 0x2E;
        dirBlock[37] = 0x2E;
        this.writeBlock(dirBlockNo, dirBlock);
      } else if (contentBytes.length > 0) {
        // Write file data into blocks
        let written = 0;
        let blkIdx = 0;
        while (written < contentBytes.length && blkIdx < 12) {
          const chunk = contentBytes.subarray(written, written + BLOCK_SIZE);
          const dataBlkNo = this.allocBlock();
          inode.direct[blkIdx++] = dataBlkNo;
          const blkData = new Uint8Array(BLOCK_SIZE);
          blkData.set(chunk, 0);
          this.writeBlock(dataBlkNo, blkData);
          written += chunk.length;
        }
      }

      // Add entry to root directory
      const cleanName = f.path.replace(/^\//, '');
      const entryOff = rootDirEntries * 32;
      view.setUint32(entryOff, inode.ino, true);
      const nameBytes = new TextEncoder().encode(cleanName);
      rootDirBlock.set(nameBytes.subarray(0, 27), entryOff + 4);
      rootDirEntries++;
      rootInode.size = rootDirEntries * 32;
    }

    this.writeBlock(rootBlockNo, rootDirBlock);

    // 3. Write Superblock (Block 0)
    const sb = new Uint8Array(BLOCK_SIZE);
    const sbView = new DataView(sb.buffer);
    sbView.setUint32(0, BRFS_MAGIC, true);
    sbView.setUint32(4, this.totalBlocks, true);
    sbView.setUint32(8, MAX_INODES, true);
    sbView.setUint32(12, this.totalBlocks - this.nextFreeBlock, true);
    sbView.setUint32(16, FIRST_DATA_BLOCK, true);
    sbView.setUint32(20, BLOCK_SIZE, true);
    this.writeBlock(0, sb);

    // 4. Write Bitmap (Block 1)
    this.writeBlock(1, this.bitmap);

    // 5. Write Inode Table (Blocks 2..5)
    for (let i = 0; i < 4; i++) {
      const inodeBlk = new Uint8Array(BLOCK_SIZE);
      const iv = new DataView(inodeBlk.buffer);
      for (let j = 0; j < 32; j++) {
        const inoIdx = i * 32 + j;
        if (inoIdx < this.inodes.length) {
          const in_ = this.inodes[inoIdx];
          const off = j * INODE_SIZE;
          iv.setUint32(off + 0, in_.type, true);
          iv.setUint32(off + 4, in_.size, true);
          iv.setUint32(off + 8, in_.nlinks, true);
          for (let k = 0; k < 12; k++) {
            iv.setUint32(off + 12 + k * 4, in_.direct[k], true);
          }
          iv.setUint32(off + 60, in_.indirect, true);
        }
      }
      this.writeBlock(2 + i, inodeBlk);
    }

    return this.disk;
  }
}

function formatDisk(totalSectors = 2048, files = []) {
  const b = new BrfsBuilder(totalSectors);
  return b.build(files);
}

module.exports = { BrfsBuilder, formatDisk, BRFS_MAGIC, BLOCK_SIZE, SECTOR_SIZE };

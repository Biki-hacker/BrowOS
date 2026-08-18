# driver_gpu.s - BrowGPU Virtual Accelerator Driver for BrowOS.
# Controls the GPU via MMIO registers at GPU_CTRL_BASE (0x10004000).

.section .text
.align 2
.global gpu_init
.global gpu_submit_cmd
.global gpu_present
.global sys_gpu_dispatch

# gpu_init(): Initializes the BrowGPU device.
# Returns a0 = 0 on success, -1 if no GPU present.
gpu_init:
  li t0, GPU_CTRL_BASE

  # Verify Magic Number 'BGPU' (0x42475055)
  lw t1, GPU_REG_MAGIC(t0)
  li t2, GPU_MAGIC
  bne t1, t2, gpu_init_fail

  # Set default resolution: 320x240
  li t1, 320
  sw t1, GPU_REG_FB_WIDTH(t0)
  li t1, 240
  sw t1, GPU_REG_FB_HEIGHT(t0)

  # Set default command buffer address in kernel memory
  la t1, gpu_cmd_buf
  sw t1, GPU_REG_CMD_ADDR(t0)

  li a0, 0
  ret

gpu_init_fail:
  li a0, -1
  ret

# gpu_submit_cmd(a0=cmd_pa, a1=cmd_len): Submits a command buffer to the GPU.
gpu_submit_cmd:
  li t0, GPU_CTRL_BASE
  sw a0, GPU_REG_CMD_ADDR(t0)
  sw a1, GPU_REG_CMD_LEN(t0)
  li t1, 1
  sw t1, GPU_REG_SUBMIT(t0)
  li a0, 0
  ret

# gpu_present(): Swaps and presents the current framebuffer to the host.
gpu_present:
  li t0, GPU_CTRL_BASE
  li t1, 1
  sw t1, GPU_REG_PRESENT(t0)
  li a0, 0
  ret

# sys_gpu_dispatch(a0=op, a1=arg1, a2=arg2, a3=arg3): System call 19.
# op 1: clear (arg1=color)
# op 2: draw_rect (arg1=rect_ptr [x,y,w,h,color])
# op 3: dispatch_compute (arg1=kernel_id, arg2=param1, arg3=param2)
# op 4: present
# op 5: get_info (arg1=info_ptr [width, height, status, backend])
sys_gpu_dispatch:
  li t0, GPU_CTRL_BASE
  lw t1, GPU_REG_MAGIC(t0)
  li t2, GPU_MAGIC
  bne t1, t2, sys_gpu_err

  li t0, 1
  beq a0, t0, sys_gpu_clear
  li t0, 2
  beq a0, t0, sys_gpu_draw_rect
  li t0, 3
  beq a0, t0, sys_gpu_compute
  li t0, 4
  beq a0, t0, sys_gpu_do_present
  li t0, 5
  beq a0, t0, sys_gpu_get_info

sys_gpu_err:
  li a0, -1
  ret

sys_gpu_clear:
  # CMD_CLEAR (1), color (arg1)
  la t0, gpu_cmd_buf
  li t1, CMD_CLEAR
  sw t1, 0(t0)
  sw a1, 4(t0)
  mv a0, t0
  li a1, 8
  j gpu_submit_cmd

sys_gpu_draw_rect:
  # arg1 is user pointer to [x, y, w, h, color]
  la t0, gpu_cmd_buf
  li t1, CMD_DRAW_RECT
  sw t1, 0(t0)
  lw t2, 0(a1)       # x
  sw t2, 4(t0)
  lw t2, 4(a1)       # y
  sw t2, 8(t0)
  lw t2, 8(a1)       # w
  sw t2, 12(t0)
  lw t2, 12(a1)      # h
  sw t2, 16(t0)
  lw t2, 16(a1)      # color
  sw t2, 20(t0)
  mv a0, t0
  li a1, 24
  j gpu_submit_cmd

sys_gpu_compute:
  # arg1=kernel_id, arg2=param1, arg3=param2
  la t0, gpu_cmd_buf
  li t1, CMD_DISPATCH_COMPUTE
  sw t1, 0(t0)
  sw a1, 4(t0)       # kernel_id
  sw a2, 8(t0)       # param1 (e.g. time)
  sw a3, 12(t0)      # param2
  sw x0, 16(t0)      # param3
  mv a0, t0
  li a1, 20
  j gpu_submit_cmd

sys_gpu_do_present:
  j gpu_present

sys_gpu_get_info:
  # arg1=info_ptr [width, height, status, backend]
  li t0, GPU_CTRL_BASE
  lw t1, GPU_REG_FB_WIDTH(t0)
  sw t1, 0(a1)
  lw t1, GPU_REG_FB_HEIGHT(t0)
  sw t1, 4(a1)
  lw t1, GPU_REG_STATUS(t0)
  sw t1, 8(a1)
  lw t1, GPU_REG_BACKEND(t0)
  sw t1, 12(a1)
  li a0, 0
  ret

.section .bss
.align 4
gpu_cmd_buf: .zero 256

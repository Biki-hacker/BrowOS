# globe.s - 3D Compute Raytracing Globe Showcase Application.
# Dispatches real-time spherical raytracing shaders on BrowGPU and presents frames.

.section .text
.align 2
.global _start
.global globe_main

_start:
globe_main:
  # Print starting message
  la a0, str_start
  call puts

  # Dispatch raytraced 3D globe compute kernel (kernel_id=1, time=10)
  li a0, 3           # op = GPU_OP_DISPATCH_COMPUTE
  li a1, 1           # kernel_id = 1 (raytrace_globe)
  li a2, 10          # time parameter = 10
  li a3, 0
  call gpu_dispatch
  bnez a0, globe_err

  # Present the rendered framebuffer to the host canvas
  li a0, 4           # op = GPU_OP_PRESENT
  call gpu_dispatch
  bnez a0, globe_err

  # Print completion message
  la a0, str_done
  call puts

  # Exit 0
  li a0, 0
  call exit

globe_err:
  la a0, str_err
  call puts
  li a0, 1
  call exit

.section .data
str_start: .asciz "BrowGPU: Computing 3D Raytraced Earth Globe..."
str_done:  .asciz "BrowGPU: Raytracing complete. Frame presented."
str_err:   .asciz "BrowGPU: Hardware accelerator error."

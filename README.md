# Hot Air Balloons Simulator

An interactive, browser-based balloon swarm built with **Three.js instancing** and optional **camera + MediaPipe tracking**. Hover (or wave) to “ignite” balloons: interaction boosts buoyancy, and the swarm floats, wobbles, and respawns to keep the scene alive.

**Live demo:** https://gustavochanchien.github.io/balloon-simulator/

![Screenshot](screenshot.png)

## Features
- **Instanced rendering** (hundreds of balloons efficiently, no per-balloon meshes)
- **Camera background** with a simple CSS “grade” overlay (gradient/image blend)
- **Interaction modes (edit in CONFIG)**
  - Mouse raycast hover
  - Pose wrists (MediaPipe Pose)
  - Fingertips (MediaPipe Hands)
  - Full-body zones (pose bounding boxes)
- “Gamey” physics: buoyancy-driven lift + wind wobble + drag + respawn bounds
- Runtime tuning hooks via `window.SIM`
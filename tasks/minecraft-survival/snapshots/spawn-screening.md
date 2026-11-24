# Spawn screening: seeds 100–109

Seeds 104–109 were generated with `tools/freeze-snapshot.mjs`; 100–103 already existed. Every Snapshot was reloaded in a separate no-model NeoForge server using `tools/check-snapshot-spawn.mjs`. The reload receipt in each Snapshot's `provenance/reload-check.json` confirms the configured Bot position, biome, solid non-leaf ground, passable feet, clear headroom, full health and food, and empty inventory. Frozen world hashes match their manifests. No evaluation Attempt or model call was made.

The land screen reads the frozen Overworld region data. It counts water surface columns on an 8-block grid in a 32-block square around the configured spawn (81 samples), and on the same grid in a 64-block square (289 samples). A 16-block grid out to 128 blocks checks whether the spawn's sampled dry-land component reaches the inspected boundary. All ten do; none appears to be an isolated small island in the sampled area. This bounded check cannot certify the topology of land beyond 128 blocks.

The wood screen reads actual naturally generated log blocks near the terrain surface, rather than inferring wood from leaves or biome names. Distances below are horizontal straight-line distances from the configured spawn to the nearest log; every world has logs within 64 blocks. The checks do not prove an Agent can navigate to or harvest a given tree.

| Seed | Spawn biome | Configured spawn (x, y, z) | Ground | Nearest log | Water within 32 | Water within 64 | Spawn adjustment |
|---|---|---|---|---|---:|---:|---|
| 100 | savanna | (0.5, 95, 0.5) | grass block | oak, 11.4 blocks | 0/81 | 4/289 | none |
| 101 | plains | (-271.5, 71, -111.5) | grass block | oak, 35.4 blocks | 22/81 | 122/289 | none; coastal land |
| 102 | forest | (0.5, 71, -63.5) | grass block | oak, 3.2 blocks | 2/81 | 67/289 | none |
| 103 | forest | (0.5, 66, 0.5) | grass block | birch, 2.2 blocks | 2/81 | 65/289 | existing ground-level adjustment |
| 104 | forest | (-343.5, 64, -119.5) | grass block | oak, 5.0 blocks | 8/81 | 133/289 | moved inland from narrow coast |
| 105 | forest | (-63.5, 75, 48.5) | grass block | oak, 2.2 blocks | 8/81 | 99/289 | lowered from oak canopy |
| 106 | forest | (0.5, 63, 0.5) | grass block | oak, 3.2 blocks | 0/81 | 0/289 | none |
| 107 | birch forest | (-107.5, 70, 376.5) | grass block | birch, 2.2 blocks | 8/81 | 88/289 | moved inland from jungle shore |
| 108 | taiga | (-132.5, 70, -63.5) | grass block | spruce, 3.2 blocks | 8/81 | 106/289 | moved from spruce canopy and shore |
| 109 | windswept hills | (0.5, 82, 0.5) | stone | oak, 46.2 blocks | 0/81 | 13/289 | none |

All configured spawns pass the requested ground, water and small-island screen within the inspected area. Coastal terrain remains in some worlds. These checks do not establish landmass topology beyond 128 blocks, resource balance, or a natural Nether/End route; `feasibility.status: pending` in each manifest records that no such check was made. These ten worlds, seeds 100–109, are the ones used for the paper's Survival and Item Discovery results.

/**
 * WORLD GENERATION MODULE
 * Handles procedural terrain generation using Simplex Noise,
 * biome determination, and chunk-based loading/unloading.
 */

class World {
    /**
     * @param {{ simplexSeed: number }} config - Seed for noise generation
     */
    constructor(config = {}) {
        this.simplexNoise = new SimplexNoise();
        // Use a seed if provided, otherwise use timestamp-based seed
        this.seed = config.simplexSeed || (Date.now() % 1000000);
        
        // Terrain configuration
        this.chunkSize = 16;
        this.minHeight = -32;
        this.maxHeight = 64;
        
        // Biome configuration
        this.biomes = {
            'plains': { minHeight: -2, maxHeight: 25, color: '#4a8f4a', 
                          grassColor: '#4a8f4a', dirtColor: '#3d6b3d' },
            'forest':  { minHeight: -5,  maxHeight: 30, color: '#2d5a2d',
                          grassColor: '#2d5a2d', dirtColor: '#1e3d1e' },
            'mountain':{ minHeight: -8,   maxHeight: 64, color: '#5a7a9f',
                          grassColor: '#4a8f4a', dirtColor: '#2a4a5a' },
            'desert':  { minHeight: 0,    maxHeight: 35, color: '#c4a574',
                          grassColor: '#e6d1b3', dirtColor: '#c4a574' },
            'snow':   { minHeight: -12,   maxHeight: 60, color: '#ecf0f1',
                          grassColor: '#ecf0f1', dirtColor: '#95a5a6' },
            'swamp':  { minHeight: -3,    maxHeight: 18, color: '#27ae60',
                          grassColor: '#2ecc71', dirtColor: '#2c5e46' },
        };

        // Generate noise seeds for each biome (deterministic based on base seed)
        this.noiseSeeds = {
            'plains': Math.abs(this.seed * 3.14159 + 1),
            'forest': Math.abs(this.seed * 2.71828 + 2),
            'mountain': Math.abs(this.seed * 1.61803 + 3),
            'desert':  Math.abs(this.seed * 1.41421 + 4),
            'snow':   Math.abs(this.seed * 1.73205 + 5),
            'swamp':  Math.abs(this.seed * 2.23607 + 6),
        };

        // Terrain modifiers
        this.noiseScale = 0.015;
        this.octaves = 4;
        this.persistence = 0.5;
        this.lacunarity = 2.0;

        // Diamond/cave noise (separate octaves for caves)
        this.caveNoiseSeed = Math.abs(this.seed * 3.7);
        this.diamondOctaves = 6;
        this.diamondScale = 0.018;
        this.diamondPersistence = 0.7;

        // Chunk data storage - uses Map for efficient sparse storage
        this.chunks = new Map();
        
        // World dimensions
        this.width = 256;
        this.height = 256;
        this.depth = 128;

        // Current chunk cache (for rendering)
        this.currentChunks = [];

        // Register biome listener
        this.biomeListener = null;
        
        // Debug mode - show coordinates in debug console
        this.debugMode = false;
    }

    /**
     * Generate terrain height at a specific position using Multi-Octave Perlin Noise
     * @param {number} x - X coordinate
     * @param {number} z - Z coordinate
     * @returns {{ height: number, biome: string }} Terrain data
     */
    getTerrainHeight(x, z) {
        // Determine which biome applies at this location based on world center
        const centerX = this.width / 2;
        const centerZ = this.height / 2;
        
        let seedKey = 'plains';
        let noiseSeed = this.noiseSeeds['plains'];

        // Calculate relative position from world center for biome detection
        const relX = x - centerX;
        const relZ = z - centerZ;
        const distanceFromCenter = Math.sqrt(relX * relX + relZ * relZ);

        // Simple biome radius-based system (can be extended)
        if (distanceFromCenter < 40) {
            seedKey = 'plains';
        } else if (distanceFromCenter < 80) {
            seedKey = distanceFromCenter < 65 ? 'forest' : 'desert';
        } else if (distanceFromCenter < 120) {
            seedKey = distanceFromCenter < 90 ? 'mountain' : 'snow';
        } else if (distanceFromCenter < 180) {
            seedKey = 'swamp';
        }

        // Generate height using multi-octave noise
        let height = 0;
        let frequency = this.noiseScale;
        let amplitude = 1.0;

        for (let i = 0; i < this.octaves; i++) {
            const y = Math.floor(this.simplexNoise.noise(relX * frequency, relZ * frequency) * amplitude);
            height += y;
            frequency *= this.lacunarity;
            amplitude *= this.persistence;
        }

        // Clamp to valid range
        height = Math.max(this.minHeight, Math.min(this.maxHeight, height));

        return { height: height, biome: seedKey };
    }

    /**
     * Generate cave structures using diamond noise algorithm
     * Uses a separate noise channel with different parameters for underground caves
     * @param {number} x - X coordinate
     * @param {number} z - Z coordinate
     * @returns {{ isCave: boolean, caveNoise: number }} Cave data
     */
    generateCaves(x, z) {
        const centerX = this.width / 2;
        const centerZ = this.height / 2;

        // Only generate caves below surface level (y < 0 relative to surface)
        if (x + z > this.width || x + z > this.height) return { isCave: false, caveNoise: 0 };

        let seedKey = 'plains';
        let noiseSeed = this.noiseSeeds['plains'];

        // Determine biome for cave type
        const relX = x - centerX;
        const relZ = z - centerZ;
        const distanceFromCenter = Math.sqrt(relX * relX + relZ * relZ);

        if (distanceFromCenter < 40) seedKey = 'plains';
        else if (distanceFromCenter < 80) seedKey = 'forest';
        else if (distanceFromCenter < 120) seedKey = 'desert';
        else if (distanceFromCenter < 180) seedKey = 'swamp';

        const caveNoiseSeed = this.noiseSeeds[seedKey];

        // Diamond noise: multiple octaves with different frequencies for realistic caves
        let caveNoise = 0;
        let frequency = this.diamondScale;
        let amplitude = 1.0;
        let detail = 0;

        for (let i = 0; i < this.diamondOctaves; i++) {
            const value = Math.floor(this.simplexNoise.noise(relX * frequency, relZ * frequency) * amplitude);
            caveNoise += value;
            frequency *= this.lacunarity;
            amplitude *= this.persistence;
            detail += (value !== 0 && Math.abs(value) > Math.abs(caveNoise)) ? value : detail;
        }

        // Combine noise values with a weighted average for smoother results
        caveNoise = (caveNoise + detail) * 0.5;

        // Cave threshold - caves form where noise exceeds this value
        const isCave = caveNoise > 16; // Higher threshold creates fewer, larger caves

        return { isCave: isCave, caveNoise: caveNoise };
    }

    /**
     * Generate ore deposits at specific depths
     * @param {number} x - X coordinate
     * @param {number} z - Z coordinate
     * @returns {{ ores: Object }} Ore data keyed by ore type
     */
    generateOres(x, z) {
        const centerX = this.width / 2;
        const centerZ = this.height / 2;

        const relX = x - centerX;
        const relZ = z - centerZ;
        const distanceFromCenter = Math.sqrt(relX * relX + relZ * relZ);

        // Determine biome for ore type variation
        let seedKey = 'plains';
        if (distanceFromCenter < 40) seedKey = 'plains';
        else if (distanceFromCenter < 80) seedKey = distanceFromCenter < 65 ? 'forest' : 'desert';
        else if (distanceFromCenter < 120) seedKey = distanceFromCenter < 90 ? 'mountain' : 'snow';

        const noiseSeed = this.noiseSeeds[seedKey];

        // Coal: -16 to -24 (deepest level)
        const coalNoise = Math.abs(this.simplexNoise.noise(relX * this.diamondScale, relZ * this.diamondScale) * 16);
        let hasCoal = false;
        if (coalNoise > 8 && x + z > this.height - 20) {
            hasCoal = true;
        }

        // Iron: -32 to -56
        const ironNoise = Math.abs(this.simplexNoise.noise(relX * this.diamondScale, relZ * this.diamondScale) * 16);
        let hasIron = false;
        if (ironNoise > 8 && x + z > this.height - 50) {
            hasIron = true;
        }

        // Gold: -48 to -64
        const goldNoise = Math.abs(this.simplexNoise.noise(relX * this.diamondScale, relZ * this.diamondScale) * 16);
        let hasGold = false;
        if (goldNoise > 8 && x + z > this.height - 70) {
            // Gold more common in mountains
            const distanceThreshold = seedKey === 'mountain' ? 90 : 120;
            hasGold = Math.abs(goldNoise) > 8 * (seedKey === 'mountain' ? 1.5 : 1.0);
        }

        // Diamond: -56 to -90
        const diamondNoise = Math.abs(this.simplexNoise.noise(relX * this.diamondScale, relZ * this.diamondScale) * 24);
        let hasDiamond = false;
        if (diamondNoise > 10 && x + z > this.height - 85) {
            // Diamond most common in mountains and snow biomes
            const distanceThreshold = seedKey === 'mountain' ? 90 : seedKey === 'snow' ? 130 : 180;
            hasDiamond = Math.abs(diamondNoise) > 10 * (seedKey === 'mountain' ? 2.0 : seedKey === 'snow' ? 1.5 : 1.0);
        }

        // Redstone: -30 to -60
        const redstoneNoise = Math.abs(this.simplexNoise.noise(relX * this.diamondScale, relZ * this.diamondScale) * 24);
        let hasRedstone = false;
        if (redstoneNoise > 10 && x + z > this.height - 60) {
            hasRedstone = true;
        }

        // Lapis Lazuli: -37 to -59
        const lapisNoise = Math.abs(this.simplexNoise.noise(relX * this.diamondScale, relZ * this.diamondScale) * 24);
        let hasLapis = false;
        if (lapisNoise > 10 && x + z > this.height - 65) {
            // Lapis common near water bodies (simulated by biome proximity to "water" biomes)
            const distanceThreshold = seedKey === 'swamp' ? 45 : 80;
            hasLapis = Math.abs(lapisNoise) > 10 * (seedKey === 'swamp' ? 3.0 : 1.5);
        }

        // Emerald: -29 to -76
        const emeraldNoise = Math.abs(this.simplexNoise.noise(relX * this.diamondScale, relZ * this.diamondScale) * 32);
        let hasEmerald = false;
        if (emeraldNoise > 12 && x + z > this.height - 75) {
            // Emerald common in mountains and forests
            const distanceThreshold = seedKey === 'mountain' ? 90 : seedKey === 'forest' ? 80 : 130;
            hasEmerald = Math.abs(emeraldNoise) > 12 * (seedKey === 'mountain' ? 2.5 : seedKey === 'forest' ? 2.0 : 1.2);
        }

        return { ores: { coal: hasCoal, iron: hasIron, gold: hasGold, diamond: hasDiamond, redstone: hasRedstone, lapis: hasLapis, emerald: hasEmerald } };
    }

    /**
     * Generate chunk data for a given world position
     * @param {number} x - X coordinate (world space)
     * @param {number} z - Z coordinate (world space)
     * @returns {{ chunks: Object, biomeColor: string }} Chunk generation results
     */
    generateChunk(x, z) {
        // Calculate chunk coordinates
        const chunkX = Math.floor(x / this.chunkSize);
        const chunkZ = Math.floor(z / this.chunkSize);

        // Generate surface terrain for each block in the chunk
        const chunks = {};
        let biomeColor = '';

        for (let x = 0; x < this.chunkSize; x++) {
            for (let z = 0; z < this.chunkSize; z++) {
                const worldX = x + (chunkX * this.chunkSize);
                const worldZ = z + (chunkZ * this.chunkSize);

                // Get surface height and biome
                const terrainData = this.getTerrainHeight(worldX, worldZ);
                const biomeColor = this.biomes[terrainData.biome].color;

                chunks[`c_${worldX}_${worldZ}`] = {
                    x: worldX,
                    z: worldZ,
                    height: terrainData.height,
                    biome: terrainData.biome,
                    biomeColor: biomeColor,
                    caveNoise: 0,
                    ores: {}
                };

                // Generate caves for this block (only if below surface)
                if (terrainData.height > 0) {
                    const caveData = this.generateCaves(worldX, worldZ);
                    chunks[`c_${worldX}_${worldZ}`].caveNoise = caveData.caveNoise;
                    chunks[`c_${worldX}_${worldZ}`].isCave = caveData.isCave;

                    if (chunks[`c_${worldX}_${worldZ}`].isCave) {
                        const oreData = this.generateOres(worldX, worldZ);
                        chunks[`c_${worldX}_${worldZ}`].ores = oreData.ores;
                    }
                } else {
                    // Surface blocks - generate ores near surface in mountains
                    if (terrainData.biome === 'mountain' || terrainData.biome === 'snow') {
                        const oreData = this.generateOres(worldX, worldZ);
                        chunks[`c_${worldX}_${worldZ}`].ores = oreData.ores;
                    }
                }

                // Calculate noise level for vegetation generation
                if (terrainData.height >= 0) {
                    const surfaceNoise = Math.abs(this.simplexNoise.noise(worldX * this.noiseScale, worldZ * this.noiseScale));
                    chunks[`c_${worldX}_${worldZ}`].surfaceNoise = surfaceNoise;

                    // Determine vegetation based on biome and noise
                    if (terrainData.biome === 'desert') {
                        if (surfaceNoise < 0.2) {
                            chunks[`c_${worldX}_${worldZ}`].vegetation = { type: 'sand', density: Math.min(Math.floor(surfaceNoise * 5), 64) };
                        } else if (surfaceNoise > 0.3) {
                            // Dune formation
                            const duneHeight = Math.abs(this.simplexNoise.noise(worldX * this.noiseScale, worldZ * this.noiseScale) * 8);
                            chunks[`c_${worldX}_${worldZ}`].vegetation = { type: 'dune', height: duneHeight };
                        } else {
                            chunks[`c_${worldX}_${worldZ}`].vegetation = null;
                        }
                    } else if (terrainData.biome === 'swamp') {
                        const waterLevel = terrainData.height - 4 + Math.floor(surfaceNoise * 8);
                        chunks[`c_${worldX}_${worldZ}`].waterLevel = Math.max(0, Math.min(waterLevel, this.chunkSize));
                    } else if (terrainData.biome === 'plains' || terrainData.biome === 'forest' || 
                               terrainData.biome === 'mountain' || terrainData.biome === 'snow') {
                        const vegNoise = Math.abs(this.simplexNoise.noise(worldX * this.noiseScale, worldZ * this.noiseScale));
                        
                        if (terrainData.biome === 'forest') {
                            chunks[`c_${worldX}_${worldZ}`].vegetation = { type: 'tree', density: Math.min(Math.floor(vegNoise * 10), 32) };
                        } else if (terrainData.biome === 'snow' && vegNoise < 0.7) {
                            chunks[`c_${worldX}_${worldZ}`].vegetation = { type: 'snow_puff', density: Math.min(Math.floor(vegNoise * 8), 16) };
                        } else if (terrainData.biome === 'plains' && vegNoise < 0.4) {
                            chunks[`c_${worldX}_${worldZ}`].vegetation = { type: 'grass', density: Math.min(Math.floor(vegNoise * 3), 8) };
                        }
                    }
                }
            }
        }

        return { chunks, biomeColor };
    }

    /**
     * Load or generate a chunk at the given position
     * @param {number} x - X coordinate (chunk space)
     * @param {number} z - Z coordinate (chunk space)
     * @returns {{ worldX: number, worldZ: number, data: Object }} Loaded chunk data
     */
    loadChunk(x, z) {
        const key = `c_${x}_${z}`;
        
        if (!this.chunks.has(key)) {
            // Generate new chunk
            const globalX = x * this.chunkSize;
            const globalZ = z * this.chunkSize;
            const data = this.generateChunk(globalX, globalZ);
            
            // Store in memory
            for (const [blockKey, blockData] of Object.entries(data.chunks)) {
                this.chunks.set(blockKey, blockData);
            }
        }

        return { 
            worldX: x * this.chunkSize,
            worldZ: z * this.chunkSize,
            data: this.chunks.get(key) || {}
        };
    }

    /**
     * Unload chunks that are outside the current render distance
     */
    unloadChunks(centerChunkX, centerChunkZ, renderDistance) {
        const keys = Array.from(this.chunks.keys());
        
        for (const key of keys) {
            const [x, z] = key.split('_').map(Number);
            
            // Calculate chunk distance from center using Manhattan distance
            const dist = Math.abs(x - centerChunkX) + Math.abs(z - centerChunkZ);

            if (dist > renderDistance) {
                this.chunks.delete(key);
            }
        }
    }

    /**
     * Get block data at a specific world position
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} z - Z coordinate
     * @returns {{ block: Object }} Block data including type, color, etc.
     */
    getBlockData(x, y, z) {
        // Clamp coordinates to world bounds
        x = Math.max(0, Math.min(x, this.width - 1));
        y = Math.max(-32, Math.min(y, this.height - 1));
        z = Math.max(0, Math.min(z, this.depth - 1));

        // Find the chunk containing this position
        const chunkX = Math.floor(x / this.chunkSize);
        const chunkZ = Math.floor(z / this.chunkSize);
        
        let blockData = null;

        if (this.chunks.has(`c_${chunkX}_${chunkZ}`)) {
            for (const [key, data] of Object.entries(this.chunks.get(`c_${chunkX}_${chunkZ}`))) {
                if (data.x === x && data.z === z) {
                    blockData = data;
                    break;
                }
            }
        }

        // If no cached chunk, generate on-demand
        if (!blockData) {
            const terrain = this.getTerrainHeight(x, z);
            
            // Determine block type at this height
            let blockType = 'dirt';
            let color = '#795548';

            if (terrain.height === y) {
                // Surface level - grass or sand depending on biome
                const biomeColor = this.biomes[terrain.biome].grassColor;
                color = biomeColor;
                blockType = 'grass';
            } else if (y > terrain.height) {
                // Underground - dirt or stone
                if (y < terrain.height - 5) {
                    blockType = 'stone';
                    color = '#9e9e9e';
                } else {
                    blockType = 'dirt';
                    color = '#795548';
                }
            } else if (terrain.biome === 'desert') {
                blockType = 'sand';
                color = '#f5deb3';
            }

            // Check for ore
            let hasOre = false;
            let oreType = '';

            if (blockData && blockData.ores) {
                const ores = Object.keys(blockData.ores);
                
                // Coal: -16 to -24
                if (y < 0 && y > -17 && ores.includes('coal')) hasOre = 'coal';
                // Iron: -32 to -56
                else if (y < 0 && y > -33 && ores.includes('iron')) hasOre = 'iron';
                // Gold: -48 to -64
                else if (y < 0 && y > -49 && ores.includes('gold')) hasOre = 'gold';
                // Diamond: -56 to -90
                else if (y < 0 && y > -57 && ores.includes('diamond')) hasOre = 'diamond';
                // Redstone: -30 to -60
                else if (y < 0 && y > -31 && ores.includes('redstone')) hasOre = 'redstone';
                // Lapis: -37 to -59
                else if (y < 0 && y > -38 && ores.includes('lapis')) hasOre = 'lapis';
                // Emerald: -29 to -76
                else if (y < 0 && y > -30 && ores.includes('emerald')) hasOre = 'emerald';
            }

            blockData = {
                type: hasOre ? `${blockType}_${hasOre}` : blockType,
                color: color || '#795548',
                isCave: blockData ? blockData.isCave : false,
                biome: terrain.biome
            };

            // Cache it
            this.chunks.set(`c_${chunkX}_${chunkZ}`, { ...this.chunks.get(`c_${chunkX}_${chunkZ}`), [`c_${x}_${z}`]: blockData });
        }

        return { block: blockData };
    }

    /**
     * Get the biome name at a world position
     * @param {number} x - X coordinate
     * @param {number} z - Z coordinate
     * @returns {string} Biome name
     */
    getBiome(x, z) {
        const terrain = this.getTerrainHeight(x, z);
        return terrain.biome;
    }

    /**
     * Get the biome color at a world position (for rendering purposes)
     * @param {number} x - X coordinate
     * @param {number} z - Z coordinate
     * @returns {string} Color string in hex format
     */
    getBiomeColor(x, z) {
        const terrain = this.getTerrainHeight(x, z);
        return this.biomes[terrain.biome].color;
    }

    /**
     * Get the terrain height at a position for rendering purposes
     * @param {number} x - X coordinate
     * @param {number} z - Z coordinate
     * @returns {number} Height value
     */
    getTerrainHeightAt(x, z) {
        const terrain = this.getTerrainHeight(x, z);
        return terrain.height;
    }

    /**
     * Check if a position is inside a cave
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} z - Z coordinate
     * @returns {boolean} True if inside a cave
     */
    isInCave(x, y, z) {
        const blockData = this.getBlockData(x, y, z);
        return blockData && blockData.isCave;
    }

    /**
     * Get ore presence at a position
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} z - Z coordinate
     * @returns {{ ores: Object }} Ore data
     */
    getOres(x, y, z) {
        const blockData = this.getBlockData(x, y, z);
        return blockData ? blockData.ores : {};
    }

    /**
     * Clear all chunk data (useful for resetting the world)
     */
    clearChunks() {
        this.chunks.clear();
    }

    /**
     * Get statistics about the generated world
     * @returns {{ stats: Object }} World generation statistics
     */
    getStats() {
        let totalBlocks = 0;
        let caveCount = 0;
        let oreCounts = {};

        for (const [key, data] of this.chunks.entries()) {
            totalBlocks += Object.keys(data).length;

            if (data.caveNoise) {
                caveCount++;
            }

            if (data.ores) {
                for (const [oreType, present] of Object.entries(data.ores)) {
                    oreCounts[oreType] = (oreCounts[oreType] || 0) + (present ? 1 : 0);
                }
            }
        }

        return {
            totalBlocks: totalBlocks,
            chunksLoaded: this.chunks.size,
            caveChunks: caveCount,
            ores: oreCounts
        };
    }

    /**
     * Set the biome listener callback (for biome change notifications)
     * @param {Function} callback - Callback function for biome changes
     */
    setBiomeListener(callback) {
        this.biomeListener = callback;
    }

    /**
     * Update biome based on current player position
     * @returns {string|null} New biome name or null if unchanged
     */
    updatePlayerBiome(playerX, playerZ) {
        const newBiome = this.getBiome(playerX, playerZ);
        
        if (this.currentBiome !== newBiome && this.biomeListener) {
            this.currentBiome = newBiome;
            return true; // Biome changed
        }

        return false; // No change
    }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = World;
}
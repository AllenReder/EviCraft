export function canonicalBlockId(blockState: string): string {
  const properties = blockState.indexOf("[");
  return properties < 0 ? blockState : blockState.slice(0, properties);
}

export function canonicalIdGlobPattern(glob: string): RegExp {
  let source = "^";
  for (const character of glob) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

/** Vanilla ores that also generate as a deepslate_ variant. */
const DEEPSLATE_ORE_BASES = [
  "coal_ore", "copper_ore", "diamond_ore", "emerald_ore", "gold_ore", "iron_ore", "lapis_ore", "redstone_ore",
] as const;
const MAX_ORE_VARIANT_NOTES = 2;

/**
 * Names the ore variant a block glob leaves out. Reads only the glob text, never World
 * Knowledge, so the note is identical whatever the Agent has or has not observed.
 */
export function oreVariantGlobNote(glob: string): string | undefined {
  const pattern = canonicalIdGlobPattern(glob);
  const notes = DEEPSLATE_ORE_BASES.flatMap((base) => {
    const plain = `minecraft:${base}`;
    const deepslate = `minecraft:deepslate_${base}`;
    if (pattern.test(plain) === pattern.test(deepslate)) return [];
    const missed = pattern.test(plain) ? deepslate : plain;
    return [`${glob} misses ${missed}; minecraft:*${base} matches both`];
  });
  if (notes.length === 0) return undefined;
  const shown = notes.slice(0, MAX_ORE_VARIANT_NOTES).join("; ");
  return `note: ${shown}${notes.length > MAX_ORE_VARIANT_NOTES ? "; other ores likewise" : ""}`;
}

export function withOreVariantGlobNote(message: string, glob: string | undefined): string {
  const note = glob === undefined ? undefined : oreVariantGlobNote(glob);
  return note === undefined ? message : `${message} (${note})`;
}

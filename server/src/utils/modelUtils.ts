/**
 * Shared model utility functions.
 * Keep this file free of heavy imports — it is used in hot paths.
 */

/**
 * Extract parameter count (in billions) from a model name string.
 * Examples:
 *   "qwen3-vl:235b"      → 235
 *   "llama3.2:3b"        → 3
 *   "deepseek-v3-0324"   → 0  (no size token)
 *   "gpt-4o"             → 0  (cloud API — assume fast/large)
 *
 * Returns 0 when the count cannot be determined. Callers should treat 0 as
 * "unknown / assume capable" — do NOT penalize unknown models.
 */
export function parseParamCount(modelName: string): number {
    const lower = modelName.toLowerCase();
    // Separator-prefixed pattern first: ":235b", "-70b", "_7b" — most specific
    const prefixed = lower.match(/[:\-_](\d+(?:\.\d+)?)b\b/);
    if (prefixed) return parseFloat(prefixed[1]);
    // Loose match anywhere in name: "llama8b", "phi3.5b"
    const loose = lower.match(/(\d+(?:\.\d+)?)b\b/);
    if (loose) return parseFloat(loose[1]);
    return 0;
}

/**
 * Returns true when the model is a known small local model (≤ threshold params).
 * Cloud APIs (gpt-4o, claude, gemini) return false — they're large by default.
 */
export function isSmallModel(modelName: string, thresholdB = 8): boolean {
    const count = parseParamCount(modelName);
    return count > 0 && count <= thresholdB; // 0 = unknown = not small
}

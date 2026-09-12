import { randomBytes } from "node:crypto";

export interface PreservedBlock {
  id: string;
  placeholder: string;
  originalText: string;
  type:
    | "code_block"
    | "inline_code"
    | "url"
    | "file_path"
    | "env_var"
    | "version"
    | "stack_trace";
}

export interface ExtractionResult {
  text: string;
  blocks: PreservedBlock[];
  restore: (compressedText: string) => string;
}

export interface FidelityResult {
  ok: boolean;
  totalBlocks: number;
  preservedBlocks: number;
  missingBlocks: string[];
  missingNumbers: string[];
}

// Regex patterns ordered by extraction precedence
const PATTERNS: Array<{
  type: PreservedBlock["type"];
  regex: RegExp;
}> = [
  // Fenced code blocks ```...```
  {
    type: "code_block",
    regex: /```[\s\S]*?```/g,
  },
  // Inline code `...`
  {
    type: "inline_code",
    regex: /`[^`\r\n]+`/g,
  },
  // URLs
  {
    type: "url",
    regex: /https?:\/\/[^\s<>"':;()[\]{}]+[^\s<>"':;()[\]{}.,?!]/gi,
  },
  // Stack traces / error lines (e.g., "   at Module._compile (node:internal/modules/cjs/loader:1376:14)")
  {
    type: "stack_trace",
    regex: /^\s*at\s+[\w.<>$]+\s+\([^)]+\)/gm,
  },
  // Absolute Unix / Windows file paths or relative paths starting with ./ or ../
  {
    type: "file_path",
    // Keep the path body as a single character class. Nested repetitions here
    // made malformed relative paths trigger exponential backtracking.
    regex: /(?:\/[a-zA-Z0-9_./-]+|(?:\.\.?\/[a-zA-Z0-9_./-]+)|[a-zA-Z]:\\[a-zA-Z0-9_.\\-]+)\.[a-zA-Z0-9]+/g,
  },
  // Env variables ($VAR, ${VAR}, or ALL_CAPS_VAR=)
  {
    type: "env_var",
    regex: /\$\{[A-Z0-9_]+\}|\$[A-Z0-9_]+|\b[A-Z0-9_]{3,}=(?=[^\s]+)/g,
  },
  // Semantic version strings (e.g. v1.2.3, v0.1.0-beta.2)
  {
    type: "version",
    regex: /\bv?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\b/g,
  },
];

/**
 * Extracts protected patterns from text and replaces them with unique sentinel placeholders.
 */
export function extractPreservedBlocks(text: string): ExtractionResult {
  if (!text || typeof text !== "string") {
    return {
      text: text || "",
      blocks: [],
      restore: (compressedText: string) => compressedText || "",
    };
  }

  const seed = randomBytes(4).toString("hex");
  const blocks: PreservedBlock[] = [];
  let currentText = text;
  let blockIndex = 0;

  for (const { type, regex } of PATTERNS) {
    currentText = currentText.replace(regex, (match) => {
      // Avoid re-extracting inside an already generated sentinel placeholder
      if (match.includes("\0ROTATOR_PRESERVE_")) {
        return match;
      }
      const id = `ROTATOR_PRESERVE_${seed}_${blockIndex++}`;
      const placeholder = `\0${id}\0`;
      blocks.push({
        id,
        placeholder,
        originalText: match,
        type,
      });
      return placeholder;
    });
  }

  const restore = (compressedText: string): string => {
    return restorePreservedBlocks(compressedText, blocks);
  };

  return {
    text: currentText,
    blocks,
    restore,
  };
}

/**
 * Restores sentinel placeholders back to their original text.
 */
export function restorePreservedBlocks(
  compressedText: string,
  blocks: PreservedBlock[],
): string {
  if (!compressedText || blocks.length === 0) {
    return compressedText || "";
  }

  let restored = compressedText;
  // Restore in reverse order of extraction to handle any potential nesting cleanly
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    restored = restored.replaceAll(block.placeholder, block.originalText);
  }
  return restored;
}

/**
 * Verifies that preserved blocks and critical literals (like numbers) survive compression.
 */
export function verifyFidelity(
  originalText: string,
  restoredText: string,
  blocks: PreservedBlock[],
  minPreservedRatio = 0.95,
): FidelityResult {
  const missingBlocks: string[] = [];
  let preservedCount = 0;

  for (const block of blocks) {
    if (restoredText.includes(block.originalText)) {
      preservedCount++;
    } else {
      missingBlocks.push(block.originalText);
    }
  }

  // Verify numerical literals in original survive in restored text
  const missingNumbers: string[] = [];
  const numbersInOriginal = originalText.match(/\b\d+(?:\.\d+)?\b/g) || [];
  const uniqueNumbers = Array.from(new Set(numbersInOriginal));

  for (const num of uniqueNumbers) {
    if (!restoredText.includes(num)) {
      missingNumbers.push(num);
    }
  }

  const totalBlocks = blocks.length;
  const ratio = totalBlocks > 0 ? preservedCount / totalBlocks : 1.0;
  const ok = ratio >= minPreservedRatio && missingNumbers.length === 0;

  return {
    ok,
    totalBlocks,
    preservedBlocks: preservedCount,
    missingBlocks,
    missingNumbers,
  };
}

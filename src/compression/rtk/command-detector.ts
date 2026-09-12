export interface CommandDetectionResult {
  type: string;
  command: string | null;
  confidence: number;
  category:
    | "git"
    | "test"
    | "build"
    | "shell"
    | "docker"
    | "package"
    | "infra"
    | "cloud"
    | "generic";
  matchedPatterns: string[];
}

type Detector = {
  type: string;
  category: CommandDetectionResult["category"];
  commandPatterns: RegExp[];
  contentPatterns: RegExp[];
};

const DETECTORS: Detector[] = [
  {
    type: "git-status",
    category: "git",
    commandPatterns: [/^git\s+status\b/i],
    contentPatterns: [
      /^On branch /m,
      /^Changes (?:not staged|to be committed)/m,
      /^Untracked files:/m,
    ],
  },
  {
    type: "git-branch",
    category: "git",
    commandPatterns: [
      /^git\s+branch\b/i,
      /^git\s+checkout\b/i,
      /^git\s+switch\b/i,
    ],
    contentPatterns: [
      /^\*\s+\S+/m,
      /Switched to (?:a new )?branch/i,
      /Already on ['"][^'"]+['"]/i,
    ],
  },
  {
    type: "git-diff",
    category: "git",
    commandPatterns: [/^git\s+diff\b/i, /^git\s+show\b/i],
    contentPatterns: [/^diff --git /m, /^index [0-9a-f]+\.\.[0-9a-f]+/m],
  },
  {
    type: "git-log",
    category: "git",
    commandPatterns: [/^git\s+log\b/i],
    contentPatterns: [/^commit [0-9a-f]{40}/m, /^Author:\s+/m],
  },
  {
    type: "npm-install",
    category: "package",
    commandPatterns: [
      /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/i,
      /^bundle\s+install\b/i,
      /^composer\s+install\b/i,
    ],
    contentPatterns: [
      /added \d+ packages/i,
      /packages are looking for funding/i,
      /Lockfile is up to date/i,
    ],
  },
  {
    type: "build-typescript",
    category: "build",
    commandPatterns: [/^tsc\b/i, /^npm\s+run\s+typecheck\b/i],
    contentPatterns: [/: error TS\d+:/m, /Found \d+ errors?/i],
  },
  {
    type: "test-pytest",
    category: "test",
    commandPatterns: [/^pytest\b/i, /^python\s+-m\s+pytest\b/i],
    contentPatterns: [
      /===+ (?:test session starts|passed|failed) ===+/i,
      /rootdir:/i,
    ],
  },
  {
    type: "test-jest",
    category: "test",
    commandPatterns: [/^jest\b/i, /^npm\s+test\b/i, /^npx\s+jest\b/i],
    contentPatterns: [
      /PASS\s+\S+\.test\.(?:js|ts|jsx|tsx)/i,
      /FAIL\s+\S+\.test\.(?:js|ts|jsx|tsx)/i,
      /Test Suites:\s+\d+/i,
    ],
  },
  {
    type: "test-vitest",
    category: "test",
    commandPatterns: [/vitest\b/i],
    contentPatterns: [/✓\s+\S+\.\w+/m, /FAIL\s+\S+\.\w+/m, /Test Files\s+\d+/i],
  },
  {
    type: "docker-build",
    category: "docker",
    commandPatterns: [/^docker\s+build\b/i, /^docker\s+compose\s+build\b/i],
    contentPatterns: [
      /^Step \d+\/\d+ :/m,
      /^#\d+ \[internal\]/m,
      /EXPORTING HASHE/i,
    ],
  },
];

export function detectCommandType(
  text: string,
  command?: string | null,
): CommandDetectionResult {
  const matchedPatterns: string[] = [];

  if (command) {
    const trimmed = command.trim();
    for (const detector of DETECTORS) {
      if (detector.commandPatterns.some((pattern) => pattern.test(trimmed))) {
        return {
          type: detector.type,
          command: trimmed,
          confidence: 0.95,
          category: detector.category,
          matchedPatterns: [`command:${detector.type}`],
        };
      }
    }
  }

  for (const detector of DETECTORS) {
    let matched = 0;
    for (const pattern of detector.contentPatterns) {
      if (pattern.test(text)) {
        matched++;
        matchedPatterns.push(`content:${pattern.source}`);
      }
    }
    if (matched > 0) {
      const confidence = Math.min(
        0.9,
        0.5 + (matched / detector.contentPatterns.length) * 0.4,
      );
      return {
        type: detector.type,
        command: command || null,
        confidence,
        category: detector.category,
        matchedPatterns,
      };
    }
  }

  return {
    type: "generic-output",
    command: command || null,
    confidence: 0.1,
    category: "generic",
    matchedPatterns: [],
  };
}

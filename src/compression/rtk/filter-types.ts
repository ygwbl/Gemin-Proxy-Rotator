export interface RtkFilterDefinition {
  id: string;
  label: string;
  category?: string;
  match?: {
    outputTypes?: string[];
    commands?: string[];
    patterns?: string[];
  };
  rules?: {
    dropPatterns?: string[];
    includePatterns?: string[];
    stripAnsi?: boolean;
    collapseDuplicates?: boolean;
    maxLines?: number;
    maxLineLength?: number;
  };
  preserve?: {
    errorPatterns?: string[];
    summaryPatterns?: string[];
  };
  rtkTomlHeadLines?: number;
  rtkTomlTailLines?: number;
  rtkTomlMaxLines?: number;
}

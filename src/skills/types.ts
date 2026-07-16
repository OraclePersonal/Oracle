export interface Skill {
  name: string;
  description: string;
  systemPrompt: string;
  filePatterns?: string[];
  model?: string;
  version?: string;
  author?: string;
}

export interface Identity {
  name: string;
  title?: string;
  role?: string;
  description?: string;
  preferences?: string[];
  habits?: string[];
  goals?: string[];
  traits?: Record<string, string>;
}

export interface Persona {
  name: string;
  greeting?: string;
  tone?: "professional" | "casual" | "friendly" | "witty";
  style?: string;
  systemPrompt?: string;
}

export const DEFAULT_PERSONA: Persona = {
  name: "Oracle",
  greeting: "I'm Oracle, your personal AI consultant.",
  tone: "professional",
  style: "Clear, direct, and thoughtful."
};

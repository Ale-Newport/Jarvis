import type { LlmProvider } from "../api/types";

export const PROVIDER_PRESETS: { id: LlmProvider; label: string; base_url: string; hint: string; needsKey: boolean }[] = [
  { id: "ollama", label: "Ollama", base_url: "http://127.0.0.1:11434/v1", hint: "Runs on this Mac. Free and private.", needsKey: false },
  { id: "lmstudio", label: "LM Studio", base_url: "http://127.0.0.1:1234/v1", hint: "Runs on this Mac via LM Studio's local server.", needsKey: false },
  { id: "openrouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", hint: "Cloud models. Your prompts and page text are sent to OpenRouter.", needsKey: true },
  { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1", hint: "Cloud models. Your prompts and page text are sent to OpenAI.", needsKey: true },
  { id: "custom", label: "Custom", base_url: "", hint: "Any OpenAI-compatible endpoint.", needsKey: false },
];

export const presetFor = (id: string) => PROVIDER_PRESETS.find((p) => p.id === id);

export const DEFAULT_PULL_MODEL = "qwen3:8b";

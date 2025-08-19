import React, { useEffect, useRef, useState } from "react";

/**
 * Drop-in React component to add STREAMING + LIVE PREVIEW to your Slate (Tauri + Ollama) app.
 * Works with Ollama's native API (/api/generate) and OpenAI-compatible API (/v1/chat/completions).
 * Tailwind CSS classes are used for quick styling. Replace as needed.
 */

// -----------------------------
// Low-level streaming helpers
// -----------------------------

/** Parse an Ollama *native* streaming response (JSONL).
 * Each chunk is a JSON object like: { model, created_at, response, done, ... }
 */
async function streamOllamaNative(opts: {
  baseUrl?: string;
  model: string;
  prompt: string;
  temperature?: number;
  onToken: (t: string) => void;
  onDone: (full: string) => void;
  onError: (e: Error) => void;
}) {
  const { baseUrl = "http://127.0.0.1:11434", model, prompt, temperature = 0.6, onToken, onDone, onError } = opts;

  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: true, options: { temperature } }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });

      // Split by newlines because Ollama streams JSON lines (JSONL)
      for (const line of text.split(/\n+/).filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          if (obj.response) {
            onToken(obj.response);
            full += obj.response;
          }
          if (obj.done) {
            onDone(full);
          }
        } catch (e) {
          // ignore partial JSON lines while streaming
        }
      }
    }
  } catch (e: any) {
    onError(e);
  }
}

/** Parse an OpenAI-compatible /v1/chat/completions streaming response.
 * Many OpenAI clients send Server-Sent Events (SSE) where each event starts with "data: ...".
 */
async function streamOpenAICompat(opts: {
  baseUrl?: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  onToken: (t: string) => void;
  onDone: (full: string) => void;
  onError: (e: Error) => void;
}) {
  const { baseUrl = "http://127.0.0.1:11434/v1", model, messages, temperature = 0.6, onToken, onDone, onError } = opts;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Some clients require a key; Ollama accepts any bearer for local use.
        Authorization: "Bearer ollama",
      },
      body: JSON.stringify({ model, messages, temperature, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split SSE events by lines
      const lines = buffer.split(/\n/);
      buffer = lines.pop() || ""; // keep the last partial line in buffer

      for (const l of lines) {
        const line = l.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.replace(/^data:\s*/, "");
        if (payload === "[DONE]") {
          onDone(full);
          return;
        }
        try {
          const delta = JSON.parse(payload);
          const piece = delta.choices?.[0]?.delta?.content || "";
          if (piece) {
            full += piece;
            onToken(piece);
          }
        } catch {
          // ignore JSON parse errors on partial packets
        }
      }
    }
  } catch (e: any) {
    onError(e);
  }
}

// ---------------------------------
// UI: Streaming generator component
// ---------------------------------

export default function SlateStreamingDemo() {
  const [prompt, setPrompt] = useState(
    "Create a colorful kids homepage with a friendly mascot, a big header, three feature cards, and a simple contact form."
  );
  const [model, setModel] = useState("codeqwen:7b");
  const [temperature, setTemperature] = useState(0.6);
  const [mode, setMode] = useState<"native" | "openai">("native");

  const [status, setStatus] = useState<"idle" | "connecting" | "streaming" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState(0);
  const [output, setOutput] = useState("");

  const previewRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // Render the live HTML/React-less preview whenever output changes.
    // If your LLM returns full HTML documents, this will display them immediately.
    const iframe = previewRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(output || "<style>body{font-family:system-ui;padding:16px}</style><h3>Live Preview</h3><p>Generated HTML will appear here as it streams...</p>");
    doc.close();
  }, [output]);

  async function handleGenerate() {
    setStatus("connecting");
    setError(null);
    setTokens(0);
    setOutput("");

    const onToken = (t: string) => {
      setStatus("streaming");
      setTokens((n) => n + 1);
      setOutput((s) => s + t);
    };
    const onDone = () => setStatus("done");
    const onError = (e: Error) => {
      setError(e.message);
      setStatus("error");
    };

    if (mode === "native") {
      await streamOllamaNative({ model, prompt, temperature, onToken, onDone, onError });
    } else {
      await streamOpenAICompat({
        model,
        temperature,
        messages: [{ role: "user", content: prompt }],
        onToken,
        onDone,
        onError,
      });
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <h1 className="text-2xl font-bold">Slate – Streaming Preview for Ollama</h1>

      <div className="grid md:grid-cols-2 gap-4 items-start">
        <div className="space-y-3">
          <label className="block text-sm font-medium">Prompt</label>
          <textarea
            className="w-full h-40 p-3 border rounded"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium">Model</label>
              <input
                className="w-full p-2 border rounded"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. codeqwen:7b or llama3.1:8b"
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Temperature</label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                className="w-full p-2 border rounded"
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-sm font-medium">API Mode:</label>
            <select
              className="p-2 border rounded"
              value={mode}
              onChange={(e) => setMode(e.target.value as any)}
            >
              <option value="native">Ollama Native (/api/generate)</option>
              <option value="openai">OpenAI Compatible (/v1/chat)</option>
            </select>
          </div>

          <button
            className="px-4 py-2 bg-indigo-600 text-white rounded shadow"
            onClick={handleGenerate}
          >
            Generate (Streaming)
          </button>

          <div className="text-sm pt-2">
            <strong>Status:</strong> {status}
            {status === "streaming" && <span className="ml-2">• tokens: {tokens}</span>}
            {error && (
              <div className="text-red-600 mt-1 break-all">Error: {error}</div>
            )}
          </div>

          <details className="mt-2">
            <summary className="cursor-pointer font-medium">Raw output</summary>
            <pre className="whitespace-pre-wrap p-2 border rounded bg-gray-50 max-h-72 overflow-auto">{output}</pre>
          </details>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Live Preview</label>
          <iframe ref={previewRef} className="w-full h-[520px] border rounded bg-white" title="preview" />
        </div>
      </div>
    </div>
  );
}

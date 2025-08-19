#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct GenerateArgs {
    prompt: String,
    model: String,
    temperature: f32,
}

#[derive(Debug, Serialize)]
struct Triple {
    html: String,
    css: String,
    js: String,
}

#[derive(Debug, Deserialize)]
struct OllamaResp {
    response: String,
}

const SYSTEM_INSTRUCTIONS: &str = r#"
You are an expert front-end web generator.
OUTPUT FORMAT (MANDATORY):
Return ONLY a JSON object with EXACT keys: "html", "css", "js". No commentary.
- "html": full HTML allowed, semantic and accessible.
- "css": plain CSS (no <style> tag).
- "js": plain JS (no <script> tag).
Constraints: mobile-first, responsive, no external CDNs, self-contained, no inline events; use addEventListener.
"#;

fn extract_json_triple(s: &str) -> anyhow::Result<Triple> {
    let start = s.find('{').ok_or_else(|| anyhow::anyhow!("No JSON start"))?;
    let end = s.rfind('}').ok_or_else(|| anyhow::anyhow!("No JSON end"))?;
    let slice = &s[start..=end];
    let v: serde_json::Value = serde_json::from_str(slice)?;
    let html = v.get("html").and_then(|x| x.as_str()).ok_or_else(|| anyhow::anyhow!("missing html"))?.to_string();
    let css = v.get("css").and_then(|x| x.as_str()).ok_or_else(|| anyhow::anyhow!("missing css"))?.to_string();
    let js  = v.get("js").and_then(|x| x.as_str()).ok_or_else(|| anyhow::anyhow!("missing js"))?.to_string();
    Ok(Triple { html, css, js })
}

#[tauri::command]
async fn generate_site(args: GenerateArgs) -> Result<Triple, String> {
    let base = std::env::var("OLLAMA_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".into());

    let body = serde_json::json!({
        "model": args.model,
        "prompt": format!("{}\n\nUSER PROMPT:\n{}", SYSTEM_INSTRUCTIONS, args.prompt),
        "stream": false,
        "options": { "temperature": args.temperature }
    });

    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/api/generate", base))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("Ollama error status: {}", res.status()));
    }

    let data: OllamaResp = res.json().await.map_err(|e| format!("Invalid JSON: {e}"))?;
    let triple = extract_json_triple(&data.response).map_err(|e| format!("Parse error: {e}"))?;
    Ok(triple)
}

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};
use std::path::PathBuf;

#[tauri::command]
async fn save_zip(
  app: AppHandle,
  default_name: Option<String>,
  bytes: Vec<u8>,
) -> Result<String, String> {
  let picked = app
    .dialog()
    .file()
    .set_file_name(default_name.unwrap_or_else(|| "site.zip".to_string()))
    .blocking_save_file();

  let Some(file_path) = picked else {
    return Err("canceled".into());
  };

  // Match FilePath enum
  let pb: PathBuf = match file_path {
    FilePath::Path(p) => p,
    FilePath::Url(u) => u
      .to_file_path()
      .map_err(|_| "Invalid file URL".to_string())?,
  };

  std::fs::write(&pb, &bytes).map_err(|e| format!("write failed: {e}"))?;

  Ok(pb.to_string_lossy().into_owned())
}


fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![generate_site, save_zip])
    .run(tauri::generate_context!())
    .expect("error while running tauri app");
}



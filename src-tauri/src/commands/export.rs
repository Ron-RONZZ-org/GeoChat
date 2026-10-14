use base64::Engine;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Writes a GeoGebra export to a path the user picks in a native save dialog.
///
/// GeoGebra builds exports in the webview and hands them to `window.ggbExportFile`
/// when a host hook exists. A plain web download has no destination inside the
/// Tauri shell, so the renderer reads the export back and calls this command
/// instead. Returns `false` when the user cancels the dialog.
#[tauri::command]
pub(crate) async fn save_export_file(
    app: AppHandle,
    file_name: String,
    contents_base64: String,
) -> Result<bool, String> {
    let contents = decode_export_payload(&contents_base64)?;
    // `blocking_save_file` must not run on the main thread, which is exactly
    // where a synchronous command would. The command is async so it runs on
    // the runtime thread and the dialog can dispatch to the UI thread.
    let chosen = app
        .dialog()
        .file()
        .set_file_name(file_name)
        .blocking_save_file();
    let Some(file_path) = chosen else {
        return Ok(false);
    };
    let path = file_path
        .into_path()
        .map_err(|error| format!("The save dialog returned an unusable path: {error}"))?;
    std::fs::write(&path, contents)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    Ok(true)
}

fn decode_export_payload(contents_base64: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(|error| format!("Invalid export payload: {error}"))
}

#[cfg(test)]
mod tests {
    use super::decode_export_payload;

    #[test]
    fn decodes_a_base64_export_payload() {
        // "GGB" as raw bytes.
        let decoded = decode_export_payload("R0dC").expect("valid payload");
        assert_eq!(decoded, b"GGB");
    }

    #[test]
    fn rejects_payloads_that_are_not_base64() {
        let error = decode_export_payload("not base64!!").expect_err("invalid payload");
        assert!(error.contains("Invalid export payload"));
    }
}

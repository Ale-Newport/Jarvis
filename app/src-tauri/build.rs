use std::path::Path;

fn main() {
    // `bundle.resources` maps ../backend-dist/jarvis-backend -> Contents/Resources/backend.
    // The PyInstaller output is produced by scripts/package-backend.sh; make sure the directory
    // exists so `tauri dev` / `cargo check` / CI builds never fail when it is empty.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend-dist/jarvis-backend");
    let _ = std::fs::create_dir_all(&dir);
    println!("cargo:rerun-if-changed=../backend-dist/jarvis-backend");

    if std::env::var("PROFILE").as_deref() == Ok("release") && !dir.join("jarvis-backend").exists() {
        println!(
            "cargo:warning=release build without a packaged backend ({}/jarvis-backend is missing); \
             run scripts/package-backend.sh first (or `make build`)",
            dir.display()
        );
    }

    tauri_build::build()
}

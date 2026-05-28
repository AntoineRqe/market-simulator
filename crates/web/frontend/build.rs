use std::fs;
use std::path::Path;

fn main() {
    // Tell cargo to rerun if dist/index.html changes
    let dist_path = Path::new("dist/index.html");
    if dist_path.exists() {
        println!("cargo:rerun-if-changed=dist/index.html");
    }

    // Check if built index.html exists in dist/
    // If it does, we should use that. Otherwise, use the source index.html
    let dist_index = Path::new("dist/index.html");
    let source_index = Path::new("index.html");

    if dist_index.exists() {
        // Copy dist/index.html to root for lib.rs to include
        if let Ok(content) = fs::read_to_string(dist_index) {
            // index.html is already in root, lib.rs includes it
        }
    }

    println!("cargo:rerun-if-changed=src/lib.rs");
}

use std::fs;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=index.html");
    println!("cargo:rerun-if-changed=dist/index.html");
    println!("cargo:rerun-if-changed=src/lib.rs");

    let dist_index = Path::new("dist/index.html");
    let source_index = Path::new("index.html");

    let app_html_source = if dist_index.exists() {
        dist_index
    } else {
        source_index
    };

    let app_html = fs::read_to_string(app_html_source).unwrap_or_else(|e| {
        panic!(
            "failed to read frontend HTML from '{}': {}",
            app_html_source.display(),
            e
        )
    });

    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR must be set");
    let out_path = Path::new(&out_dir).join("app.html");
    fs::write(&out_path, app_html).unwrap_or_else(|e| {
        panic!(
            "failed to write generated frontend HTML to '{}': {}",
            out_path.display(),
            e
        )
    });
}

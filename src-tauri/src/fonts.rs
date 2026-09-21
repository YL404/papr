//! System font enumeration — backs the reader's font picker.
//!
//! Walks the OS font directories once, parses each file's name table with
//! `fontdb`, and returns the sorted set of distinct family names. Webfont
//! families bundled with the app (Newsreader, Inter Tight, …) are merged in so
//! a fresh install sees the same built-in choices as one with system fonts.
//!
//! The scan is a blocking walk of possibly thousands of files, so the command
//! runs it on a background thread and the result is cached for the process
//! lifetime — installing a font while Papr is open needs a relaunch to appear,
//! which matches every native font picker.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Font families shipped inside the webview's own CSS (see `src/main.tsx`).
/// They are always offered, even on a host where none are installed.
const BUNDLED_FAMILIES: [&str; 3] = [
    "Newsreader Variable",
    "Inter Tight Variable",
    "JetBrains Mono Variable",
];

fn font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var("HOME").ok();

    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/System/Library/Fonts"));
        dirs.push(PathBuf::from("/Library/Fonts"));
        if let Some(h) = &home {
            dirs.push(PathBuf::from(h).join("Library/Fonts"));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let windir = std::env::var("windir").unwrap_or_else(|_| "C:\\Windows".to_string());
        dirs.push(PathBuf::from(windir).join("Fonts"));
        if let Some(h) = &home {
            dirs.push(PathBuf::from(h).join("AppData/Local/Microsoft/Windows/Fonts"));
        }
    }

    #[cfg(target_os = "linux")]
    {
        dirs.push(PathBuf::from("/usr/share/fonts"));
        dirs.push(PathBuf::from("/usr/local/share/fonts"));
        if let Some(h) = &home {
            dirs.push(PathBuf::from(h).join(".local/share/fonts"));
            dirs.push(PathBuf::from(h).join(".fonts"));
        }
        if let Ok(xdg_data) = std::env::var("XDG_DATA_HOME") {
            if !xdg_data.is_empty() {
                dirs.push(PathBuf::from(xdg_data).join("fonts"));
            }
        }
    }

    dirs
}

/// Every distinct font family the host plus the app itself can render, A–Z.
/// Empty only if no font directory is readable at all — the picker then still
/// shows the bundled families.
pub fn list_families() -> Vec<String> {
    static CACHE: OnceLock<Vec<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut db = fontdb::Database::new();
            for dir in font_dirs() {
                db.load_fonts_dir(dir);
            }

            let mut families = BTreeSet::new();
            for family in BUNDLED_FAMILIES {
                families.insert(family.to_string());
            }
            for face in db.faces() {
                if let Some((name, _)) = face.families.first() {
                    families.insert(name.clone());
                }
            }

            // `load_fonts_dir` also collects the parse failures as faces with no
            // family; those are already excluded by the `families.first()` read.
            families.into_iter().collect()
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_include_the_bundled_ones() {
        let families = list_families();
        for bundled in BUNDLED_FAMILIES {
            assert!(families.iter().any(|f| f == bundled), "missing {bundled}");
        }
    }

    #[test]
    fn families_are_sorted_and_unique() {
        let families = list_families();
        let mut sorted = families.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(families, sorted);
    }
}

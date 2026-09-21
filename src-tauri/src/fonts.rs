//! System font enumeration — backs the reader's font picker.
//!
//! Walks the OS font directories once, parses each file's name table with
//! `fontdb`, and returns the sorted set of distinct family names. The families
//! bundled with the app (Newsreader, Inter Tight, JetBrains Mono — see
//! `src/main.tsx`) are merged in, so a host with no readable font directory
//! still offers the built-in typefaces. The reader's own built-in choices are
//! seeded on the frontend (`BUNDLED_READER_FONTS` in `src/lib/readerFont.ts`);
//! this list is what keeps a scan that found nothing from looking broken.
//!
//! The scan is a blocking walk of possibly thousands of files, so the command
//! runs it on a background thread and the result is cached for the process
//! lifetime — installing a font while Papr is open needs a relaunch to appear,
//! which matches every native font picker.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Font families the webview always has, because they ship inside the bundle
/// through `@fontsource-variable` (see `src/main.tsx`) and are named in the
/// `--ui` / `--serif` / `--mono` stacks in `src/styles.css`. Adding a family
/// here that the stylesheet never declares would offer a row that renders in a
/// fallback font, so `bundled_families_are_declared` guards it.
const BUNDLED_FAMILIES: [&str; 3] = [
    "Newsreader Variable",
    "Inter Tight Variable",
    "JetBrains Mono Variable",
];

/// The directories each platform keeps its fonts in. Missing ones are ignored
/// by `load_fonts_dir`, whose walk is recursive — so macOS's `Supplemental`
/// subdirectory (Arial, Times New Roman, …) comes along with the rest.
fn font_dirs() -> Vec<PathBuf> {
    // Explicit element type: on a platform with no block below there is no
    // `push` for the compiler to infer it from.
    let mut dirs: Vec<PathBuf> = Vec::new();
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty());

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
        // Per-user installs ("Install for me only") live under %LOCALAPPDATA%;
        // Windows sets neither HOME nor XDG_DATA_HOME, so reading ~ would miss
        // every font the user installed themselves.
        if let Some(local) = std::env::var("LOCALAPPDATA").ok().filter(|p| !p.is_empty()) {
            dirs.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
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
        if let Some(xdg_data) = std::env::var("XDG_DATA_HOME")
            .ok()
            .filter(|d| !d.is_empty())
        {
            dirs.push(PathBuf::from(xdg_data).join("fonts"));
        }
    }

    dirs
}

/// Merge scanned host families with the bundled ones into the A–Z,
/// duplicate-free list the picker shows. Pure, so the ordering contract is
/// testable without touching the filesystem. Blank names are dropped: a face
/// with an empty name-table entry would otherwise become a blank row.
fn merge_families(host: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut families: BTreeSet<String> = BUNDLED_FAMILIES
        .iter()
        .map(|family| family.to_string())
        .collect();
    families.extend(host.into_iter().filter(|family| !family.is_empty()));
    families.into_iter().collect()
}

/// Read every readable font directory and collect the family names.
fn scan_host_families() -> Vec<String> {
    let mut db = fontdb::Database::new();
    for dir in font_dirs() {
        db.load_fonts_dir(dir);
    }

    // A face's first family entry is its primary (non-localized) name. Files
    // `fontdb` could not parse contribute no families, so they drop out here.
    db.faces()
        .filter_map(|face| face.families.first().map(|(name, _)| name.clone()))
        .collect()
}

/// Every distinct font family the host plus the app itself can render, A–Z —
/// never empty, because the bundled families are always merged in.
pub fn list_families() -> Vec<String> {
    static CACHE: OnceLock<Vec<String>> = OnceLock::new();
    // The clone is what the IPC layer needs anyway (it serialises an owned
    // payload); the walk itself happens once, for the process lifetime.
    CACHE
        .get_or_init(|| merge_families(scan_host_families()))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    /// The merge contract: bundled families always present, blank and duplicate
    /// names dropped, result A–Z. Exercised on a fixed host list so it does not
    /// depend on what the machine running the tests happens to have installed.
    #[test]
    fn merge_sorts_and_dedups_with_the_bundled_families() {
        let merged = merge_families(owned(&[
            "Zed",
            "Inter Tight Variable", // also bundled → must appear once
            "Alpha",
            "Alpha",
            "",
        ]));
        assert_eq!(
            merged,
            owned(&[
                "Alpha",
                "Inter Tight Variable",
                "JetBrains Mono Variable",
                "Newsreader Variable",
                "Zed",
            ])
        );
    }

    /// A host whose font directories are all unreadable still yields the
    /// bundled families, so the picker is never empty.
    #[test]
    fn merge_keeps_the_bundled_families_without_any_host_fonts() {
        assert_eq!(
            merge_families(Vec::new()),
            owned(&[
                "Inter Tight Variable",
                "JetBrains Mono Variable",
                "Newsreader Variable",
            ])
        );
    }

    #[test]
    fn scanned_families_include_the_bundled_ones() {
        let families = list_families();
        for bundled in BUNDLED_FAMILIES {
            assert!(families.contains(&bundled.to_string()), "missing {bundled}");
        }
    }

    #[test]
    fn scanned_families_are_strictly_sorted_and_unique() {
        let families = list_families();
        assert!(
            families.windows(2).all(|w| w[0] < w[1]),
            "not sorted/unique: {families:?}"
        );
    }

    /// Guard against the drift this list invites: every family offered as
    /// "always available" has to be one the webview's CSS actually declares,
    /// otherwise its row silently previews in a fallback typeface.
    #[test]
    fn bundled_families_are_declared_in_the_stylesheet() {
        let css = include_str!("../../src/styles.css");
        for family in BUNDLED_FAMILIES {
            assert!(
                css.contains(family),
                "src/styles.css never declares {family} — it is not bundled"
            );
        }
    }
}

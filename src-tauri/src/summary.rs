//! The AI-summary system prompt. The built-in text lives here as a *template* —
//! a template rather than a finished prompt because the response-language
//! directive is substituted in per call — and Settings → AI lets the user pick
//! one of several built-in presets or write a custom one (stored in the
//! `summary_prompt` setting, selected by `summary_preset`).

/// The placeholder in a template that receives the "respond in <language>"
/// directive. Kept as a literal token (not a Rust format capture) so a template
/// round-trips through the settings table unchanged.
const LANG_PLACEHOLDER: &str = "{lang}";

/// The preset id used when nothing is selected yet — also the template a fresh
/// custom prompt is seeded from.
pub const DEFAULT_PRESET: &str = "general";
/// The preset id meaning "use the user's own template" (`summary_prompt`).
pub const CUSTOM_PRESET: &str = "custom";

/// A selectable built-in summary template. `id` is the stable key stored in the
/// `summary_preset` setting; the frontend localizes the display name.
pub struct Preset {
    pub id: &'static str,
    pub template: String,
}

/// The built-in presets, in display order. Every one carries `{lang}` and the
/// structured markdown shape the reader renders.
pub fn presets() -> Vec<Preset> {
    vec![
        Preset {
            id: "general",
            template: general_prompt(),
        },
        Preset {
            id: "brief",
            template: brief_prompt(),
        },
        Preset {
            id: "deep",
            template: deep_prompt(),
        },
    ]
}

/// The default preset's template: decision-oriented, so a reader can tell at a
/// glance whether the article is worth their time. The lead sentence carries no
/// "TL;DR" label — it reads as a plain opening sentence.
pub fn general_prompt() -> String {
    concat!(
        "You are a sharp news editor. Summarize the article so a reader can ",
        "decide whether to read it in full.\n\n",
        "Format the response in markdown using exactly this shape:\n",
        "One sentence capturing the single most important point.\n\n",
        "- Key fact, finding, or claim (under ~20 words)\n",
        "- Another key point\n",
        "- 3 to 5 bullets total, one idea each, no nested bullets\n\n",
        "Output only this structure. No preamble, no closing remarks, no ",
        "section headers, no extra prose.{lang}",
    )
    .to_string()
}

/// One sentence only — for scanning a high-volume feed.
fn brief_prompt() -> String {
    concat!(
        "You are a sharp news editor. Summarize the article in one sentence of ",
        "at most 40 words, so a reader can decide whether to read it in full.\n\n",
        "Output only that sentence. No preamble, no bullets, no headers, no ",
        "markdown formatting.{lang}",
    )
    .to_string()
}

/// A longer structured briefing — for the few articles worth the attention.
/// Like the general preset, the lead sentence carries no "TL;DR" label.
fn deep_prompt() -> String {
    concat!(
        "You are a sharp news editor. Give the reader a structured briefing on ",
        "this article.\n\n",
        "Format the response in markdown using exactly this shape:\n",
        "One sentence capturing the single most important point.\n\n",
        "**Key points**\n",
        "- 3 to 5 key facts, findings, or claims (under ~20 words each)\n\n",
        "**Bottom line**\n",
        "- What the article concludes, and what it means for the reader\n\n",
        "**Who should read this**\n",
        "- One line on who would find this worth their time\n\n",
        "Output only this structure. No preamble, no closing remarks.{lang}",
    )
    .to_string()
}

/// The template text for `preset`: the user's own when Custom is selected and
/// non-blank, else the named preset. An unknown id falls back to the default
/// preset, so a stale value from an older build still resolves to something.
fn template_for(preset: &str, custom: &str) -> String {
    if preset == CUSTOM_PRESET && !custom.trim().is_empty() {
        return custom.to_string();
    }
    presets()
        .into_iter()
        .find(|p| p.id == preset)
        .map(|p| p.template)
        .unwrap_or_else(general_prompt)
}

/// Build the system prompt for one summary from the selected preset (or the
/// custom template), with the response-language directive substituted in.
pub fn system_prompt(preset: &str, custom: &str, lang_directive: &str) -> String {
    let prompt = template_for(preset, custom);
    if prompt.contains(LANG_PLACEHOLDER) {
        prompt.replace(LANG_PLACEHOLDER, lang_directive)
    } else {
        // A template that dropped the placeholder loses the language directive
        // entirely — the model would answer in whatever language the article
        // happens to be in. Append it rather than let that happen.
        format!("{prompt}{lang_directive}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LANG: &str = "\n\nAlways write your response in Simplified Chinese.";

    #[test]
    fn every_preset_carries_the_placeholder() {
        for p in presets() {
            assert!(
                p.template.contains("{lang}"),
                "preset {} has no placeholder",
                p.id
            );
        }
    }

    #[test]
    fn presets_are_listed_with_general_first() {
        let ids: Vec<_> = presets().iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["general", "brief", "deep"]);
        assert_eq!(DEFAULT_PRESET, "general");
    }

    #[test]
    fn general_prompt_asks_for_a_lead_sentence_and_bullets() {
        let p = system_prompt(DEFAULT_PRESET, "", LANG);
        // The lead sentence carries no "TL;DR" label — it reads as a plain
        // opening sentence.
        assert!(!p.contains("TL;DR"), "label not removed: {p}");
        assert!(
            p.contains("One sentence capturing the single most important point"),
            "no lead sentence: {p}"
        );
        assert!(p.contains("3 to 5 bullets"), "no bullet instruction: {p}");
        assert!(p.contains("markdown"), "no markdown mention: {p}");
    }

    #[test]
    fn lang_directive_is_substituted() {
        let p = system_prompt(DEFAULT_PRESET, "", LANG);
        assert!(p.ends_with(LANG), "directive missing: {p}");
        assert!(!p.contains("{lang}"), "placeholder left: {p}");
    }

    #[test]
    fn named_preset_is_selected() {
        let p = system_prompt("brief", "", LANG);
        assert!(p.contains("one sentence"), "not the brief prompt: {p}");
        let p = system_prompt("deep", "", LANG);
        assert!(p.contains("Who should read this"), "not the deep prompt: {p}");
        assert!(!p.contains("TL;DR"), "label not removed: {p}");
    }

    #[test]
    fn custom_template_is_used() {
        let p = system_prompt(CUSTOM_PRESET, "Summarize in one line.{lang}", LANG);
        assert_eq!(p, format!("Summarize in one line.{LANG}"));
    }

    #[test]
    fn blank_custom_falls_back_to_the_default_preset() {
        assert_eq!(
            system_prompt(CUSTOM_PRESET, "  \n ", LANG),
            system_prompt(DEFAULT_PRESET, "", LANG)
        );
    }

    #[test]
    fn unknown_preset_falls_back_to_the_default() {
        assert_eq!(
            system_prompt("no-such-preset", "", LANG),
            system_prompt(DEFAULT_PRESET, "", LANG)
        );
    }

    #[test]
    fn template_without_placeholder_still_gets_the_directive() {
        let p = system_prompt(CUSTOM_PRESET, "Summarize tersely.", LANG);
        assert!(p.starts_with("Summarize tersely."), "template not kept: {p}");
        assert!(p.ends_with(LANG), "directive missing: {p}");
    }
}

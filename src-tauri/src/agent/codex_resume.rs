use std::path::Path;

/// LatticeTerm has already selected and normalized the project's directory.
/// Passing it explicitly keeps Codex from reopening the saved session's old
/// directory (or asking about its Windows verbatim-path spelling).
pub(super) fn with_working_directory(mut arguments: Vec<String>, directory: &Path) -> Vec<String> {
    // Only adapt the managed resume recipe, not arbitrary Codex subcommands.
    if arguments.first().map(String::as_str) != Some("resume") {
        return arguments;
    }
    // Advanced arguments may deliberately override the project directory.
    // Anything after `--` is a positional value, never a directory option.
    if arguments
        .iter()
        .take_while(|argument| argument.as_str() != "--")
        .any(|argument| {
            argument == "--cd" || argument.starts_with("--cd=") || argument.starts_with("-C")
        })
    {
        return arguments;
    }
    arguments.splice(
        0..0,
        ["--cd".to_string(), directory.to_string_lossy().into_owned()],
    );
    arguments
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn pins_the_selected_directory_without_replacing_the_session_id() {
        let directory = Path::new(r"D:\projects\New Workspace");
        assert_eq!(
            with_working_directory(args(&["resume", "saved-session"]), directory),
            args(&[
                "--cd",
                r"D:\projects\New Workspace",
                "resume",
                "saved-session"
            ])
        );
    }

    #[test]
    fn scopes_resume_last_to_the_selected_project() {
        assert_eq!(
            with_working_directory(args(&["resume", "--last"]), Path::new("/work/project")),
            args(&["--cd", "/work/project", "resume", "--last"])
        );
    }

    #[test]
    fn keeps_unc_paths_in_a_single_argument() {
        let directory = Path::new(r"\\server\share\Project Name");
        assert_eq!(
            with_working_directory(args(&["resume", "--last"]), directory)[1],
            r"\\server\share\Project Name"
        );
    }

    #[test]
    fn preserves_explicit_directory_options() {
        for values in [
            vec!["resume", "--last", "--cd", "other"],
            vec!["resume", "--last", "--cd=other"],
            vec!["resume", "--last", "-C", "other"],
            vec!["resume", "--last", "-Cother"],
            vec!["resume", "--last", "-C=other"],
        ] {
            assert_eq!(
                with_working_directory(args(&values), Path::new("/work/project")),
                args(&values)
            );
        }
    }

    #[test]
    fn inserts_options_before_the_end_of_options_marker() {
        assert_eq!(
            with_working_directory(
                args(&["resume", "saved-session", "--", "--cd=prompt"]),
                Path::new("/work/project")
            ),
            args(&[
                "--cd",
                "/work/project",
                "resume",
                "saved-session",
                "--",
                "--cd=prompt"
            ])
        );
    }

    #[test]
    fn leaves_other_commands_and_user_defined_launches_unchanged() {
        for values in [
            vec![],
            vec!["exec", "resume", "saved-session"],
            vec!["--model", "custom", "resume"],
        ] {
            assert_eq!(
                with_working_directory(args(&values), Path::new("/work/project")),
                args(&values)
            );
        }
    }
}

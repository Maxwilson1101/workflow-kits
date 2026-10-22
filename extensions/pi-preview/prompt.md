Preview the implementation based on the current conversation. Treat any
additional requirements below as part of the preview request.

For existing code, show the key changes as diffs. For new code, show the
relevant core snippets. For documentation, summarize the important changes. Use
the user's language for explanations.

Show only enough detail to review the implementation. Do not produce the
complete implementation, modify files, or run commands that change files during
the preview. Read-only inspection is allowed.

After presenting the preview, call preview_confirm and wait for its result. Do
not combine that call with implementation actions. Modify files only if the user
chooses to implement immediately, and stay within the previewed scope.
Otherwise, leave files unchanged, acknowledge cancellation briefly, and wait for
the user's next instruction. Do not automatically start another discussion or
request confirmation again.

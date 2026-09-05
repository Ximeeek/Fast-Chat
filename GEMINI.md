# FastChat Room — Project Rules

## Language Policy for GitHub & Public Artifacts
- **All content exposed publicly or pushed to GitHub MUST be in English.**
  - Git commit messages (summary and body)
  - GitHub repository metadata (title, description, tags, releases)
  - Pull requests, issues, and discussions
  - Documentation files (all `README.md` files, architecture docs, guides)
  - Code comments, docstrings, API contracts, and user-facing UI copy (unless internationalization is explicitly implemented)

## Git & Commit Conventions
- Use Conventional Commits (`<type>[optional scope]: <description>`).
- Summary line must be concise, in the imperative mood, with no trailing period.
- The body is mandatory for all non-trivial commits, providing thorough explanation (~90% of commit message volume) of what changed, why, and any architectural considerations.

## Security & Secrets
- Never commit credentials, tokens, or environment files (`.env`).
- Maintain `.env.example` with empty placeholder values for required environment variables.

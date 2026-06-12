// Single source of truth for the public repo URL.
//
// NOTE (2026-06-12): the launch home is not yet decided — the personal GitHub
// account is suspended, so treetrace will be published under a NEW GitHub
// organization. Until that org exists, this is a placeholder. Change it here
// (or set TREETRACE_REPO_URL) and every export/doc reference updates.
export const REPO_URL =
  process.env.TREETRACE_REPO_URL || 'https://github.com/REPLACE-ME-ORG/treetrace';

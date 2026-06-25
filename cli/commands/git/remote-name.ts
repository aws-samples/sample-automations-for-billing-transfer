// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared remote-name derivation for the `bt git` command group.
 *
 * Both `bt git setup-remotes` (which creates the CodeCommit remotes) and
 * `bt git push` (which pushes to them) must agree on the remote name for a given
 * AWS profile, otherwise push would target a remote setup never created. To
 * guarantee that agreement (design Property 7 — "the name derived by the
 * git-remote-setup command equals the name derived by the git-push command for
 * the same profile"), both handlers import this single function rather than
 * re-implementing the derivation.
 *
 * The derivation is the deterministic, well-formed mapping required by
 * Req 14.2 / 15.2: lowercase the profile name, replace each run of one or more
 * non-alphanumeric characters with a single hyphen, and prefix the result with
 * `codecommit-`. "Alphanumeric" means ASCII `a-z` / `0-9`, matching the legacy
 * shell helper `profile_to_remote_name` (`tr -c 'a-z0-9' '-'`), so unicode and
 * symbol characters collapse to hyphens identically across both commands.
 *
 * Requirements: 14.2, 15.2
 *
 * @module git/remote-name
 */

/**
 * Derive the deterministic CodeCommit git remote name for an AWS profile.
 *
 * Equal inputs always yield equal outputs (pure, deterministic). The result is
 * `codecommit-` followed by the profile lowercased with every run of one or more
 * non-alphanumeric (non `[a-z0-9]`) characters replaced by a single `-`.
 *
 * @param profile - The AWS profile name to derive a remote name for.
 * @returns The derived remote name, e.g. `codecommit-payer-1`.
 */
export function deriveRemoteName(profile: string): string {
  const sanitized = profile.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `codecommit-${sanitized}`;
}

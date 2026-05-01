// Empty pnpmfile — present so pnpm computes a deterministic
// pnpmfileChecksum based on this file's contents, instead of falling back
// to whatever a CI environment may inject (which has caused
// ERR_PNPM_LOCKFILE_CONFIG_MISMATCH on Cloudflare Workers Builds and
// GitHub Actions when the host pnpm computes a different checksum than
// the one frozen in our lockfile).
module.exports = {};
